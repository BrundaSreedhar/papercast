import { MacSayProvider, macSayAvailable } from "./macSay";
import { PiperProvider, piperAvailable } from "./piper";
import { KokoroProvider, kokoroAvailable } from "./kokoro";
import { OpenAITTSProvider } from "./openaiTts";
import { GeminiTTSProvider, geminiTtsAvailable } from "./geminiTts";
import type { TTSProvider } from "./types";

export type TTSProviderName = "kokoro" | "piper" | "say" | "openai" | "gemini";

/**
 * Choose a synthesis backend explicitly. Prefer `resolveTTSProvider` when no
 * provider was named, so the better local voice is used when it is installed.
 */
export function getTTSProvider(name?: TTSProviderName): TTSProvider {
  const chosen = name ?? (process.env.TTS_PROVIDER as TTSProviderName) ?? "say";
  switch (chosen) {
    case "kokoro":
      return new KokoroProvider();
    case "piper":
      return new PiperProvider();
    case "openai":
      return new OpenAITTSProvider();
    case "gemini":
      return new GeminiTTSProvider();
    case "say":
      return new MacSayProvider();
    default:
      throw new Error(
        `Unknown TTS provider "${chosen}". Use "kokoro", "piper", "say", "openai", or "gemini".`,
      );
  }
}

/**
 * Pick a backend when the caller did not name one.
 *
 * Kokoro sounds most like a person reading and Piper is the smallest; both
 * are free but need model files fetched once. The macOS voice needs nothing at
 * all. Taking the best one installed means a fresh checkout still produces
 * audio, and an installed Kokoro is used without anyone having to remember a
 * flag.
 */
export async function resolveTTSProvider(name?: TTSProviderName): Promise<TTSProvider> {
  if (name) return getTTSProvider(name);
  const configured = process.env.TTS_PROVIDER as TTSProviderName | undefined;
  if (configured) return getTTSProvider(configured);
  if (await kokoroAvailable()) return new KokoroProvider();
  if (await piperAvailable()) return new PiperProvider();
  return new MacSayProvider();
}

/**
 * A local backend to fall back to when a hosted one fails.
 *
 * Only for hosted primaries: Piper failing means Piper is not installed, and
 * retrying the whole episode against the same missing binary is not a backup.
 * `TTS_FALLBACK` names one explicitly, or "none" turns the whole thing off for
 * a caller who would rather see the failure than a different voice.
 */
export async function resolveFallbackTTS(
  primary: TTSProvider,
): Promise<TTSProvider | undefined> {
  const configured = (process.env.TTS_FALLBACK ?? "").trim().toLowerCase();
  if (configured === "none") return undefined;
  if (configured) {
    const chosen = getTTSProvider(configured as TTSProviderName);
    return chosen.name === primary.name ? undefined : chosen;
  }
  // Piper and the system voice are the last resorts; there is nothing safer to
  // fall back to from them. Kokoro falls back to Piper: it runs a Python
  // worker, which can fail where Piper's single binary would not.
  if (primary.name === "piper" || primary.name === "say") return undefined;
  if (primary.name !== "kokoro" && (await kokoroAvailable())) return new KokoroProvider();
  if (await piperAvailable()) return new PiperProvider();
  if (await macSayAvailable()) return new MacSayProvider();
  return undefined;
}

export {
  KokoroProvider,
  kokoroAvailable,
  GeminiTTSProvider,
  geminiTtsAvailable,
  MacSayProvider,
  macSayAvailable,
  OpenAITTSProvider,
  PiperProvider,
  piperAvailable,
};
export { synthesizeEpisode } from "./synthesize";
export type { EpisodeAudio, TTSProvider, TurnTiming } from "./types";
