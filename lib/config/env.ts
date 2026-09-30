import dotenv from "dotenv";

// Load .env once, on first import. Safe to call repeatedly.
dotenv.config();

export type ProviderName = "anthropic" | "openai" | "gemini" | "open";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

/**
 * Which provider drives script generation. Defaults to Anthropic so the
 * project leads with Claude while staying swappable.
 */
export function activeProvider(): ProviderName {
  const p = opt("LLM_PROVIDER", "anthropic").toLowerCase();
  if (p === "anthropic" || p === "openai" || p === "gemini" || p === "open") return p;
  throw new Error(
    `LLM_PROVIDER must be one of "anthropic" | "openai" | "gemini" | "open" (got "${p}").`,
  );
}

export const anthropicConfig = () => ({
  apiKey: req("ANTHROPIC_API_KEY"),
  model: opt("ANTHROPIC_MODEL", "claude-sonnet-5"),
});

export const openaiConfig = () => ({
  apiKey: req("OPENAI_API_KEY"),
  model: opt("OPENAI_MODEL", "gpt-4o"),
  ttsModel: opt("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
});

/**
 * Piper runs from a project-local virtualenv and voice models that live outside
 * the repository, so both are configurable rather than assumed.
 */
/**
 * Kokoro, the local voice: its interpreter, model files and voices.
 *
 * `af_heart` is an American female voice, Kokoro's best-rated, and reads the
 * narration and the host. A two-voice episode needs a second, clearly
 * different voice for the guest, so that one is American male.
 */
export const kokoroConfig = () => ({
  python: opt("KOKORO_PYTHON", ".venv-tts/bin/python"),
  model: opt("KOKORO_MODEL", ".voices/kokoro/kokoro-v1.0.onnx"),
  voices: opt("KOKORO_VOICES", ".voices/kokoro/voices-v1.0.bin"),
  hostVoice: opt("KOKORO_HOST_VOICE", "af_heart"),
  guestVoice: opt("KOKORO_GUEST_VOICE", "am_michael"),
  narratorVoice: opt("KOKORO_NARRATOR_VOICE", "af_heart"),
  speed: Number(opt("KOKORO_SPEED", "1")),
});

export const piperConfig = () => ({
  binary: opt("PIPER_BIN", ".venv-tts/bin/piper"),
  hostVoice: opt("PIPER_HOST_VOICE", ".voices/en_US-lessac-medium.onnx"),
  guestVoice: opt("PIPER_GUEST_VOICE", ".voices/en_US-ryan-medium.onnx"),
});

/**
 * Gemini, reached over its OpenAI-compatible endpoint rather than its own SDK.
 *
 * Google publishes a compatibility layer that speaks the OpenAI wire protocol,
 * which means the adapter this project already has — schema in the prompt, Zod
 * validation, retry with the parse error fed back — works unchanged. Adding a
 * second SDK and a fourth hand-written adapter to reach the same guaranteed
 * shape would be a dependency and a hundred lines bought for nothing.
 */
export const geminiConfig = () => ({
  apiKey: req("GEMINI_API_KEY"),
  model: opt("GEMINI_MODEL", "gemini-2.5-flash"),
  baseURL: opt(
    "GEMINI_BASE_URL",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  ),
});

/**
 * Gemini's TTS models, which are reached natively rather than over the
 * OpenAI-compatible endpoint the LLM path uses — that layer does not carry
 * speech.
 *
 * Voices are the prebuilt names Google publishes. Three rather than two,
 * because a solo or ELI5 episode speaks as `narrator` and giving it the host's
 * voice would make the two formats indistinguishable by ear.
 */
export const geminiTtsConfig = () => ({
  apiKey: req("GEMINI_API_KEY"),
  model: opt("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
  hostVoice: opt("GEMINI_HOST_VOICE", "Kore"),
  guestVoice: opt("GEMINI_GUEST_VOICE", "Puck"),
  narratorVoice: opt("GEMINI_NARRATOR_VOICE", "Charon"),
});

export const openConfig = () => ({
  baseURL: opt("OPEN_BASE_URL", "http://localhost:11434/v1"),
  // Local runtimes (Ollama) accept any non-empty key.
  apiKey: opt("OPEN_API_KEY", "ollama"),
  model: opt("OPEN_MODEL", "qwen2:7b"),
});

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The public deployment, where the bill is paid by whoever built this and the
 * visitors are strangers.
 *
 * Demo mode refuses uploads and offers a fixed set of papers fetched into the
 * image instead. That bounds spend at a known number rather than at whatever
 * the internet decides to upload, and it removes the one route that would
 * otherwise accept an arbitrary file from anyone who finds the URL. The limits
 * are configuration rather than constants because the ceiling that suits a
 * portfolio link is not the one that suits a demo given to a room of people.
 */
export const demoConfig = () => ({
  enabled: (process.env.DEMO_MODE ?? "").trim() === "1",
  /** Longest episode a visitor may ask for. Length drives the whole bill. */
  maxMinutes: num("DEMO_MAX_MINUTES", 4),
  /** Episodes in flight at once. One machine synthesizing two is one too many. */
  concurrentJobs: num("DEMO_CONCURRENT_JOBS", 1),
  /** Episodes per rolling day, after which the demo says so and stops. */
  dailyJobs: num("DEMO_DAILY_JOBS", 25),
});
