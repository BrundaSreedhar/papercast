import type { ProviderName } from "../config/env";
import { paperToText, type PaperStructure } from "../pdf/extract";
import { getProvider } from "./index";
import {
  EPISODE_SCHEMA_DESCRIPTION,
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
  });
  const user = buildUserContent(paperText, truncatedInput);

  const result = await provider.generateStructured({
    system,
    user,
    schema: EpisodeSchema,
    schemaName: EPISODE_SCHEMA_NAME,
    schemaDescription: EPISODE_SCHEMA_DESCRIPTION,
    maxTokens: estimateOutputTokens(minutes),
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

export function buildSystemPrompt(args: {
  minutes: number;
  wordTarget: number;
  showName: string;
  hasFigures?: boolean;
}): string {
  const { minutes, wordTarget, showName } = args;
  const targetTurns = targetTurnCount(minutes);
  return `You are an expert science communicator who turns a single academic paper into an engaging, accurate podcast episode.

FAITHFULNESS — this is the top priority:
- Use ONLY information contained in the provided paper. Do not add outside facts, prior knowledge, comparisons, or citations that are not in the text.
- Never invent numbers, results, author names, dataset names, or references. If a detail isn't in the paper, don't state it.
- If the paper is ambiguous or silent on something, either omit it or say the paper does not specify — do not fill the gap with a guess.
- Prefer the paper's own framing and terminology; spell out each acronym the first time you use it.
- The source may end with a "Figures and tables" section describing what the paper's diagrams and tables show. Those descriptions were produced by a model reading the page, not quoted from the paper, so treat them as slightly weaker evidence: use them to explain how something is structured or what a result looked like, attribute them as what the figure shows, and do not state a number from a figure unless the description gives it explicitly.

FORMAT AND LENGTH — both requirements are mandatory:
- Produce a summary (problem, approach, key results, limitations), a list of concise key points, and the episode as a two-host dialogue.
- The dialogue must contain at least ${targetTurns} turns, strictly alternating between the host and the guest. A turn is one person speaking, typically two to four sentences — not a monologue.
- The dialogue must total roughly ${wordTarget} words (about ${minutes} minutes at ${WORDS_PER_MINUTE} words/minute). This is a real target, not an upper bound; a short episode is a failed one.
- The host guides the conversation and asks the questions a curious listener would ask. The guest has read the paper closely and answers them, one idea at a time.
- The host opens with a brief welcome and closes with a short wrap-up. No music, sound effects, or stage directions.
- Write spoken language: contractions, short sentences, no markdown, no bullet points inside the dialogue.
- Cover the paper's core contributions in proportion to their importance rather than padding.${
    args.hasFigures
      ? "\n- The paper's figures have been described for you. Where a diagram or table makes something concrete — how components connect, what a measured trend looked like — draw on it, because a listener cannot see the page."
      : ""
  }

SPEAKERS — the second thing you must not fabricate:
- The show is called "${showName}". Use exactly that name if the opening names the show, and never invent a different show name, episode number, or reference to a previous episode.
- The speakers have no names. Never invent one, never introduce either speaker by name, and never let them address each other by name. Write "thanks for walking us through that", never "thanks, Sam". The only proper nouns in the dialogue should come from the paper itself or be the show name.
- Neither speaker wrote the paper. Attribute the work to its authors — "the authors found", "the paper argues" — and never "we found", "our method", or "in our experiments".
- Give the speakers no credentials, degrees, honorifics, job titles, employers, or institutions, and never describe either as an expert in a field.
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
export function targetTurnCount(minutes: number): number {
  return Math.min(60, Math.max(6, Math.round(minutes * 3.5)));
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
export function estimateOutputTokens(minutes: number): number {
  const dialogueTokens = minutes * WORDS_PER_MINUTE * 1.5;
  const turnOverhead = targetTurnCount(minutes) * 20;
  const summaryAndKeyPoints = 1_200;
  const total = (dialogueTokens + turnOverhead + summaryAndKeyPoints) * 1.35;
  return Math.min(32_000, Math.max(4_000, Math.round(total)));
}
