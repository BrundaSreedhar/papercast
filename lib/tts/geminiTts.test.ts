/**
 * The Gemini synthesis backend, with `fetch` faked so these run with no key and
 * no network. What is worth testing is the wrapping and the retrying: the audio
 * arrives headerless and has to become a joinable WAV, and the model answers
 * "high demand" often enough that a dozen-call episode would otherwise fail on
 * a transient 503.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GeminiTTSProvider, rateFromMime, worthRetrying } from "./geminiTts";
import { parseWav } from "./wav";

/** A response carrying `samples` of silence, shaped as the API shapes it. */
function audioResponse(samples: number, rate = 24000): Response {
  const pcm = Buffer.alloc(samples * 2);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: `audio/l16; rate=${rate}; channels=1`,
                  data: pcm.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
  } as unknown as Response;
}

function errorResponse(status: number, message = "boom"): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message } }),
  } as unknown as Response;
}

const original = globalThis.fetch;

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/** No real backoff: the delay is production behaviour, not what is under test. */
const instant = { retryDelayMs: 0 } as const;

describe("rateFromMime", () => {
  it("reads the rate the response declares rather than assuming one", () => {
    expect(rateFromMime("audio/l16; rate=24000; channels=1")).toBe(24000);
    expect(rateFromMime("audio/l16; rate=16000; channels=1")).toBe(16000);
  });

  it("falls back to the documented rate when the header says nothing", () => {
    expect(rateFromMime(undefined)).toBe(24000);
  });
});

describe("worthRetrying", () => {
  it("retries capacity and rate limits, not bad requests", () => {
    // "This model is currently experiencing high demand" is a 503 that clears
    // on its own; a 400 will be exactly as wrong the second time.
    expect(worthRetrying(503)).toBe(true);
    expect(worthRetrying(429)).toBe(true);
    expect(worthRetrying(400)).toBe(false);
    expect(worthRetrying(401)).toBe(false);
  });
});

describe("GeminiTTSProvider", () => {
  it("wraps the headerless PCM it receives into a parseable WAV", async () => {
    globalThis.fetch = vi.fn(async () => audioResponse(24_000)) as typeof fetch;
    const tts = new GeminiTTSProvider();

    const wav = await tts.synthesizeChunk("Hello.", "host");

    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    const parsed = parseWav(wav);
    expect(parsed.format.sampleRate).toBe(24_000);
    expect(parsed.format.bitsPerSample).toBe(16);
    expect(parsed.format.channels).toBe(1);
    // 24,000 samples at 24 kHz is one second.
    expect(parsed.durationMs).toBeCloseTo(1000, 0);
  });

  it("honours the rate the response declares, not the default", async () => {
    globalThis.fetch = vi.fn(async () => audioResponse(8_000, 16_000)) as typeof fetch;
    const wav = await new GeminiTTSProvider().synthesizeChunk("Hello.", "host");
    expect(parseWav(wav).format.sampleRate).toBe(16_000);
  });

  it("gives each speaker its own voice, including the narrator", () => {
    const tts = new GeminiTTSProvider({
      hostVoice: "H",
      guestVoice: "G",
      narratorVoice: "N",
    });
    expect(tts.voiceFor("host")).toBe("H");
    expect(tts.voiceFor("guest")).toBe("G");
    // A solo episode is all narrator; handing it the host voice would make the
    // two formats sound identical.
    expect(tts.voiceFor("narrator")).toBe("N");
  });

  it("sends the voice and the audio modality the API requires", async () => {
    const spy = vi.fn(async () => audioResponse(100));
    globalThis.fetch = spy as unknown as typeof fetch;
    await new GeminiTTSProvider({ guestVoice: "Puck" }).synthesizeChunk("Hi.", "guest");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(":generateContent");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe("Puck");
  });

  it("retries a capacity failure and succeeds", async () => {
    // The real failure mode: an episode is a dozen calls and this model answers
    // "high demand" under load. Failing the episode over it would be absurd.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? errorResponse(503, "high demand") : audioResponse(2_400);
    }) as typeof fetch;

    const wav = await new GeminiTTSProvider({ attempts: 4, ...instant }).synthesizeChunk(
      "Hi.",
      "host",
    );
    expect(calls).toBe(3);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("gives up on a bad request without burning the retries", async () => {
    const spy = vi.fn(async () => errorResponse(400, "bad voice name"));
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(
      new GeminiTTSProvider({ attempts: 4, ...instant }).synthesizeChunk("Hi.", "host"),
    ).rejects.toThrow(/bad voice name/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports the chunk size when it finally fails, so the cause is findable", async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(503)) as typeof fetch;
    await expect(
      new GeminiTTSProvider({ attempts: 2, ...instant }).synthesizeChunk(
        "Hello there.",
        "host",
      ),
    ).rejects.toThrow(/2 attempts for a 12-character chunk/);
  });

  it("refuses a chunk past the cap rather than letting the API discover it", async () => {
    const tts = new GeminiTTSProvider();
    await expect(
      tts.synthesizeChunk("x".repeat(tts.maxChars + 1), "host"),
    ).rejects.toThrow(/exceeds the 3000-character limit/);
  });
});
