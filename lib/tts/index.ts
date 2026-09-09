import { MacSayProvider, macSayAvailable } from "./macSay";
import { PiperProvider, piperAvailable } from "./piper";
import { OpenAITTSProvider } from "./openaiTts";
import type { TTSProvider } from "./types";

export type TTSProviderName = "piper" | "say" | "openai";

/**
 * Choose a synthesis backend explicitly. Prefer `resolveTTSProvider` when no
 * provider was named, so the better local voice is used when it is installed.
 */
export function getTTSProvider(name?: TTSProviderName): TTSProvider {
  const chosen = name ?? (process.env.TTS_PROVIDER as TTSProviderName) ?? "say";
  switch (chosen) {
    case "piper":
      return new PiperProvider();
    case "openai":
      return new OpenAITTSProvider();
    case "say":
      return new MacSayProvider();
    default:
      throw new Error(
        `Unknown TTS provider "${chosen}". Use "piper", "say", or "openai".`,
      );
  }
}

/**
 * Pick a backend when the caller did not name one.
 *
 * Piper sounds markedly better and is equally free, but needs voice models
 * fetched once. The macOS voice needs nothing at all. Preferring Piper when it
 * is present and falling back otherwise means a fresh checkout still produces
 * audio, and an installed Piper is used without anyone having to remember a
 * flag.
 */
export async function resolveTTSProvider(name?: TTSProviderName): Promise<TTSProvider> {
  if (name) return getTTSProvider(name);
  const configured = process.env.TTS_PROVIDER as TTSProviderName | undefined;
  if (configured) return getTTSProvider(configured);
  if (await piperAvailable()) return new PiperProvider();
  return new MacSayProvider();
}

export {
  MacSayProvider,
  macSayAvailable,
  OpenAITTSProvider,
  PiperProvider,
  piperAvailable,
};
export { synthesizeEpisode } from "./synthesize";
export type { EpisodeAudio, TTSProvider, TurnTiming } from "./types";
