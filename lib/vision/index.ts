import { AnthropicVisionProvider } from "./anthropic";
import { OpenAICompatibleVisionProvider } from "./openaiCompatible";
import type { VisionProvider } from "./types";
import { tracedVision } from "../trace/vision";

export type VisionProviderName = "anthropic" | "openai" | "open";

export function getVisionProvider(name?: VisionProviderName): VisionProvider {
  return tracedVision(buildVision(name));
}

function buildVision(name?: VisionProviderName): VisionProvider {
  const chosen = name ?? (process.env.VISION_PROVIDER as VisionProviderName) ?? "anthropic";
  switch (chosen) {
    case "anthropic":
      return new AnthropicVisionProvider();
    case "openai":
      return new OpenAICompatibleVisionProvider("openai");
    case "open":
      return new OpenAICompatibleVisionProvider("open");
    default:
      throw new Error(`Unknown vision provider "${chosen}".`);
  }
}

export { AnthropicVisionProvider, OpenAICompatibleVisionProvider };
export { describeFigures, enrichWithFigures, figuresToText } from "./describe";
export type { FigureDescription, VisionProvider } from "./types";
