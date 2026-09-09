/**
 * Saying one piece of text aloud.
 *
 * `synthesizeEpisode` exists for an episode: many turns, two voices, per-turn
 * timings for a transcript to follow. Answering a question out loud needs none
 * of that — one speaker, one passage, no timeline — and threading a single
 * answer through the episode path would mean inventing a fake episode to hold
 * it.
 *
 * Chunking is still required. Every backend caps the text it will take in one
 * call, and an answer that runs past it fails rather than truncating, so the
 * text is split on sentence boundaries and the pieces joined back into one WAV.
 */
import { chunkForSynthesis } from "./chunk";
import { joinWavs } from "./wav";
import type { Speaker, TTSProvider } from "./types";

export interface SpokenText {
  audio: Buffer;
  format: "wav";
  totalMs: number;
  /** Synthesis calls made, which is what a backend bills for. */
  calls: number;
}

/** A beat between sentences, so an answer does not run together. */
const GAP_MS = 120;

export async function speak(
  text: string,
  provider: TTSProvider,
  speaker: Speaker = "narrator",
): Promise<SpokenText> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to say.");

  const chunks = chunkForSynthesis(trimmed, provider.maxChars);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    parts.push(await provider.synthesizeChunk(chunk, speaker));
  }

  const joined = joinWavs(parts, GAP_MS);
  return {
    audio: joined.wav,
    format: "wav",
    totalMs: joined.totalMs,
    calls: chunks.length,
  };
}
