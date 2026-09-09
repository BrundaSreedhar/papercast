/**
 * Saying one answer aloud. The case that matters is the long one: every backend
 * caps the text it takes in a single call, and an answer past that cap fails
 * outright rather than coming back shortened.
 */
import { describe, it, expect } from "vitest";
import { answerVoiceFor, speak } from "./speak";
import { buildWav } from "./wav";
import type { Speaker, TTSProvider } from "./types";

/** Emits a real, parseable WAV so the joining under test is the real joining. */
class FakeTTS implements TTSProvider {
  readonly name = "fake";
  readonly description = "fake";
  readonly format = "wav" as const;
  readonly said: string[] = [];
  readonly speakers: Speaker[] = [];

  constructor(readonly maxChars = 60) {}

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    this.said.push(text);
    this.speakers.push(speaker);
    // One byte per character, so a longer chunk really is longer audio.
    return buildWav(
      { audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 },
      Buffer.alloc(text.length * 2),
    );
  }
}

describe("speak", () => {
  it("says a short answer in one call", async () => {
    const tts = new FakeTTS();
    const out = await speak("Six ways, across three zones.", tts);
    expect(out.calls).toBe(1);
    expect(tts.said).toEqual(["Six ways, across three zones."]);
    expect(out.format).toBe("wav");
  });

  it("splits an answer past the backend's cap and joins it back", async () => {
    const tts = new FakeTTS(60);
    const answer =
      "Aurora replicates each segment six ways across three availability zones. " +
      "It uses a four of six write quorum. Recovery usually takes under ten seconds.";
    const out = await speak(answer, tts);

    expect(out.calls).toBeGreaterThan(1);
    for (const chunk of tts.said) expect(chunk.length).toBeLessThanOrEqual(60);
    // Joined into one file rather than handed back as pieces, because the
    // player has one element to put it in.
    expect(out.totalMs).toBeGreaterThan(0);
    expect(out.audio.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("narrates by default, since an answer has no second speaker", async () => {
    const tts = new FakeTTS();
    await speak("Anything.", tts);
    expect(tts.speakers).toEqual(["narrator"]);
  });

  it("speaks as whoever the caller names", async () => {
    const tts = new FakeTTS();
    await speak("Anything.", tts, "host");
    expect(tts.speakers).toEqual(["host"]);
  });

  it("refuses empty text rather than producing a silent file", async () => {
    await expect(speak("   ", new FakeTTS())).rejects.toThrow(/nothing to say/i);
  });
});

describe("answerVoiceFor", () => {
  it("answers a two-host episode in a voice from that episode", () => {
    // The bug: answering as "narrator" gave a hosted backend a third voice the
    // listener had never heard, so the reply arrived from a stranger.
    expect(answerVoiceFor("dialogue")).toBe("host");
  });

  it("narrates for the single-voice formats, which is the voice they use", () => {
    expect(answerVoiceFor("solo")).toBe("narrator");
    expect(answerVoiceFor("eli5")).toBe("narrator");
  });

  it("never picks a speaker the format does not contain", () => {
    // Solo and ELI5 episodes are consecutive narrator turns; host or guest
    // would be a voice that appears nowhere in them.
    for (const format of ["solo", "eli5"] as const) {
      expect(["narrator"]).toContain(answerVoiceFor(format));
    }
    expect(["host", "guest"]).toContain(answerVoiceFor("dialogue"));
  });
});
