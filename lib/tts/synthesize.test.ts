/**
 * The orchestration is where the original bug lived: a whole script sent in one
 * call, silently rejected, leaving a transcript with no audio. These tests hold
 * the replacement to the properties that make that impossible — every call is
 * within the backend's limit, every turn appears on the timeline, and the
 * timeline is monotonic and consistent with the audio's real length.
 *
 * A stub backend stands in for real synthesis, so this runs with no audio
 * tooling, no API key, and in milliseconds.
 */
import { describe, it, expect } from "vitest";
import { synthesizeEpisode } from "./synthesize";
import { parseWav, buildWav, type WavFormat } from "./wav";
import type { Speaker, TTSProvider } from "./types";
import type { Episode } from "../llm/schema";

const FMT: WavFormat = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 22050,
  bitsPerSample: 16,
};

/** Produces audio whose duration is proportional to the text length. */
class StubTTS implements TTSProvider {
  readonly name = "stub";
  readonly description = "stub voices";
  readonly format = "wav" as const;
  calls: { text: string; speaker: Speaker }[] = [];

  constructor(readonly maxChars = 100) {}

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    this.calls.push({ text, speaker });
    // 10ms of audio per character keeps durations easy to reason about.
    const frames = Math.round((text.length * 10 * FMT.sampleRate) / 1000);
    return buildWav(FMT, Buffer.alloc(frames * 2));
  }
}

function episodeOf(texts: string[]): Episode {
  return {
    summary: "s",
    keyPoints: ["k"],
    turns: texts.map((text, i) => ({
      speaker: (i % 2 === 0 ? "host" : "guest") as Speaker,
      text,
    })),
  };
}

describe("synthesizeEpisode", () => {
  it("produces one timing per turn, in order", async () => {
    const provider = new StubTTS();
    const out = await synthesizeEpisode(episodeOf(["one", "two", "three"]), { provider });
    expect(out.timings).toHaveLength(3);
    expect(out.timings.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
    expect(out.timings.map((t) => t.speaker)).toEqual(["host", "guest", "host"]);
  });

  it("never sends a chunk longer than the backend accepts", async () => {
    // The original failure mode, now impossible by construction.
    const provider = new StubTTS(50);
    const longTurn = "This sentence is of a reasonable length. ".repeat(20);
    await synthesizeEpisode(episodeOf([longTurn, "short reply"]), { provider });
    expect(provider.calls.length).toBeGreaterThan(1);
    for (const c of provider.calls) {
      expect(c.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("splits a long turn across calls but keeps it a single turn on the timeline", async () => {
    const provider = new StubTTS(50);
    const longTurn = "Sentence one here. Sentence two here. Sentence three here. Four.";
    const out = await synthesizeEpisode(episodeOf([longTurn]), { provider });
    expect(provider.calls.length).toBeGreaterThan(1);
    expect(out.timings).toHaveLength(1);
    expect(out.timings[0]!.chunks).toBe(provider.calls.length);
  });

  it("routes each turn to its own speaker's voice", async () => {
    const provider = new StubTTS();
    await synthesizeEpisode(episodeOf(["a", "b", "c", "d"]), { provider });
    expect(provider.calls.map((c) => c.speaker)).toEqual([
      "host",
      "guest",
      "host",
      "guest",
    ]);
  });

  it("produces a monotonic, non-overlapping timeline", async () => {
    const provider = new StubTTS();
    const out = await synthesizeEpisode(episodeOf(["alpha", "bravo", "charlie"]), {
      provider,
    });
    for (let i = 0; i < out.timings.length; i++) {
      const t = out.timings[i]!;
      expect(t.endMs).toBeGreaterThan(t.startMs);
      if (i > 0) expect(t.startMs).toBeGreaterThanOrEqual(out.timings[i - 1]!.endMs);
    }
  });

  it("reports a total duration matching the audio it produced", async () => {
    const provider = new StubTTS();
    const out = await synthesizeEpisode(episodeOf(["alpha", "bravo"]), { provider });
    const actual = parseWav(out.audio).durationMs;
    expect(actual).toBeCloseTo(out.totalMs, 0);
    expect(out.timings[out.timings.length - 1]!.endMs).toBeCloseTo(out.totalMs, 0);
  });

  it("inserts silence between turns but not inside one", async () => {
    const provider = new StubTTS(50);
    const gapMs = 400;
    const split = "Sentence one here. Sentence two here. Sentence three here.";
    const out = await synthesizeEpisode(episodeOf([split, "reply"]), {
      provider,
      gapMs,
    });
    // The gap lands between turn 0 and turn 1, not between chunks of turn 0.
    const between = out.timings[1]!.startMs - out.timings[0]!.endMs;
    expect(between).toBeCloseTo(gapMs, 0);
  });

  it("omits gaps entirely when asked", async () => {
    const provider = new StubTTS();
    const out = await synthesizeEpisode(episodeOf(["a", "b"]), { provider, gapMs: 0 });
    expect(out.timings[1]!.startMs).toBeCloseTo(out.timings[0]!.endMs, 0);
  });

  it("counts synthesis calls, which the original code got wrong", async () => {
    const provider = new StubTTS(50);
    const out = await synthesizeEpisode(
      episodeOf(["Sentence one here. Sentence two here. Sentence three.", "b"]),
      { provider },
    );
    expect(out.calls).toBe(provider.calls.length);
    expect(out.calls).toBeGreaterThan(2);
  });

  it("reports progress once per turn", async () => {
    const provider = new StubTTS();
    const seen: number[] = [];
    await synthesizeEpisode(episodeOf(["a", "b", "c"]), {
      provider,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(3);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("refuses an episode with no dialogue rather than emitting an empty file", async () => {
    const provider = new StubTTS();
    await expect(
      synthesizeEpisode({ summary: "s", keyPoints: [], turns: [] }, { provider }),
    ).rejects.toThrow(/no dialogue/i);
  });

  it("carries the backend's identity through for reporting", async () => {
    const provider = new StubTTS();
    const out = await synthesizeEpisode(episodeOf(["a"]), { provider });
    expect(out.provider).toBe("stub");
    expect(out.voices).toBe("stub voices");
    expect(out.format).toBe("wav");
  });
});

describe("falling back to another backend", () => {
  /** Fails on the nth call, so a mid-episode failure can be provoked. */
  class FlakyTTS implements TTSProvider {
    readonly name = "flaky";
    readonly description = "flaky voice";
    readonly format = "wav" as const;
    readonly maxChars = 500;
    calls = 0;
    constructor(private readonly failOn: number) {}
    async synthesizeChunk(text: string): Promise<Buffer> {
      this.calls += 1;
      if (this.calls >= this.failOn) throw new Error("high demand");
      return buildWav(
        { audioFormat: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16 },
        Buffer.alloc(text.length * 2),
      );
    }
  }

  /** A local backend at a different sample rate, as Piper really is. */
  class LocalTTS implements TTSProvider {
    readonly name = "piper";
    readonly description = "local voice";
    readonly format = "wav" as const;
    readonly maxChars = 500;
    calls = 0;
    async synthesizeChunk(text: string): Promise<Buffer> {
      this.calls += 1;
      return buildWav(
        { audioFormat: 1, channels: 1, sampleRate: 22050, bitsPerSample: 16 },
        Buffer.alloc(text.length * 2),
      );
    }
  }

  const episode: Episode = {
    summary: "s",
    keyPoints: ["k"],
    turns: [
      { speaker: "host", text: "First turn." },
      { speaker: "guest", text: "Second turn." },
      { speaker: "host", text: "Third turn." },
    ],
  };

  it("remakes the whole episode rather than resuming", async () => {
    // Resuming would mix 24 kHz and 22.05 kHz segments, which joinWavs refuses
    // outright — a recoverable synthesis failure would become a hard crash one
    // stage later. It also swaps the voice mid-sentence.
    const primary = new FlakyTTS(3);
    const backup = new LocalTTS();

    const out = await synthesizeEpisode(episode, { provider: primary, fallback: backup });

    expect(backup.calls).toBe(3);
    expect(out.provider).toBe("piper");
    expect(out.audio.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("says which backend was asked for and why it changed", async () => {
    const out = await synthesizeEpisode(episode, {
      provider: new FlakyTTS(2),
      fallback: new LocalTTS(),
    });
    expect(out.fellBackFrom).toBe("flaky");
    expect(out.fallbackReason).toMatch(/high demand/);
    expect(out.voices).toBe("local voice");
  });

  it("tells the caller before it starts again", async () => {
    const seen: string[] = [];
    await synthesizeEpisode(episode, {
      provider: new FlakyTTS(2),
      fallback: new LocalTTS(),
      onFallback: (err, to) => seen.push(`${to.name}: ${err.message}`),
    });
    expect(seen).toEqual(["piper: high demand"]);
  });

  it("leaves a successful run untouched", async () => {
    const backup = new LocalTTS();
    const out = await synthesizeEpisode(episode, {
      provider: new FlakyTTS(99),
      fallback: backup,
    });
    expect(backup.calls).toBe(0);
    expect(out.fellBackFrom).toBeUndefined();
  });

  it("raises the original failure when there is nothing to fall back to", async () => {
    await expect(
      synthesizeEpisode(episode, { provider: new FlakyTTS(1) }),
    ).rejects.toThrow(/high demand/);
  });

  it("does not fall back onto the backend that just failed", async () => {
    // Retrying the same missing binary or the same busy endpoint is not a
    // backup, it is the same failure taking twice as long.
    const primary = new FlakyTTS(1);
    await expect(
      synthesizeEpisode(episode, { provider: primary, fallback: primary }),
    ).rejects.toThrow(/high demand/);
  });
});
