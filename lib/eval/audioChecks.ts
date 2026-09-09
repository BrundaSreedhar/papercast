/**
 * Deterministic checks on synthesized audio.
 *
 * Audio has one failure mode that matters and is easy to miss: text silently
 * going missing. A synthesis call that drops a chunk, truncates a sentence, or
 * returns an empty buffer still yields a file that plays perfectly. Nobody
 * re-reads the transcript against the waveform, so the loss is invisible — the
 * same shape of problem as a context window quietly discarding a paper.
 *
 * What is checked here is therefore integrity and plausibility, not aesthetics.
 * Whether the delivery sounds natural needs a human or a speech model; whether
 * a turn of fifty words produced two seconds of audio does not.
 */
import { parseWav, type ParsedWav } from "../tts/wav";
import type { EpisodeAudio, TurnTiming } from "../tts/types";
import type { Episode } from "../llm/schema";
import type { CheckResult, DeterministicReport } from "./types";

/** Plausible conversational range. Outside it, something went wrong. */
const MIN_WPM = 80;
const MAX_WPM = 260;
/** Amplitude below which a turn is treated as having produced nothing. */
const SILENCE_RMS = 30; // out of 32768 for 16-bit samples
/** Tolerance between the reported timeline and the file's real duration. */
const TIMELINE_TOLERANCE_MS = 50;

export interface AudioCheckContext {
  episode: Episode;
  audio: EpisodeAudio;
  /** Requested episode length, when known, to check the loop closed. */
  targetMinutes?: number;
}

function ok(id: string, label: string, severity: CheckResult["severity"]): CheckResult {
  return { id, label, passed: true, severity };
}

function fail(
  id: string,
  label: string,
  severity: CheckResult["severity"],
  detail: string,
): CheckResult {
  return { id, label, passed: false, severity, detail };
}

function words(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

/** Root-mean-square amplitude of a slice of 16-bit PCM. */
export function rmsOfRange(parsed: ParsedWav, startMs: number, endMs: number): number {
  const { format, data } = parsed;
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const startFrame = Math.max(0, Math.floor((startMs / 1000) * format.sampleRate));
  const endFrame = Math.min(
    Math.floor(data.length / bytesPerFrame),
    Math.ceil((endMs / 1000) * format.sampleRate),
  );
  const frames = endFrame - startFrame;
  if (frames <= 0 || format.bitsPerSample !== 16) return 0;

  let sum = 0;
  let counted = 0;
  // Sample sparsely on long turns; RMS does not need every frame.
  const step = Math.max(1, Math.floor(frames / 20_000));
  for (let f = startFrame; f < endFrame; f += step) {
    const sample = data.readInt16LE(f * bytesPerFrame);
    sum += sample * sample;
    counted++;
  }
  return counted ? Math.sqrt(sum / counted) : 0;
}

/* ── checks ────────────────────────────────────────────────────────────── */

export function checkAudioParses(ctx: AudioCheckContext): CheckResult {
  const id = "audio-parses";
  const label = "Audio is a readable file with real duration";
  try {
    const parsed = parseWav(ctx.audio.audio);
    if (parsed.durationMs <= 0) {
      return fail(id, label, "error", "Audio contains no samples.");
    }
    return ok(id, label, "error");
  } catch (err) {
    return fail(id, label, "error", err instanceof Error ? err.message : String(err));
  }
}

export function checkEveryTurnVoiced(ctx: AudioCheckContext): CheckResult {
  const id = "turns-voiced";
  const label = "Every dialogue turn has audio";
  const expected = ctx.episode.turns.length;
  const covered = new Set(ctx.audio.timings.map((t) => t.turnIndex));
  const missing = [...Array(expected).keys()].filter((i) => !covered.has(i));
  if (missing.length) {
    return fail(id, label, "error", `Turns with no audio: ${missing.join(", ")}.`);
  }
  const empty = ctx.audio.timings.filter((t) => t.endMs <= t.startMs);
  if (empty.length) {
    return fail(
      id,
      label,
      "error",
      `Turns with zero duration: ${empty.map((t) => t.turnIndex).join(", ")}.`,
    );
  }
  return ok(id, label, "error");
}

export function checkTimelineOrder(ctx: AudioCheckContext): CheckResult {
  const id = "timeline-order";
  const label = "Timeline is ordered and non-overlapping";
  const t = ctx.audio.timings;
  for (let i = 1; i < t.length; i++) {
    if (t[i]!.startMs < t[i - 1]!.endMs) {
      return fail(
        id,
        label,
        "error",
        `Turn ${t[i]!.turnIndex} starts at ${Math.round(t[i]!.startMs)}ms, before turn ${t[i - 1]!.turnIndex} ends at ${Math.round(t[i - 1]!.endMs)}ms.`,
      );
    }
  }
  return ok(id, label, "error");
}

/**
 * The reported timeline must match the file it describes. If these drift, a
 * player highlights the wrong line — and it is the kind of error that grows
 * steadily through an episode rather than announcing itself.
 */
export function checkTimelineMatchesAudio(ctx: AudioCheckContext): CheckResult {
  const id = "timeline-matches-audio";
  const label = "Timeline agrees with the audio's real length";
  let actualMs: number;
  try {
    actualMs = parseWav(ctx.audio.audio).durationMs;
  } catch {
    return fail(id, label, "error", "Audio could not be read to compare against.");
  }

  const drift = Math.abs(actualMs - ctx.audio.totalMs);
  if (drift > TIMELINE_TOLERANCE_MS) {
    return fail(
      id,
      label,
      "error",
      `Reported ${Math.round(ctx.audio.totalMs)}ms but the file is ${Math.round(actualMs)}ms (${Math.round(drift)}ms drift).`,
    );
  }

  const last = ctx.audio.timings[ctx.audio.timings.length - 1];
  if (last && last.endMs > actualMs + TIMELINE_TOLERANCE_MS) {
    return fail(
      id,
      label,
      "error",
      `Last turn ends at ${Math.round(last.endMs)}ms, past the end of a ${Math.round(actualMs)}ms file.`,
    );
  }
  return ok(id, label, "error");
}

/**
 * Speech rate is the cheap proxy for text having gone missing. A turn whose
 * audio is far too short for its word count did not say everything it was
 * given — which is invisible on playback and undetectable from the file alone.
 */
export function checkSpeechRate(ctx: AudioCheckContext): CheckResult {
  const id = "speech-rate";
  const label = "Spoken duration is plausible for the text";
  const offenders: string[] = [];

  for (const timing of ctx.audio.timings) {
    const turn = ctx.episode.turns[timing.turnIndex];
    if (!turn) continue;
    const n = words(turn.text);
    if (n < 5) continue; // too short to rate meaningfully
    const minutes = (timing.endMs - timing.startMs) / 60_000;
    if (minutes <= 0) continue;
    const wpm = n / minutes;
    if (wpm > MAX_WPM) {
      offenders.push(
        `turn ${timing.turnIndex}: ${Math.round(wpm)} wpm (text likely dropped)`,
      );
    } else if (wpm < MIN_WPM) {
      offenders.push(
        `turn ${timing.turnIndex}: ${Math.round(wpm)} wpm (unexpectedly slow)`,
      );
    }
  }

  return offenders.length === 0
    ? ok(id, label, "warning")
    : fail(id, label, "warning", offenders.slice(0, 5).join("; ") + ".");
}

/** A turn that produced only silence still occupies time on the timeline. */
export function checkNoSilentTurns(ctx: AudioCheckContext): CheckResult {
  const id = "silent-turns";
  const label = "No turn is silent";
  let parsed: ParsedWav;
  try {
    parsed = parseWav(ctx.audio.audio);
  } catch {
    return fail(id, label, "error", "Audio could not be read.");
  }

  const silent: number[] = [];
  for (const t of ctx.audio.timings) {
    const turn = ctx.episode.turns[t.turnIndex];
    if (!turn || words(turn.text) === 0) continue;
    if (rmsOfRange(parsed, t.startMs, t.endMs) < SILENCE_RMS) silent.push(t.turnIndex);
  }

  return silent.length === 0
    ? ok(id, label, "error")
    : fail(
        id,
        label,
        "error",
        `Turns with text but no audible speech: ${silent.slice(0, 8).join(", ")}.`,
      );
}

/**
 * Whether the episode actually lasts as long as it was asked to. This closes
 * the loop that the word-count target only half measures: a script can hit its
 * word budget and still produce a much shorter episode than requested.
 */
export function checkEpisodeDuration(ctx: AudioCheckContext): CheckResult {
  const id = "episode-duration";
  const label = "Episode length is near the requested target";
  if (!ctx.targetMinutes) return ok(id, label, "warning");

  const actualMin = ctx.audio.totalMs / 60_000;
  const ratio = actualMin / ctx.targetMinutes;
  if (ratio < 0.6 || ratio > 1.6) {
    return fail(
      id,
      label,
      "warning",
      `${actualMin.toFixed(1)} minutes against a ${ctx.targetMinutes}-minute target (${Math.round(ratio * 100)}%).`,
    );
  }
  return ok(id, label, "warning");
}

/* ── runner ────────────────────────────────────────────────────────────── */

export const ALL_AUDIO_CHECKS = [
  checkAudioParses,
  checkEveryTurnVoiced,
  checkTimelineOrder,
  checkTimelineMatchesAudio,
  checkNoSilentTurns,
  checkSpeechRate,
  checkEpisodeDuration,
];

export function runAudioChecks(ctx: AudioCheckContext): DeterministicReport {
  const checks = ALL_AUDIO_CHECKS.map((fn) => fn(ctx));
  const failed = checks.filter((c) => !c.passed);
  return {
    checks,
    errors: failed.filter((c) => c.severity === "error").length,
    warnings: failed.filter((c) => c.severity === "warning").length,
    complianceScore: checks.length ? (checks.length - failed.length) / checks.length : 1,
  };
}

export type { TurnTiming };
