/**
 * Asking for the rest of an episode that stopped early.
 *
 * Small local models under-run a length target routinely and silently. Measured
 * on `qwen2:7b-32k`, a five-minute solo came back as 277 words in six turns
 * against a 750-word, ten-turn target, and finished at 644 output tokens
 * against a 4,000-token ceiling — so nothing was truncated and no retry would
 * have helped. The model simply considered itself done. Regenerating from
 * scratch would spend the same money to roll the same dice; continuing spends
 * a fraction of it and keeps the material that was already good.
 *
 * Three things make a continuation safe to append rather than merge.
 *
 * Only turns come back. The summary and key points were written against the
 * whole paper and are already correct; asking for them again would invite a
 * second, different summary and a decision about which to keep.
 *
 * The speaker is dictated, not chosen. Strict host/guest alternation is an
 * error-level deterministic check, so a continuation that opened on the wrong
 * voice would trade a length failure for a structural one. For a monologue
 * every turn is `narrator` and the same rule reads trivially.
 *
 * And the model is told what it has already said, so the continuation reads as
 * the rest of one talk rather than a second, shorter episode stapled on. The
 * failure to design against here is not a bad sentence, it is a restart: the
 * listener hears a greeting, a summary of what was just covered, and a second
 * conclusion.
 */
import { z } from "zod";
import { FAITHFULNESS, NO_HYPE } from "./promptShared";
import {
  EpisodeSchema,
  type DialogueTurn,
  type Episode,
  type EpisodeFormat,
} from "./schema";
import { countWords, wordsPerMinuteFor } from "./length";
import type { LLMProvider, Usage } from "./types";
import { paperToText, type PaperStructure } from "../pdf/extract";

export const ContinuationSchema = z.object({
  turns: EpisodeSchema.shape.turns.describe(
    "Only the additional turns that continue the episode. Do not repeat any turn already written.",
  ),
});

export const CONTINUATION_SCHEMA_NAME = "continuation";

/** How much of the tail the model is shown to continue from. */
const TAIL_TURNS = 4;

/**
 * Turns of the existing episode, as the model needs to see them to carry on.
 *
 * Only the tail. The whole script would be the largest thing in the request for
 * no benefit — continuing needs the thread, not the transcript — and on a small
 * model the context spent on it is the context that made the episode short in
 * the first place.
 */
export function buildContinuationRequest(args: {
  episode: Episode;
  wordsWanted: number;
  turnsWanted: number;
  format: EpisodeFormat;
  nextSpeaker: DialogueTurn["speaker"];
}): string {
  const { episode, wordsWanted, turnsWanted, format, nextSpeaker } = args;
  const minutesWanted = wordsWanted / wordsPerMinuteFor(format);
  const tail = episode.turns.slice(-TAIL_TURNS);
  const shown = tail
    .map(
      (t, i) =>
        `[turn ${episode.turns.length - tail.length + i}] ${t.speaker}: ${t.text}`,
    )
    .join("\n\n");

  const voice =
    format === "dialogue"
      ? `The next turn must have the speaker "${nextSpeaker}", and the turns after it must keep alternating strictly between "host" and "guest".`
      : `Every turn you write must have the speaker "narrator". There is no second speaker.`;

  return `This episode stopped before it was finished. It is ${countWords(
    episode.turns.map((t) => t.text).join(" "),
  )} words long and needs to be about ${wordsWanted} words longer — roughly ${minutesWanted.toFixed(
    1,
  )} more minutes of speech, in about ${turnsWanted} more turns.

Here is how it ends so far:

${shown}

Write ONLY the turns that come next. ${voice}

- Continue directly from that last turn. Do not greet the listener, do not name the show, do not re-introduce the paper, and do not summarise what has already been said — the listener has just heard it.
- Cover what the episode has not reached yet. Look at what is still unsaid about the paper's method, its results, its limitations and what the authors say it changes, and take those in a sensible order.
- End the episode properly. The last turn you write is the last turn of the episode, so close it: tell the listener what they now know, briefly, rather than stopping mid-thought.
- This is a real length target, not an upper bound. Coming back short a second time is a failure.`;
}

/** Whose turn it is, given how the episode currently ends. */
export function nextSpeaker(
  episode: Episode,
  format: EpisodeFormat,
): DialogueTurn["speaker"] {
  if (format !== "dialogue") return "narrator";
  const last = episode.turns.at(-1)?.speaker;
  return last === "host" ? "guest" : "host";
}

export interface ContinueResult {
  turns: DialogueTurn[];
  usage: Usage;
}

/**
 * Ask for the turns that finish an episode.
 *
 * The paper travels as cacheable context in the same position it occupied when
 * the episode was written, so a provider that caches the prefix pays for it
 * once across both calls.
 */
export async function continueEpisode(
  paper: PaperStructure,
  episode: Episode,
  opts: {
    provider: LLMProvider;
    /** Spoken words still missing. */
    wordsWanted: number;
    /** Turns still missing, at least one. */
    turnsWanted: number;
    format?: EpisodeFormat;
    showName?: string;
    maxInputChars?: number;
  },
): Promise<ContinueResult> {
  const format = opts.format ?? "dialogue";
  const showName = opts.showName ?? "PaperCast";
  const fullText = paperToText(paper);
  const maxInputChars = opts.maxInputChars ?? 120_000;
  const paperText =
    fullText.length > maxInputChars ? fullText.slice(0, maxInputChars) : fullText;

  const result = await opts.provider.generateStructured({
    system: `You are continuing a podcast episode about an academic paper that stopped before it was finished. You write the remaining turns and nothing else.

${FAITHFULNESS}

THE VOICE — unchanged from the rest of the episode:
- The show is called "${showName}". Never invent a different show name, an episode number, or a reference to a previous episode.
- No speaker has a name, credentials, a job title, or an employer. Never invent one.
- The speakers did not write the paper. Attribute the work to its authors — "the authors found", "the paper argues" — and never "we found" or "our method".
- Invent no sponsors, no listener questions, and no biographical detail.
- ${NO_HYPE}
- Write spoken language: contractions, short sentences, no markdown, no headings, no bullet points.
- Write NO stage directions, tone cues, or bracketed annotations of any kind. This text is fed straight to a speech synthesizer, which reads such marks aloud as words.`,
    cacheableContext: `SOURCE PAPER\n\n${paperText}`,
    user: buildContinuationRequest({
      episode,
      wordsWanted: opts.wordsWanted,
      turnsWanted: opts.turnsWanted,
      format,
      nextSpeaker: nextSpeaker(episode, format),
    }),
    schema: ContinuationSchema,
    schemaName: CONTINUATION_SCHEMA_NAME,
    schemaDescription:
      "The remaining turns of a podcast episode, continuing directly from the turns already written.",
    // The shortfall in JSON, with the same scaffolding allowance the first call
    // makes, and a floor so a small ask still has room to land.
    maxTokens: Math.min(
      32_000,
      Math.max(2_000, Math.round(opts.wordsWanted * 1.5 * 1.35 + opts.turnsWanted * 20)),
    ),
    temperature: 0.6,
  });

  return { turns: result.data.turns, usage: result.usage };
}

/**
 * Append a continuation, dropping anything that would break the episode.
 *
 * A model asked to continue sometimes restarts anyway. A turn on the wrong
 * speaker is the mechanical version of that and is dropped outright; the rest
 * is left alone, because editing a model's prose to look continuous is how a
 * seam becomes invisible instead of absent.
 */
export function appendTurns(
  episode: Episode,
  turns: DialogueTurn[],
  format: EpisodeFormat,
): Episode {
  const kept: DialogueTurn[] = [];
  let expected = nextSpeaker(episode, format);

  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    if (format === "dialogue") {
      if (turn.speaker !== expected) continue;
      expected = expected === "host" ? "guest" : "host";
    } else if (turn.speaker !== "narrator") {
      continue;
    }
    kept.push(turn);
  }

  return { ...episode, turns: [...episode.turns, ...kept] };
}
