import { describe, it, expect } from "vitest";
import { piperAvailable, voiceName } from "./piper";
import { getTTSProvider, resolveTTSProvider } from "./index";

describe("voiceName", () => {
  it("reduces a model path to the voice's name for reporting", () => {
    expect(voiceName(".voices/en_US-lessac-medium.onnx")).toBe("en_US-lessac-medium");
    expect(voiceName("/abs/path/en_GB-alan-low.onnx")).toBe("en_GB-alan-low");
  });

  it("leaves an already-bare name alone", () => {
    expect(voiceName("en_US-ryan-medium")).toBe("en_US-ryan-medium");
  });
});

describe("piperAvailable", () => {
  it("reports false when the binary is missing rather than throwing", async () => {
    // Availability is a question, not an error: the resolver uses it to fall
    // back to a backend that needs no installation.
    await expect(
      piperAvailable({
        binary: "/nonexistent/piper",
        hostVoice: "/nope.onnx",
        guestVoice: "/nope.onnx",
      }),
    ).resolves.toBe(false);
  });
});

describe("provider selection", () => {
  it("rejects an unknown backend by name", () => {
    expect(() => getTTSProvider("bogus" as never)).toThrow(/piper.*say.*openai/i);
  });

  it("honours an explicitly named backend", () => {
    expect(getTTSProvider("say").name).toBe("say");
    expect(getTTSProvider("piper").name).toBe("piper");
  });

  it("respects TTS_PROVIDER when no name is passed", async () => {
    const prev = process.env.TTS_PROVIDER;
    process.env.TTS_PROVIDER = "say";
    try {
      expect((await resolveTTSProvider()).name).toBe("say");
    } finally {
      if (prev === undefined) delete process.env.TTS_PROVIDER;
      else process.env.TTS_PROVIDER = prev;
    }
  });

  it("falls back to a backend that needs no install when none is configured", async () => {
    const prev = process.env.TTS_PROVIDER;
    delete process.env.TTS_PROVIDER;
    try {
      // Either is acceptable: the point is that it resolves rather than failing
      // when Piper's models are absent.
      const name = (await resolveTTSProvider()).name;
      expect(["piper", "say"]).toContain(name);
    } finally {
      if (prev !== undefined) process.env.TTS_PROVIDER = prev;
    }
  });
});
