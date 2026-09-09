import type { ProviderName } from "../config/env";
import { paperToText, type PaperStructure } from "../pdf/extract";
import { getProvider } from "./index";
import {
  EPISODE_SCHEMA_DESCRIPTION,
  EPISODE_SCHEMA_DESCRIPTION_ELI5,
  EPISODE_SCHEMA_DESCRIPTION_SOLO,
  EPISODE_SCHEMA_NAME,
  EpisodeSchema,
  type Episode,
} from "./schema";
import type { LLMProvider, Usage } from "./types";

/** Average speaking rate used to translate target minutes into a word budget. */
const WORDS_PER_MINUTE = 150;

export interface GenerateEpisodeOptions {
  /** Target spoken length of the dialogue, in minutes. Default 10. */
  minutes?: number;
  /** Inject a provider (for tests/overrides); defaults to env selection. */
  provider?: LLMProvider;
  /** Name of the show. Fixed here so the model cannot invent one. */
  showName?: string;
  /**
   * Two voices in conversation, or one voice talking to the listener. Defaults
   * to the dialogue, which is what the eval fixtures and audio voices assume.
   */
  format?: EpisodeFormat;
  /**
   * Cap on characters of paper text sent to the model. We rely on section-aware
   * extraction (references/appendix already stripped) rather than full chunking;
   * genuinely huge papers are truncated here and flagged. Default ~120k chars.
   */
  maxInputChars?: number;
}

export interface EpisodeResult {
  episode: Episode;
  provider: ProviderName;
  model: string;
  usage: Usage;
  retries: number;
  truncatedInput: boolean;
}

/** Generate a faithful two-host podcast episode from a structured paper. */
export async function generateEpisode(
  paper: PaperStructure,
  opts: GenerateEpisodeOptions = {},
): Promise<EpisodeResult> {
  const minutes = opts.minutes ?? 10;
  const showName = opts.showName ?? "PaperCast";
  const maxInputChars = opts.maxInputChars ?? 120_000;
  const format = opts.format ?? "dialogue";
  const provider = opts.provider ?? getProvider();

  const fullText = paperToText(paper);
  const truncatedInput = fullText.length > maxInputChars;
  const paperText = truncatedInput ? fullText.slice(0, maxInputChars) : fullText;

  const wordTarget = minutes * WORDS_PER_MINUTE;
  const system = buildSystemPrompt({
    minutes,
    wordTarget,
    showName,
    hasFigures: (paper.figures?.length ?? 0) > 0,
    format,
  });
  const user = buildUserContent(paperText, truncatedInput);

  const result = await provider.generateStructured({
    system,
    user,
    schema: EpisodeSchema,
    schemaName: EPISODE_SCHEMA_NAME,
    schemaDescription:
      format === "solo"
        ? EPISODE_SCHEMA_DESCRIPTION_SOLO
        : format === "eli5"
          ? EPISODE_SCHEMA_DESCRIPTION_ELI5
          : EPISODE_SCHEMA_DESCRIPTION,
    maxTokens: estimateOutputTokens(minutes, format),
    temperature: 0.6,
  });

  return {
    episode: result.data,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    retries: result.retries,
    truncatedInput,
  };
}

export type EpisodeFormat = "dialogue" | "solo" | "eli5";

/**
 * The faithfulness rules, which do not depend on how many voices the episode
 * has. Shared verbatim so a change to what counts as honest can never apply to
 * one format and not the other.
 */
export const FAITHFULNESS = `FAITHFULNESS — this is the top priority:
- Use ONLY information contained in the provided paper. Do not add outside facts, prior knowledge, comparisons, or citations that are not in the text.
- Never invent numbers, results, author names, dataset names, or references. If a detail isn't in the paper, don't state it.
- If the paper is ambiguous or silent on something, either omit it or say the paper does not specify — do not fill the gap with a guess.
- Prefer the paper's own framing and terminology; spell out each acronym the first time you use it.
- The source may end with a "Figures and tables" section describing what the paper's diagrams and tables show. Those descriptions were produced by a model reading the page, not quoted from the paper, so treat them as slightly weaker evidence: use them to explain how something is structured or what a result looked like, attribute them as what the figure shows, and do not state a number from a figure unless the description gives it explicitly.`;

const figuresLine = (hasFigures?: boolean) =>
  hasFigures
    ? "\n- The paper's figures have been described for you. Where a diagram or table makes something concrete — how components connect, what a measured trend looked like — draw on it, because a listener cannot see the page."
    : "";

export function buildSystemPrompt(args: {
  minutes: number;
  wordTarget: number;
  showName: string;
  hasFigures?: boolean;
  /** Two voices in conversation, or one voice talking to the listener. */
  format?: EpisodeFormat;
}): string {
  switch (args.format ?? "dialogue") {
    case "solo":
      return soloPrompt(args);
    case "eli5":
      return eli5Prompt(args);
    default:
      return dialoguePrompt(args);
  }
}

function dialoguePrompt(args: {
  minutes: number;
  wordTarget: number;
  showName: string;
  hasFigures?: boolean;
}): string {
  const { minutes, wordTarget, showName } = args;
  const targetTurns = targetTurnCount(minutes);
  return `You are an expert science communicator who turns a single academic paper into an engaging, accurate podcast episode.

${FAITHFULNESS}

FORMAT AND LENGTH — both requirements are mandatory:
- Produce a summary (problem, approach, key results, limitations), a list of concise key points, and the episode as a two-host dialogue.
- The dialogue must contain at least ${targetTurns} turns, strictly alternating between the host and the guest. A turn is one person speaking, typically two to four sentences — not a monologue.
- The dialogue must total roughly ${wordTarget} words (about ${minutes} minutes at ${WORDS_PER_MINUTE} words/minute). This is a real target, not an upper bound; a short episode is a failed one.
- The host guides the conversation and asks the questions a curious listener would ask. The guest has read the paper closely and answers them, one idea at a time.
- The host opens with a brief welcome and closes with a short wrap-up. No music, sound effects, or stage directions.
- Write spoken language: contractions, short sentences, no markdown, no bullet points inside the dialogue.
- Cover the paper's core contributions in proportion to their importance rather than padding.${figuresLine(args.hasFigures)}

SPEAKERS — the second thing you must not fabricate:
- The show is called "${showName}". Use exactly that name if the opening names the show, and never invent a different show name, episode number, or reference to a previous episode.
- The speakers have no names. Never invent one, never introduce either speaker by name, and never let them address each other by name. Write "thanks for walking us through that", never "thanks, Sam". The only proper nouns in the dialogue should come from the paper itself or be the show name.
- Neither speaker wrote the paper. Attribute the work to its authors — "the authors found", "the paper argues" — and never "we found", "our method", or "in our experiments".
- Give the speakers no credentials, degrees, honorifics, job titles, employers, or institutions, and never describe either as an expert in a field.
- Invent no sponsors, no listener questions, and no biographical detail of any kind.`;
}

/**
 * The solo format: one voice, explaining a paper to a listener.
 *
 * The structural section is the part a dialogue does not need. Two speakers get
 * their shape for free — a question implies an answer, and the back-and-forth
 * paces itself. One voice has no such scaffolding, and without an explicit arc
 * a monologue flattens into a list of findings read out in the order they
 * appeared in the paper. So the arc is stated as four named beats, and each one
 * is bounded by what the paper actually claims: an implication the paper does
 * not draw is exactly the kind of fluent invention this project exists to stop.
 */
function soloPrompt(args: {
  minutes: number;
  wordTarget: number;
  showName: string;
  hasFigures?: boolean;
}): string {
  const { minutes, wordTarget, showName } = args;
  const targetTurns = targetTurnCount(minutes, "solo");
  return `You are an expert science communicator turning a single academic paper into an engaging, accurate solo episode: one voice, speaking directly to the listener.

${FAITHFULNESS}

STRUCTURE — tell it as a story, in this order:
- THE WELCOME: two or three sentences before anything technical. Greet the listener warmly, say what paper this is and who wrote it, and give them a reason to care about the next few minutes. Speak to one person, not an audience. Warm does not mean padded, and it does not mean hyped: no "buckle up", no "dive"/"diving into", no "unpack", no throat-clearing about how fascinating the topic is. Do not call the work groundbreaking, revolutionary, or a paradigm shift unless the paper says so itself — describing a paper as important is a claim about it, and it is not yours to make.
- THE HOOK: then the real-world question or the surprising problem this paper takes on. Take it from the paper's own motivation, not from what you know about the field.
- THE CONTEXT: what earlier approaches could not do, or what gap the paper says existed — only as the paper describes it.
- THE CORE: what the researchers actually did and what they found, as a logical progression rather than a list of results. This is the longest part of the episode.
- THE IMPACT: what the paper says this changes, and what it names as limitations or future work. If the paper does not claim an implication, do not supply one.

FORMAT AND LENGTH — both requirements are mandatory:
- Produce a summary (problem, approach, key results, limitations), a list of concise key points, and the episode itself.
- The episode is one continuous monologue. Deliver it as at least ${targetTurns} turns where EVERY turn has the speaker "narrator" — each turn is one beat of the talk, typically three to six sentences. There is no second speaker, and no turn may use "host" or "guest".
- The turns are read back to back as uninterrupted speech, so each one must continue directly from the last. Never re-introduce the topic, re-greet the listener, or restate what was just said.
- The episode must total roughly ${wordTarget} words (about ${minutes} minutes at ${WORDS_PER_MINUTE} words/minute). This is a real target, not an upper bound; a short episode is a failed one.
- Explain jargon the moment you use it, with a one-line analogy where that earns its place. Never leave a technical term standing on its own.
- The voice is warm throughout, not only at the open: talk to the listener, use "you" where it is natural, and let curiosity show. Close by telling them what they now know, briefly, rather than stopping mid-thought.
- Write spoken language: contractions, short sentences, no markdown, no bullet points, no headings.
- Write NO stage directions, tone cues, or bracketed annotations of any kind — no [pause], no [emphasis], no [tone shifts]. This text is fed straight to a speech synthesizer, which reads such marks aloud as words. Carry the pacing in the sentences themselves.
- Cover the paper's core contributions in proportion to their importance rather than padding.${figuresLine(args.hasFigures)}

THE VOICE — the second thing you must not fabricate:
- The show is called "${showName}". Use exactly that name if the opening names the show, and never invent a different show name, episode number, or reference to a previous episode.
- The speaker has no name. Never invent one and never introduce yourself by name. The only proper nouns should come from the paper itself or be the show name.
- The speaker did not write the paper. Attribute the work to its authors — "the authors found", "the paper argues" — and never "we found", "our method", or "in our experiments".
- Give the speaker no credentials, degrees, honorifics, job title, employer, or institution, and never describe yourself as an expert in a field.
- Invent no sponsors, no listener questions, and no biographical detail of any kind.`;
}

/**
 * The explain-it-to-a-child format.
 *
 * The hard part is not simplicity, it is that simplicity and faithfulness pull
 * against each other. An analogy is by definition not in the paper, so a
 * transcript full of playgrounds and kitchens would read to the judge as an
 * episode making claims the paper never made — and the deterministic proper-noun
 * check would fail outright on a brand name like a toy brick.
 *
 * The resolution is grammatical rather than editorial. A comparison introduced
 * as a comparison ("it's a bit like...") is framing, which the judge already
 * excludes from the hallucination rate; the same comparison asserted flatly is a
 * false claim about the paper. So the prompt requires the marker, bans invented
 * proper nouns outright, and forbids rounding a real number into a different
 * one — the three ways being simple would otherwise become being wrong.
 *
 * The summary and key points stay plain and accurate. They are the record the
 * eval and the interface read; only the spoken episode is simplified.
 */
function eli5Prompt(args: {
  minutes: number;
  wordTarget: number;
  showName: string;
  hasFigures?: boolean;
}): string {
  const { minutes, wordTarget, showName } = args;
  const targetTurns = targetTurnCount(minutes, "eli5");
  return `You are a teacher who is brilliant at explaining hard ideas to young children. You are turning a single academic paper into a warm, simple spoken story that a curious child would enjoy and understand.

${FAITHFULNESS}

BEING SIMPLE WITHOUT BECOMING WRONG — read this twice:
- Every fact about the paper must come from the paper. The comparisons you invent to explain those facts are the ONLY thing in the episode allowed to come from outside it.
- Always mark a comparison as a comparison: "it's a bit like", "imagine", "sort of like when". Never state a comparison as though it were something the paper says or did.
- Build comparisons out of everyday things a small child knows: toys, food, pets, weather, playgrounds, tidying up, waiting in a queue. Use NO brand names, product names, company names, or names of real people that do not appear in the paper.
- If a number is hard, either keep the paper's real figure or drop the number and say "much faster" or "a whole lot more". Never round a real number into a different one, and never invent one for effect.

STRUCTURE — tell it as a story, in this order:
- THE BIG WONDER: open with a question about something the child already knows — an everyday object, a feeling, something that happens at home or at school.
- THE PROBLEM: what was hard, slow, or annoying before this work, exactly as the paper describes it.
- THE SIMPLE SOLUTION: what the researchers actually did, explained through one clear running comparison — a game, a playground, a kitchen. Keep the same comparison going rather than swapping metaphors every few sentences.
- WHY IT'S COOL: why this makes things better. Only what the paper actually claims; if it claims nothing, say what it made possible instead of promising the world.

FORMAT AND LENGTH — both requirements are mandatory:
- Produce a summary (problem, approach, key results, limitations) and a list of concise key points. These two stay plain, accurate and grown-up — they are the record. Only the spoken episode below is simplified.
- The episode is one continuous story. Deliver it as at least ${targetTurns} turns where EVERY turn has the speaker "narrator" — each turn is one beat of the story. There is no second speaker, and no turn may use "host" or "guest".
- The turns are read back to back as uninterrupted speech, so each must continue from the last. Never re-greet the listener or restart the story.
- The episode must total roughly ${wordTarget} words (about ${minutes} minutes at ${WORDS_PER_MINUTE} words/minute). This is a real target, not an upper bound.
- Short sentences. Warm, enthusiastic, gentle. Speak to one child, not to a room.
- Ban academic buzzwords and heavy vocabulary. If a technical term genuinely cannot be avoided, say it once, then immediately give the everyday comparison for it and use the simple words from then on.
- Write NO stage directions, tone cues, or bracketed annotations of any kind — no [smiles], no [whispers], no [makes a zooming sound]. This text is fed straight to a speech synthesizer, which reads such marks aloud as words. Carry the warmth in the words themselves.${figuresLine(args.hasFigures)}

THE VOICE — the second thing you must not fabricate:
- The show is called "${showName}". Use exactly that name if the opening names the show, and never invent a different show name, episode number, or reference to a previous episode.
- The speaker has no name. Never invent one and never introduce yourself by name. Apart from the show name, the only proper nouns should come from the paper itself.
- The speaker did not write the paper. Attribute the work to its authors — "the people who did this", "the paper says" — and never "we found", "our method", or "in our experiments".
- Give the speaker no credentials, degrees, honorifics, job title, employer, or institution, and never describe yourself as an expert or a teacher inside the episode.
- Invent no sponsors, no listener questions, and no biographical detail of any kind.`;
}

export function buildUserContent(paperText: string, truncated: boolean): string {
  const note = truncated
    ? "\n\n[Note: the paper text below was truncated to fit; base the episode only on what is present.]"
    : "";
  return `Here is the paper to adapt into a podcast episode.${note}\n\n${paperText}`;
}

/**
 * Minimum dialogue turns for a given length. Roughly 3–4 exchanges a minute
 * keeps the pacing conversational; without an explicit floor, models collapse
 * the episode into a few long monologues.
 */
export function targetTurnCount(
  minutes: number,
  format: EpisodeFormat = "dialogue",
): number {
  // A monologue beat runs three to six sentences where a dialogue turn runs two
  // to four, so the same minutes need fewer of them. Asking for the dialogue
  // count would chop the talk into fragments that read as stammering.
  // A child-facing beat is shorter than an adult monologue beat, which is itself
  // longer than a dialogue turn.
  const perMinute = format === "eli5" ? 2.5 : format === "solo" ? 2 : 3.5;
  const floor = format === "dialogue" ? 6 : 4;
  return Math.min(60, Math.max(floor, Math.round(minutes * perMinute)));
}

/**
 * Output token budget for the whole structured result.
 *
 * The earlier version counted only spoken words and badly under-budgeted: the
 * model emits JSON, so every turn also carries `{"speaker":…,"text":…}`
 * scaffolding and escaping, and capable models write far longer summaries and
 * key points than a flat allowance assumes. Running out mid-object truncates
 * the tool call and produces a broken result rather than a shorter one, so this
 * is deliberately generous — max_tokens is a ceiling, not a reservation, and
 * unused budget costs nothing.
 */
export function estimateOutputTokens(
  minutes: number,
  format: EpisodeFormat = "dialogue",
): number {
  const dialogueTokens = minutes * WORDS_PER_MINUTE * 1.5;
  const turnOverhead = targetTurnCount(minutes, format) * 20;
  const summaryAndKeyPoints = 1_200;
  const total = (dialogueTokens + turnOverhead + summaryAndKeyPoints) * 1.35;
  return Math.min(32_000, Math.max(4_000, Math.round(total)));
}
