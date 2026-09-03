import dotenv from "dotenv";

// Load .env once, on first import. Safe to call repeatedly.
dotenv.config();

export type ProviderName = "anthropic" | "openai" | "open";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
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
  if (p === "anthropic" || p === "openai" || p === "open") return p;
  throw new Error(
    `LLM_PROVIDER must be one of "anthropic" | "openai" | "open" (got "${p}").`,
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
export const piperConfig = () => ({
  binary: opt("PIPER_BIN", ".venv-tts/bin/piper"),
  hostVoice: opt("PIPER_HOST_VOICE", ".voices/en_US-lessac-medium.onnx"),
  guestVoice: opt("PIPER_GUEST_VOICE", ".voices/en_US-ryan-medium.onnx"),
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
