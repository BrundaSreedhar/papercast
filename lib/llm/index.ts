import { activeProvider, type ProviderName } from "../config/env";
import type { LLMProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { OpenCompatibleProvider } from "./openCompatible";
import { traced } from "../trace/llm";

/**
 * Instantiate a provider by name (defaults to LLM_PROVIDER from env).
 *
 * This is the only place a provider is constructed, which is why wrapping it
 * traces every LLM call in the project without touching a single call site.
 * `traced` returns the provider unchanged when tracing is off.
 */
export function getProvider(name: ProviderName = activeProvider()): LLMProvider {
  return traced(build(name));
}

function build(name: ProviderName): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "open":
      return new OpenCompatibleProvider();
  }
}

export type { LLMProvider, StructuredRequest, StructuredResult } from "./types";
export * from "./schema";
