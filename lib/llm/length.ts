/**
 * How long an episode was asked to be, and how long it actually came out.
 *
 * These numbers were spread across two files and duplicated between them: the
 * writer turned minutes into a word budget, and the eval harness re-declared
 * the same 150 words a minute to grade the result. A generator and a grader
 * that disagree about the target is a bug waiting to be written, so the target
 * lives here once and both read it.
 *
 * The measuring half exists because nothing in the production path used to do
 * it. `checkWordCount` has always been able to catch a collapsed episode, but
 * it lives in `lib/eval/`, which an ordinary run never touches — so a five
 * minute request that came back as 277 words reached a listener with nothing
 * anywhere saying so. Measurement belongs to the pipeline that produced the
 * thing; the harness may read it, which is the direction dependencies are
 * allowed to point.
 */
import type { Episode, EpisodeFormat } from "./schema";

/**
 * Characters of speech per minute.
 *
 * Words per minute was the obvious unit and it is the wrong one. Measured
 * across six finished episodes, words per minute ranged from 149 to 204 — a
 * 37% spread — because register drives word length: an ELI5 episode uses short
 * words and gets through 200 of them a minute where a solo episode manages 150.
 * Over the same six episodes characters per minute ranged from 1,070 to 1,140,
 * a 6% spread, and did not care about format.
 *
 * So length is budgeted and judged in characters. This is what makes a
 * four-minute ELI5 request actually produce four minutes: asking for 600 words
 * gave 424 of them and 2.2 minutes of audio, because nothing in the chain knew
 * that those words are shorter.
 */
export const CHARS_PER_MINUTE = 1_100;

/**
 * Characters per word, by format — the bridge from a duration budget to
 * something a model can aim at.
 *
 * The prompt asks for a word count because models hit word counts and ignore
 * character counts, so the target has to be converted back. Measured on the
 * same episodes: 5.6 for ELI5, around 7.0 for solo and dialogue.
 */
const CHARS_PER_WORD: Record<EpisodeFormat, number> = {
  dialogue: 6.8,
  solo: 7.0,
  eli5: 5.6,
};

/**
 * Speaking rate implied for a format, kept only for prompts that quote it.
 */
export function wordsPerMinuteFor(format: EpisodeFormat = "dialogue"): number {
  return Math.round(CHARS_PER_MINUTE / CHARS_PER_WORD[format]);
}

/**
 * The fraction of the requested duration below which an episode is collapsed.
 *
 * This is the eval harness's failure line — an episode under it is broken, not
 * merely short. Repair triggers earlier; see `CONTINUE_BELOW`.
 */
export const MIN_LENGTH_RATIO = 0.7;

/**
 * The fraction below which it is worth spending a call to finish the episode.
 *
 * Deliberately stricter than the failure line. Reusing 0.7 for both meant a
 * four-minute request could deliver 2.9 minutes and be waved through as
 * acceptable, which is not what anyone asking for four minutes means. Not 1.0,
 * because a model that lands within a sixth of the target has done the job and
 * a second call to add twenty seconds costs more than the gap is worth.
 */
export const CONTINUE_BELOW = 0.85;

/** Characters of speech that fill the requested minutes. */
export function charTargetFor(minutes: number): number {
  return Math.round(minutes * CHARS_PER_MINUTE);
}

/** The same budget as a word count, which is what a prompt can ask for. */
export function wordTargetFor(
  minutes: number,
  format: EpisodeFormat = "dialogue",
): number {
  return Math.round(charTargetFor(minutes) / CHARS_PER_WORD[format]);
}

/** Characters actually spoken, which is what the audio length follows from. */
export function spokenCharCount(episode: Pick<Episode, "turns">): number {
  return episode.turns.map((t) => t.text.trim()).join(" ").length;
}

export function countWords(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

/** Words actually spoken, which is what the audio length follows from. */
export function spokenWordCount(episode: Pick<Episode, "turns">): number {
  return countWords(episode.turns.map((t) => t.text).join(" "));
}

/**
 * Minimum turns for a given length. Roughly 3–4 exchanges a minute keeps the
 * pacing conversational; without an explicit floor, models collapse the episode
 * into a few long monologues.
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
  const dialogueTokens = wordTargetFor(minutes, format) * 1.5;
  const turnOverhead = targetTurnCount(minutes, format) * 20;
  const summaryAndKeyPoints = 1_200;
  const total = (dialogueTokens + turnOverhead + summaryAndKeyPoints) * 1.35;
  return Math.min(32_000, Math.max(4_000, Math.round(total)));
}

/** What was asked for against what arrived. */
export interface LengthReport {
  words: number;
  wordTarget: number;
  /** Characters of speech, the unit duration actually follows. */
  chars: number;
  charTarget: number;
  turns: number;
  turnTarget: number;
  /** Predicted duration as a fraction of the duration requested. */
  ratio: number;
  /** Minutes of audio this much speech implies. */
  estimatedMinutes: number;
  /** Short enough to be worth spending a call on. */
  short: boolean;
  /** Short enough that the eval harness calls the episode collapsed. */
  collapsed: boolean;
}

export function measureLength(
  episode: Pick<Episode, "turns">,
  minutes: number,
  format: EpisodeFormat = "dialogue",
): LengthReport {
  const chars = spokenCharCount(episode);
  const charTarget = charTargetFor(minutes);
  const estimatedMinutes = chars / CHARS_PER_MINUTE;
  const ratio = minutes === 0 ? 1 : estimatedMinutes / minutes;
  return {
    words: spokenWordCount(episode),
    wordTarget: wordTargetFor(minutes, format),
    chars,
    charTarget,
    turns: episode.turns.length,
    turnTarget: targetTurnCount(minutes, format),
    ratio,
    estimatedMinutes,
    // Turn count alone does not make an episode short: a model that writes the
    // whole target in six long beats has delivered the audio that was asked
    // for, and splitting it further is an editorial preference, not a fix.
    short: ratio < CONTINUE_BELOW,
    collapsed: ratio < MIN_LENGTH_RATIO,
  };
}

/** One line a person can act on, or undefined when the length was fine. */
export function describeShortfall(report: LengthReport): string | undefined {
  if (!report.short) return undefined;
  return (
    `${report.words} words (~${report.estimatedMinutes.toFixed(1)} min) ` +
    `against a ${report.wordTarget}-word target (${Math.round(report.ratio * 100)}%)`
  );
}
