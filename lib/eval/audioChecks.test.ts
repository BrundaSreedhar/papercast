/**
 * Audio checks, and their sensitivity measured by mutation.
 *
 * The control is synthetic — a tone standing in for speech — so this runs
 * anywhere with no audio tooling. What matters is that the checks separate a
 * coherent episode from ones where text has silently gone missing, which is the
 * failure real synthesis produces and playback never reveals.
 */
import { describe, it, expect } from "vitest";
import {
  checkEpisodeDuration,
  checkEveryTurnVoiced,
  checkNoSilentTurns,
  checkSpeechRate,
  checkTimelineMatchesAudio,
  checkTimelineOrder,
  rmsOfRange,
  runAudioChecks,
  type AudioCheckContext,
} from "./audioChecks";
import { applyAudioMutation, AUDIO_MUTATIONS } from "./mutateAudio";
import { buildWav, parseWav, type WavFormat } from "../tts/wav";
import type { EpisodeAudio } from "../tts/types";
import type { Episode } from "../llm/schema";

const FMT: WavFormat = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 22050,
  bitsPerSample: 16,
};
const WPM = 150;

/** A tone, so RMS is well above the silence floor like real speech. */
function tone(ms: number): Buffer {
  const frames = Math.round((ms / 1000) * FMT.sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), i * 2);
  }
  return data;
}

/** Build an episode plus matching audio at a realistic speaking rate. */
function fixture(turnWordCounts: number[], gapMs = 350) {
  const episode: Episode = {
    summary: "s",
    keyPoints: ["k"],
    turns: turnWordCounts.map((n, i) => ({
      speaker: (i % 2 === 0 ? "host" : "guest") as "host" | "guest",
      text: Array.from({ length: n }, (_, w) => `word${w}`).join(" "),
    })),
  };

  const pieces: Buffer[] = [];
  const timings: EpisodeAudio["timings"] = [];
  let cursor = 0;
  turnWordCounts.forEach((n, i) => {
    if (i > 0) {
      pieces.push(Buffer.alloc(Math.round((gapMs / 1000) * FMT.sampleRate) * 2));
      cursor += gapMs;
    }
    const ms = (n / WPM) * 60_000;
    pieces.push(tone(ms));
    timings.push({
      turnIndex: i,
      speaker: episode.turns[i]!.speaker,
      startMs: cursor,
      endMs: cursor + ms,
      chunks: 1,
    });
    cursor += ms;
  });

  const audio: EpisodeAudio = {
    audio: buildWav(FMT, Buffer.concat(pieces)),
    format: "wav",
    timings,
    totalMs: parseWav(buildWav(FMT, Buffer.concat(pieces))).durationMs,
    provider: "stub",
    voices: "stub",
    calls: turnWordCounts.length,
  };
  return { episode, audio };
}

function ctx(targetMinutes?: number): AudioCheckContext {
  const { episode, audio } = fixture([40, 55, 45, 60, 50, 42]);
  return { episode, audio, targetMinutes };
}

describe("the control audio is clean", () => {
  it("passes every check, so mutation failures are attributable", () => {
    const report = runAudioChecks(ctx());
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(report.complianceScore).toBe(1);
  });
});

describe("rmsOfRange", () => {
  it("distinguishes speech from silence", () => {
    const { audio } = fixture([40, 40]);
    const parsed = parseWav(audio.audio);
    const t = audio.timings[0]!;
    expect(rmsOfRange(parsed, t.startMs, t.endMs)).toBeGreaterThan(1000);

    const silent = parseWav(buildWav(FMT, Buffer.alloc(22050 * 2)));
    expect(rmsOfRange(silent, 0, 1000)).toBe(0);
  });
});

describe("checkSpeechRate", () => {
  it("accepts a realistic speaking rate", () => {
    expect(checkSpeechRate(ctx()).passed).toBe(true);
  });

  it("flags a turn whose audio is far too short for its text", () => {
    // The failure that matters: synthesis dropped most of the sentence, and the
    // file still plays cleanly.
    const { episode, audio } = fixture([40, 55]);
    audio.timings[0] = { ...audio.timings[0]!, endMs: audio.timings[0]!.startMs + 500 };
    const r = checkSpeechRate({ episode, audio });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("text likely dropped");
  });

  it("flags a turn that is implausibly slow", () => {
    const { episode, audio } = fixture([40, 55]);
    audio.timings[0] = {
      ...audio.timings[0]!,
      endMs: audio.timings[0]!.startMs + 120_000,
    };
    expect(checkSpeechRate({ episode, audio }).passed).toBe(false);
  });

  it("ignores turns too short to rate", () => {
    const { episode, audio } = fixture([2, 40]);
    expect(checkSpeechRate({ episode, audio }).passed).toBe(true);
  });
});

describe("checkNoSilentTurns", () => {
  it("catches a turn that has text but produced no sound", () => {
    const base = ctx();
    const mutated = applyAudioMutation(base.audio, "silence-turn");
    const r = checkNoSilentTurns({ ...base, audio: mutated });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no audible speech/);
  });
});

describe("checkTimelineMatchesAudio", () => {
  it("catches a timeline that runs past the end of the file", () => {
    const base = ctx();
    const mutated = applyAudioMutation(base.audio, "desync-timeline");
    expect(checkTimelineMatchesAudio({ ...base, audio: mutated }).passed).toBe(false);
  });

  it("catches audio truncated behind an unchanged timeline", () => {
    const base = ctx();
    const mutated = applyAudioMutation(base.audio, "truncate-audio");
    const r = checkTimelineMatchesAudio({ ...base, audio: mutated });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/drift/);
  });
});

describe("checkTimelineOrder and checkEveryTurnVoiced", () => {
  it("catches overlapping turns", () => {
    const base = ctx();
    const mutated = applyAudioMutation(base.audio, "overlap-turns");
    expect(checkTimelineOrder({ ...base, audio: mutated }).passed).toBe(false);
  });

  it("catches a turn missing from the timeline", () => {
    const base = ctx();
    const mutated = applyAudioMutation(base.audio, "drop-turn-timing");
    const r = checkEveryTurnVoiced({ ...base, audio: mutated });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no audio/);
  });
});

describe("checkEpisodeDuration", () => {
  it("passes when the episode lands near its target", () => {
    // ~292 words at 150 wpm is roughly two minutes.
    expect(checkEpisodeDuration(ctx(2)).passed).toBe(true);
  });

  it("flags an episode far shorter than requested", () => {
    expect(checkEpisodeDuration(ctx(10)).passed).toBe(false);
  });

  it("is skipped when no target was given", () => {
    expect(checkEpisodeDuration(ctx(undefined)).passed).toBe(true);
  });
});

describe("audio mutation detection rate", () => {
  for (const m of AUDIO_MUTATIONS) {
    it(`${m.kind} → ${m.expectedCheck} (${m.description})`, () => {
      const base = ctx();
      const mutated = applyAudioMutation(base.audio, m.kind);
      const failed = runAudioChecks({ ...base, audio: mutated })
        .checks.filter((c) => !c.passed)
        .map((c) => c.id);
      expect(failed).toContain(m.expectedCheck);
    });
  }

  it("catches every audio corruption", () => {
    const base = ctx();
    const missed = AUDIO_MUTATIONS.filter((m) => {
      const mutated = applyAudioMutation(base.audio, m.kind);
      return !runAudioChecks({ ...base, audio: mutated })
        .checks.filter((c) => !c.passed)
        .map((c) => c.id)
        .includes(m.expectedCheck);
    }).map((m) => m.kind);
    expect(missed, `missed ${missed.length}/${AUDIO_MUTATIONS.length}`).toEqual([]);
  });

  it("does not flag the expected checks on the clean control", () => {
    const cleanFailures = runAudioChecks(ctx())
      .checks.filter((c) => !c.passed)
      .map((c) => c.id);
    for (const m of AUDIO_MUTATIONS) {
      expect(cleanFailures).not.toContain(m.expectedCheck);
    }
  });

  it("never mutates the input audio in place", () => {
    const base = ctx();
    const before = Buffer.from(base.audio.audio);
    const timingsBefore = JSON.stringify(base.audio.timings);
    for (const m of AUDIO_MUTATIONS) applyAudioMutation(base.audio, m.kind);
    expect(base.audio.audio.equals(before)).toBe(true);
    expect(JSON.stringify(base.audio.timings)).toBe(timingsBefore);
  });
});
