/**
 * Comparing what the audio says against what the script said.
 *
 * The `speech-rate` check infers text loss from a turn being too short for its
 * word count. This measures it: transcribe the episode, then ask how much of
 * each turn's wording actually survived synthesis.
 *
 * Matching is done on bags of normalized words rather than by aligning the
 * transcript to the script. Alignment is the more precise instrument and a much
 * larger one, and it is not needed for the question being asked — a turn whose
 * words are largely absent from the transcript was not spoken, whatever order
 * the recognizer heard things in.
 *
 * Recognition is imperfect, so the thresholds are forgiving by design. The
 * signal being sought is a turn that mostly vanished, not one where a
 * recognizer misheard a word.
 */
import type { Episode } from "../llm/schema";
import type { CheckResult } from "./types";

/** Below this share of a turn's words, treat the turn as not spoken. */
const TURN_RECALL_FLOOR = 0.6;
/** Below this overall, something is wrong with the episode as a whole. */
const EPISODE_RECALL_FLOOR = 0.85;
/** Turns shorter than this are too small to score reliably. */
const MIN_WORDS_TO_SCORE = 8;
/**
 * Longest clip handed to the recognizer in one go.
 *
 * Whisper processes audio in thirty-second windows, and a clip that crosses
 * that boundary loses its middle: a 31-second turn came back as its first
 * sentence and its last three words, while the same audio split in half
 * transcribed perfectly. Staying comfortably inside the window keeps the
 * measurement about the audio rather than about the recognizer.
 */
const MAX_CLIP_MS = 20_000;

/** Lowercase, strip punctuation, drop empties. Numbers are left as written. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Counts of each word, so repeated words must appear repeatedly to match. */
function bag(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/**
 * Share of `expected` words present in `actual`, counting multiplicity. A word
 * said twice in the script but once in the audio counts as half present.
 */
export function wordRecall(expected: string, actual: string): number {
  const want = normalizeWords(expected);
  if (want.length === 0) return 1;
  const have = bag(normalizeWords(actual));
  let found = 0;
  for (const w of want) {
    const n = have.get(w) ?? 0;
    if (n > 0) {
      found++;
      have.set(w, n - 1);
    }
  }
  return found / want.length;
}

export interface TurnFidelity {
  turnIndex: number;
  recall: number;
  words: number;
  /** Words from the script absent from the transcript, for inspection. */
  missing: string[];
}

export interface FidelityReport {
  /** Recall over the whole episode's wording. */
  episodeRecall: number;
  turns: TurnFidelity[];
  /** Turns whose wording largely failed to appear in the audio. */
  suspect: TurnFidelity[];
  transcriptWords: number;
  scriptWords: number;
}

export function scoreTranscriptFidelity(
  episode: Episode,
  transcript: string,
): FidelityReport {
  const script = episode.turns.map((t) => t.text).join(" ");
  const transcriptBagSource = normalizeWords(transcript);

  const turns: TurnFidelity[] = episode.turns.map((turn, turnIndex) => {
    const want = normalizeWords(turn.text);
    const have = bag(transcriptBagSource);
    const missing: string[] = [];
    let found = 0;
    for (const w of want) {
      const n = have.get(w) ?? 0;
      if (n > 0) {
        found++;
        have.set(w, n - 1);
      } else if (missing.length < 12) {
        missing.push(w);
      }
    }
    return {
      turnIndex,
      recall: want.length ? found / want.length : 1,
      words: want.length,
      missing,
    };
  });

  const suspect = turns.filter(
    (t) => t.words >= MIN_WORDS_TO_SCORE && t.recall < TURN_RECALL_FLOOR,
  );

  return {
    episodeRecall: wordRecall(script, transcript),
    turns,
    suspect,
    transcriptWords: transcriptBagSource.length,
    scriptWords: normalizeWords(script).length,
  };
}

/** Express the report as a check, so it joins the existing audio results. */
export function fidelityCheck(report: FidelityReport): CheckResult {
  const id = "transcript-fidelity";
  const label = "Audio says what the script said";

  if (report.suspect.length > 0) {
    const worst = report.suspect
      .slice(0, 4)
      .map((t) => `turn ${t.turnIndex} at ${Math.round(t.recall * 100)}%`)
      .join(", ");
    return {
      id,
      label,
      passed: false,
      severity: "error",
      detail: `Turns largely absent from the audio: ${worst}.`,
    };
  }

  if (report.episodeRecall < EPISODE_RECALL_FLOOR) {
    return {
      id,
      label,
      passed: false,
      severity: "warning",
      detail: `Only ${Math.round(report.episodeRecall * 100)}% of the script's wording was recognized in the audio.`,
    };
  }

  return { id, label, passed: true, severity: "error" };
}

/* ── per-turn verification ─────────────────────────────────────────────── */

/**
 * Transcribe each turn separately and score it against its own script line.
 *
 * Transcribing the whole episode in one pass looks cheaper and is not
 * trustworthy: on a five-minute recording a recognizer skips material, and the
 * resulting recall understates fidelity badly enough to raise false alarms —
 * measured at 61% on audio that was subsequently shown, clip by clip, to be
 * word-perfect. On short clips the same recognizer is accurate, so the per-turn
 * timings produced during synthesis are what make this check believable.
 */
export async function verifyPerTurn(
  episode: Episode,
  audio: {
    audio: Buffer;
    timings: { turnIndex: number; startMs: number; endMs: number }[];
  },
  asr: { transcribe(wav: Buffer): Promise<string> },
  slice: (wav: Buffer, startMs: number, endMs: number) => Buffer,
  onProgress?: (done: number, total: number) => void,
): Promise<FidelityReport> {
  const turns: TurnFidelity[] = [];
  let totalTranscriptWords = 0;

  for (const [i, timing] of audio.timings.entries()) {
    const turn = episode.turns[timing.turnIndex];
    if (!turn) continue;
    // Long turns are recognized in pieces and the text rejoined.
    const heardParts: string[] = [];
    for (let from = timing.startMs; from < timing.endMs; from += MAX_CLIP_MS) {
      const to = Math.min(from + MAX_CLIP_MS, timing.endMs);
      heardParts.push(await asr.transcribe(slice(audio.audio, from, to)));
    }
    const heard = heardParts.join(" ");
    totalTranscriptWords += normalizeWords(heard).length;

    const want = normalizeWords(turn.text);
    const have = bag(normalizeWords(heard));
    const missing: string[] = [];
    let found = 0;
    for (const w of want) {
      const n = have.get(w) ?? 0;
      if (n > 0) {
        found++;
        have.set(w, n - 1);
      } else if (missing.length < 12) {
        missing.push(w);
      }
    }
    turns.push({
      turnIndex: timing.turnIndex,
      recall: want.length ? found / want.length : 1,
      words: want.length,
      missing,
    });
    onProgress?.(i + 1, audio.timings.length);
  }

  const scriptWords = turns.reduce((n, t) => n + t.words, 0);
  const recalled = turns.reduce((n, t) => n + t.recall * t.words, 0);

  return {
    episodeRecall: scriptWords ? recalled / scriptWords : 1,
    turns,
    suspect: turns.filter(
      (t) => t.words >= MIN_WORDS_TO_SCORE && t.recall < TURN_RECALL_FLOOR,
    ),
    transcriptWords: totalTranscriptWords,
    scriptWords,
  };
}
