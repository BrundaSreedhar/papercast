/**
 * Synthesis via Gemini's TTS models.
 *
 * The best-sounding option here by some distance, and the lightest to install:
 * Piper wants a virtualenv and two ONNX voice files fetched out of band, and
 * this wants an API key. That is the trade — quality and nothing to install,
 * against a network call and an account.
 *
 * Unlike the LLM path, this is a real adapter rather than `OpenCompatible` with
 * different config. Google's OpenAI compatibility layer covers chat and
 * embeddings, not speech: TTS goes through `generateContent` with an AUDIO
 * response modality and a `speechConfig`, which is a different request shape
 * and a different response shape. Reaching it over the endpoint we already
 * speak was checked and is not possible, so the adapter is the honest cost.
 *
 * One turn per call, like every other backend, and deliberately not Gemini's
 * multi-speaker mode. Multi-speaker would voice a whole host/guest exchange in
 * a single request, which sounds appealing until you notice what this pipeline
 * does with the result: per-turn timings drive the transcript highlighting, the
 * citation anchors and the ASR verification, and they are computed from each
 * segment's own sample count. A single blob of two voices has no per-turn
 * boundaries to compute them from.
 *
 * The audio comes back as headerless little-endian PCM — `audio/l16;
 * rate=24000; channels=1` — so it is wrapped in a RIFF header here, exactly as
 * the OpenAI backend does, and every segment joins with the same code path.
 */
import { geminiTtsConfig } from "../config/env";
import { buildWav } from "./wav";
import type { Speaker, TTSProvider } from "./types";

/**
 * How each speaker is asked to sound, sent identically with every chunk.
 *
 * Gemini generates a voice rather than playing one back, and each call is its
 * own generation with no memory of the last. Given bare text, "Charon" came
 * back as a noticeably different man from one turn to the next — the narrator's
 * pitch floor moved 22% across a single episode, where every Piper voice held
 * within 10%, and a listener heard two people in a one-voice format. The
 * `voice-consistency` audio check exists because of it.
 *
 * Fixing the delivery in words, the same words every time, gives every
 * generation the same target. It asks for one consistent *voice* — identity
 * is what drifted — and an engaged, expressive *delivery*. The first version
 * asked for "calm, steady, even pace, without changing tone", which pins the
 * identity by flattening the reading, and a podcast read that way is exactly
 * the monotone this project is trying to avoid. The direction ends in a colon
 * so the model reads it as direction rather than as text.
 *
 * What has been measured, and what has not. Speech recognition on six
 * directed clips heard only the episode's text, never the direction. Whether
 * it reduces drift is not yet shown: on two-sentence clips the bare voice
 * drifted only 11%, and the directed one the same, so short clips do not
 * reproduce the 22% a full episode showed. Re-recording a full episode and
 * reading `voice-consistency` is the test that settles it.
 */
export const STYLE: Record<Speaker, string> = {
  narrator:
    "Read the following as the same podcast narrator throughout, keeping one consistent voice: warm and engaged, like telling a friend about something genuinely interesting, with natural rises, emphasis and pauses; never flat or robotic",
  host: "Read the following as the podcast's host, keeping one consistent voice: bright, curious and engaged, with natural rises, emphasis and pauses; never flat or robotic",
  guest:
    "Read the following as the podcast's guest expert, keeping one consistent voice: warm, clear and enthusiastic about the work, with natural emphasis and pauses; never flat or robotic",
};

/** What is sent for one chunk: the speaker's fixed direction, then the text. */
export function directed(text: string, speaker: Speaker): string {
  return `${STYLE[speaker]}:\n\n${text}`;
}

/** The rate the TTS models emit. Read from the response and checked, not assumed. */
const PCM_SAMPLE_RATE = 24000;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiTTSOptions {
  hostVoice?: string;
  guestVoice?: string;
  narratorVoice?: string;
  model?: string;
  /** Attempts per chunk, including the first. */
  attempts?: number;
  /**
   * Base backoff between attempts, multiplied by the attempt number.
   *
   * Injectable so tests can exercise the retry without waiting out a real
   * backoff, and so a caller who knows the model is busy can back off harder.
   */
  retryDelayMs?: number;
}

interface AudioPart {
  inlineData?: { mimeType?: string; data?: string };
}

interface TTSResponse {
  candidates?: { content?: { parts?: AudioPart[] } }[];
  error?: { code?: number; message?: string; status?: string };
}

/** Sample rate declared by the response, when it says. */
export function rateFromMime(mime: string | undefined): number {
  const found = /rate=(\d+)/.exec(mime ?? "");
  return found ? Number(found[1]) : PCM_SAMPLE_RATE;
}

/**
 * Whether a failure is worth trying again.
 *
 * The TTS models are preview models and answer "this model is currently
 * experiencing high demand" under load — a 503 that clears on its own. An
 * episode is a dozen or more calls in a row, so hitting one is likely and
 * failing the whole episode over it would be absurd. A 400 is a bad request and
 * will be exactly as bad the second time.
 */
export function worthRetrying(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiTTSProvider implements TTSProvider {
  readonly name = "gemini";
  readonly format = "wav" as const;
  /**
   * Well inside the model's 8,192-token input window.
   *
   * Deliberately conservative rather than maximal: the chunker splits on
   * sentence boundaries, so a smaller cap costs an extra call and buys shorter
   * requests, which matter on a preview model that is slow under load. The
   * style direction rides along with every chunk and is not counted here.
   */
  readonly maxChars = 3_000;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly hostVoice: string;
  private readonly guestVoice: string;
  private readonly narratorVoice: string;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(opts: GeminiTTSOptions = {}) {
    const cfg = geminiTtsConfig();
    this.apiKey = cfg.apiKey;
    this.model = opts.model ?? cfg.model;
    this.hostVoice = opts.hostVoice ?? cfg.hostVoice;
    this.guestVoice = opts.guestVoice ?? cfg.guestVoice;
    this.narratorVoice = opts.narratorVoice ?? cfg.narratorVoice;
    this.attempts = opts.attempts ?? 4;
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
  }

  get description(): string {
    return `${this.model}: ${this.hostVoice} (host) / ${this.guestVoice} (guest) / ${this.narratorVoice} (narrator)`;
  }

  voiceFor(speaker: Speaker): string {
    if (speaker === "guest") return this.guestVoice;
    if (speaker === "narrator") return this.narratorVoice;
    return this.hostVoice;
  }

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    if (text.length > this.maxChars) {
      throw new Error(
        `Chunk of ${text.length} characters exceeds the ${this.maxChars}-character limit; it should have been split before reaching the provider.`,
      );
    }

    const body = JSON.stringify({
      contents: [{ parts: [{ text: directed(text, speaker) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceFor(speaker) } },
        },
      },
    });

    let lastError = "";
    let tried = 0;
    let configError = false;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      tried = attempt;
      let res: Response;
      try {
        res = await fetch(`${ENDPOINT}/${this.model}:generateContent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body,
          // Long, because this model is slow under load and a synthesis that
          // eventually lands beats one abandoned at the usual timeout.
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === this.attempts) break;
        await wait(this.retryDelayMs * attempt);
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        lastError = `HTTP ${res.status}: ${detail.slice(0, 300)}`;
        // A 404 here is almost always a mistyped model id, and no number of
        // retries fixes a name. Say so, rather than leaving someone reading a
        // capacity-shaped message about a configuration mistake.
        configError = res.status === 404 || res.status === 400 || res.status === 403;
        if (!worthRetrying(res.status) || attempt === this.attempts) break;
        // Linear, not exponential: capacity clears in seconds and the caller is
        // a person watching a progress bar.
        await wait(this.retryDelayMs * attempt);
        continue;
      }

      const payload = (await res.json()) as TTSResponse;
      const part = payload.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const encoded = part?.inlineData?.data;
      if (!encoded) {
        lastError = payload.error?.message ?? "response carried no audio";
        if (attempt === this.attempts) break;
        await wait(this.retryDelayMs * attempt);
        continue;
      }

      const pcm = Buffer.from(encoded, "base64");
      return buildWav(
        {
          audioFormat: 1,
          channels: 1,
          sampleRate: rateFromMime(part?.inlineData?.mimeType),
          bitsPerSample: 16,
        },
        pcm,
      );
    }

    // Report what was actually tried. Quoting the permitted maximum made a
    // single-attempt configuration failure read as four exhausted retries,
    // which sent debugging in exactly the wrong direction.
    const howMany = tried === 1 ? "on the first attempt" : `after ${tried} attempts`;
    const advice = configError
      ? ` This looks like configuration rather than a transient failure: check GEMINI_TTS_MODEL is one of the ids the API lists (currently gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts, gemini-3.1-flash-tts-preview) and that GEMINI_API_KEY is valid.`
      : "";
    throw new Error(
      `Gemini TTS failed ${howMany} for a ${text.length}-character chunk. ${lastError}${advice}`,
    );
  }
}

/** Whether this backend can be used at all, without making a request. */
export function geminiTtsAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
