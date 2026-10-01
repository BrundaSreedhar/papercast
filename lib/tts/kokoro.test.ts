/**
 * The adapter's job is the conversation with a long-lived worker: requests
 * answered in order, failures reported without killing it, a dead worker
 * replaced, and a finished run allowed to exit. A fake worker speaking the
 * same protocol stands in for Python and the model.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { KokoroProvider, kokoroAvailable } from "./kokoro";
import { getTTSProvider } from "./index";
import { parseWav } from "./wav";

const fake = (over = {}) =>
  new KokoroProvider({
    python: process.execPath,
    script: join(__dirname, "fixtures", "fake-kokoro-worker.mjs"),
    // Distinct per test, so each gets its own worker rather than a shared one.
    model: `model-${Math.random()}`,
    voices: "voices.bin",
    ...over,
  });

const samples = (wav: Buffer) => parseWav(wav).data.length / 2;

describe("KokoroProvider", () => {
  it("answers requests in turn from one worker", async () => {
    const k = fake();
    const a = await k.synthesizeChunk("one", "narrator");
    const b = await k.synthesizeChunk("three words here", "host");
    expect(samples(a)).toBe(3);
    expect(samples(b)).toBe("three words here".length);
    expect(parseWav(a).format.sampleRate).toBe(24000);
  });

  it("answers concurrent requests each with its own audio", async () => {
    const k = fake();
    const [a, b] = await Promise.all([
      k.synthesizeChunk("short", "host"),
      k.synthesizeChunk("a good deal longer", "guest"),
    ]);
    expect(samples(a)).toBe(5);
    expect(samples(b)).toBe("a good deal longer".length);
  });

  it("reports a refused request, and keeps serving", async () => {
    const k = fake();
    await expect(k.synthesizeChunk("FAIL please", "host")).rejects.toThrow(
      /no voice af_heart/,
    );
    expect(samples(await k.synthesizeChunk("still here", "host"))).toBe(10);
  });

  it("replaces a worker that died", async () => {
    const k = fake();
    await expect(k.synthesizeChunk("DIE now", "host")).rejects.toThrow(/worker exited/);
    expect(samples(await k.synthesizeChunk("back again", "host"))).toBe(10);
  });

  it("reads the narration and the host in an American female voice, the guest in another", () => {
    const k = new KokoroProvider();
    expect(k.voiceFor("narrator")).toBe("af_heart");
    expect(k.voiceFor("host")).toBe("af_heart");
    expect(k.voiceFor("guest")).not.toBe("af_heart");
  });

  it("gives the guest a quicker reading than the host", () => {
    // Kokoro's male voices read flatter and slower at the same setting, and
    // beside af_heart the guest sounded like the episode slowed down whenever
    // he spoke. The nudge is per speaker, so the host is untouched.
    const k = new KokoroProvider();
    expect(k.speedFor("guest")).toBeGreaterThan(k.speedFor("host"));
    expect(k.speedFor("narrator")).toBe(k.speedFor("host"));
  });

  it("lets a deployment set both speeds, and says so in its description", () => {
    const k = new KokoroProvider({ speed: 1, guestSpeed: 1.3 });
    expect(k.speedFor("guest")).toBe(1.3);
    expect(k.speedFor("host")).toBe(1);
    expect(k.description).toContain("1.3x");
  });
});

describe("kokoroAvailable", () => {
  it("is a question, not an error, when the model is missing", async () => {
    await expect(kokoroAvailable({ model: "/nonexistent/kokoro.onnx" })).resolves.toBe(
      false,
    );
  });
});

describe("selecting Kokoro", () => {
  it("can be named explicitly", () => {
    expect(getTTSProvider("kokoro").name).toBe("kokoro");
  });
});
