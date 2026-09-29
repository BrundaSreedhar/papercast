/**
 * How low a stretch of speech sits in pitch — enough to tell one voice from
 * another, without a model.
 *
 * Written for one failure: a single-narrator episode voiced by Gemini, where
 * every turn is a separate generation and the "same" named voice came back as
 * a noticeably different man from one turn to the next. Nothing downstream
 * could see it — every turn was voiced, timed and audible — and a listener
 * heard two people in a format whose whole promise is one.
 *
 * The measure is the pitch *floor*, the 10th percentile of a turn's pitch,
 * rather than its median. A voice's median moves with intonation: an excited
 * question lifts it, and a stable Piper host swung 16% on one turn. Its floor
 * barely moves, because it is set by the speaker, not the sentence. Measured on
 * the library's five recordings: every Piper voice kept its floor within 10% of
 * its own median across turns, including an animated children's narrator; the
 * Gemini narrator's moved 22%.
 *
 * Pitch is found by autocorrelation on 40 ms frames at the file's own rate.
 * Decimating to 8 kHz was tried and ran three times faster, but blunted the
 * separation to 20% against 10%; at full rate an episode still takes well under
 * a second. Frames that are quiet or not clearly periodic are skipped.
 */
import type { ParsedWav } from "../tts/wav";

/** Voice pitch range searched, in Hz: below a bass, above a child. */
const MIN_HZ = 60;
const MAX_HZ = 400;
/** Analysis rate: at or above every backend's output, so nothing is decimated. */
const TARGET_RATE = 24000;
/** Frames below this RMS (of full scale) are pauses, not speech. */
const VOICED_RMS = 0.02;
/** Normalized autocorrelation a frame needs to count as periodic. */
const VOICED_PEAK = 0.5;
/** Frames analysed per turn at most; spread evenly across it. */
const MAX_FRAMES = 200;
/** Fewer voiced frames than this and the floor is not worth trusting. */
const MIN_VOICED = 20;

/** The turn's samples, mono, decimated, as floats in [-1, 1]. */
function samples(
  parsed: ParsedWav,
  startMs: number,
  endMs: number,
): { x: Float32Array; rate: number } {
  const { format, data } = parsed;
  const channels = format.channels;
  const frameBytes = 2 * channels;
  const total = Math.floor(data.length / frameBytes);
  const start = Math.max(0, Math.floor((startMs / 1000) * format.sampleRate));
  const end = Math.min(total, Math.ceil((endMs / 1000) * format.sampleRate));
  const k = Math.max(1, Math.round(format.sampleRate / TARGET_RATE));
  const n = Math.max(0, Math.floor((end - start) / k));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < k; j++) {
      const frame = start + i * k + j;
      for (let c = 0; c < channels; c++)
        sum += data.readInt16LE(frame * frameBytes + c * 2);
    }
    x[i] = sum / (k * channels * 32768);
  }
  return { x, rate: format.sampleRate / k };
}

/** Pitch of one frame in Hz, or undefined when it is not voiced speech. */
function framePitch(f: Float32Array, rate: number): number | undefined {
  let mean = 0;
  for (const v of f) mean += v;
  mean /= f.length;
  let r0 = 0;
  for (let i = 0; i < f.length; i++) {
    f[i]! -= mean;
    r0 += f[i]! * f[i]!;
  }
  if (Math.sqrt(r0 / f.length) < VOICED_RMS || r0 === 0) return undefined;

  const lagMin = Math.floor(rate / MAX_HZ);
  const lagMax = Math.min(f.length - 1, Math.ceil(rate / MIN_HZ));
  let best = 0;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    for (let i = 0; i + lag < f.length; i++) r += f[i]! * f[i + lag]!;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  if (!bestLag || best / r0 < VOICED_PEAK) return undefined;
  return rate / bestLag;
}

/**
 * The 10th-percentile pitch of a stretch of speech, in Hz.
 *
 * Undefined when the stretch has too little voiced speech to say, or the audio
 * is not 16-bit PCM.
 */
export function pitchFloorHz(
  parsed: ParsedWav,
  startMs: number,
  endMs: number,
): number | undefined {
  if (parsed.format.bitsPerSample !== 16) return undefined;
  const { x, rate } = samples(parsed, startMs, endMs);
  const win = Math.round(0.04 * rate);
  const hop = Math.round(0.02 * rate);
  if (x.length < win) return undefined;

  const starts: number[] = [];
  for (let i = 0; i + win <= x.length; i += hop) starts.push(i);
  const step = Math.max(1, starts.length / MAX_FRAMES);

  const pitches: number[] = [];
  for (let s = 0; s < starts.length; s += step) {
    const at = starts[Math.floor(s)]!;
    const p = framePitch(x.slice(at, at + win), rate);
    if (p !== undefined) pitches.push(p);
  }
  if (pitches.length < MIN_VOICED) return undefined;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length * 0.1)];
}
