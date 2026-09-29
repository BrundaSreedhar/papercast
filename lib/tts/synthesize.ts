/**
 * Turning a dialogue into one audio file with a per-turn timeline.
 *
 * The original implementation passed the whole script to the synthesis endpoint
 * in a single call. Past the input limit the call failed, the error was caught
 * and discarded, and the response carried a transcript with `audioUrl: null` —
 * so the feature was missing precisely for the long episodes it existed for.
 *
 * Here, a turn is the unit of synthesis, chunked further when it exceeds the
 * backend's limit, and every chunk's duration is measured rather than estimated.
 * Exceeding the limit is now impossible by construction rather than caught.
 *
 * A backend that fails partway takes the *whole episode* with it and the
 * fallback starts again from turn one. Resuming on the other backend would be
 * cheaper and is wrong twice over: the two speak in different voices, so the
 * listener hears the presenter change mid-sentence, and they emit different
 * sample rates — Piper follows its voice model at 22,050 Hz where Gemini
 * returns 24,000 — which `joinWavs` refuses outright. Half-finished audio would
 * become a hard failure at the join, one stage later and much harder to read.
 * Redoing it locally costs seconds; Piper runs at about real time.
 */
import type { Episode } from "../llm/schema";
import { chunkForSynthesis } from "./chunk";
import { joinWavs } from "./wav";
import type { EpisodeAudio, TTSProvider, TurnTiming } from "./types";
import { capturePayloads, truncate, withSpan, withSpanFor } from "../trace/tracer";
import * as TA from "../trace/attributes";
import { metadata, tags } from "../trace/langsmith";

export interface SynthesizeOptions {
  provider: TTSProvider;
  /**
   * Remakes the whole episode if `provider` fails.
   *
   * For hosted voices, which can be busy or down in a way a local one cannot.
   * An episode has already cost model calls by the time synthesis starts, so
   * losing it to a preview endpoint under load is a bad trade.
   */
  fallback?: TTSProvider;
  /** Silence between turns, which stops speakers running into each other. */
  gapMs?: number;
  /** Called after each turn so a caller can show progress on a long episode. */
  onProgress?: (done: number, total: number) => void;
  /** Called when the primary has failed and the fallback is about to start. */
  onFallback?: (error: Error, to: TTSProvider) => void;
}

export async function synthesizeEpisode(
  episode: Episode,
  opts: SynthesizeOptions,
): Promise<EpisodeAudio> {
  const { provider, fallback, gapMs = 350, onProgress, onFallback } = opts;

  try {
    return await synthesizeWith(episode, provider, gapMs, onProgress);
  } catch (err) {
    // Falling back to the same backend would just fail twice as slowly.
    if (!fallback || fallback.name === provider.name) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    onFallback?.(error, fallback);
    const audio = await synthesizeWith(episode, fallback, gapMs, onProgress);
    // Recorded rather than hidden: an episode in a different voice from the one
    // that was asked for should say so.
    return { ...audio, fellBackFrom: provider.name, fallbackReason: error.message };
  }
}

function synthesizeWith(
  episode: Episode,
  provider: TTSProvider,
  gapMs: number,
  onProgress: SynthesizeOptions["onProgress"],
): Promise<EpisodeAudio> {
  return withSpanFor(
    `synthesize ${provider.name}`,
    {
      [TA.PAPERCAST_TTS_PROVIDER]: provider.name,
      [TA.PAPERCAST_VOICES]: provider.description,
      ...tags("tts", provider.name),
      ...metadata({ voices: provider.description }),
    },
    async (span) => {
      const out = await run();
      span.setAttribute(TA.PAPERCAST_TTS_CALLS, out.calls);
      span.setAttribute(TA.PAPERCAST_AUDIO_SECONDS, out.totalMs / 1000);
      return out;
    },
  );

  async function run(): Promise<EpisodeAudio> {
    if (episode.turns.length === 0) throw new Error("Episode has no dialogue turns.");

    // One entry per synthesis call, plus a record of which turn produced it.
    const buffers: Buffer[] = [];
    const owners: { turnIndex: number; speaker: TurnTiming["speaker"] }[] = [];

    for (const [turnIndex, turn] of episode.turns.entries()) {
      const chunks = chunkForSynthesis(turn.text, provider.maxChars);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        // A span per synthesis call, because a chunk is the unit that fails: a
        // backend rejects, times out or mangles one chunk, and knowing which turn
        // and which words is the whole of the diagnosis. The text itself rides
        // along only with payload capture on — it is the episode's content, and a
        // trace should not quietly become a copy of it.
        buffers.push(
          await withSpan(
            `speak turn ${turnIndex}`,
            {
              [TA.PAPERCAST_TURN_INDEX]: turnIndex,
              [TA.PAPERCAST_CHUNK_INDEX]: chunkIndex,
              [TA.PAPERCAST_CHUNK_CHARS]: chunk.length,
              [TA.PAPERCAST_SPEAKER]: turn.speaker,
              [TA.PAPERCAST_TTS_PROVIDER]: provider.name,
              ...(capturePayloads()
                ? { [TA.PAPERCAST_CHUNK_TEXT]: truncate(chunk) }
                : {}),
              ...tags("tts", provider.name, turn.speaker),
            },
            () => provider.synthesizeChunk(chunk, turn.speaker),
          ),
        );
        owners.push({ turnIndex, speaker: turn.speaker });
      }
      onProgress?.(turnIndex + 1, episode.turns.length);
    }

    // Gaps separate turns, not the chunks within one turn, so the join is done
    // without gaps and the spacing is applied per turn boundary below.
    const joined = joinWavs(buffers, 0);

    // Collapse chunk-level segments back up to turn-level timings.
    const timings: TurnTiming[] = [];
    joined.segments.forEach((seg, i) => {
      const owner = owners[i]!;
      const last = timings[timings.length - 1];
      if (last && last.turnIndex === owner.turnIndex) {
        last.endMs = seg.endMs;
        last.chunks += 1;
      } else {
        timings.push({
          turnIndex: owner.turnIndex,
          speaker: owner.speaker,
          startMs: seg.startMs,
          endMs: seg.endMs,
          chunks: 1,
        });
      }
    });

    if (gapMs <= 0) {
      return {
        audio: joined.wav,
        format: "wav",
        timings,
        totalMs: joined.totalMs,
        provider: provider.name,
        voices: provider.description,
        calls: buffers.length,
      };
    }

    // Re-join with silence at turn boundaries. Chunks belonging to one turn are
    // merged first so a gap never lands inside a sentence.
    const perTurn: Buffer[][] = [];
    owners.forEach((owner, i) => {
      const bucket = perTurn[owner.turnIndex] ?? (perTurn[owner.turnIndex] = []);
      bucket.push(buffers[i]!);
    });

    const turnBuffers = perTurn.map((bufs) => joinWavs(bufs, 0).wav);
    const spaced = joinWavs(turnBuffers, gapMs);

    const spacedTimings: TurnTiming[] = spaced.segments.map((seg, i) => ({
      turnIndex: i,
      speaker: episode.turns[i]!.speaker,
      startMs: seg.startMs,
      endMs: seg.endMs,
      chunks: perTurn[i]?.length ?? 1,
    }));

    return {
      audio: spaced.wav,
      format: "wav",
      timings: spacedTimings,
      totalMs: spaced.totalMs,
      provider: provider.name,
      voices: provider.description,
      calls: buffers.length,
    };
  }
}
