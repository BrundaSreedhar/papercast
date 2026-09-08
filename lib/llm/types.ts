import type { z } from "zod";
import type { ProviderName } from "../config/env";

/** A request for structured output validated against a Zod schema. */
export interface StructuredRequest<T> {
  system: string;
  /**
   * A large, reusable prefix — a whole paper, say — that providers supporting
   * prompt caching may cache. Judging N episodes of the same paper otherwise
   * re-sends it N times, and the paper dominates the token bill. Providers
   * without caching simply prepend it to `user`, so behaviour is identical.
   */
  cacheableContext?: string;
  user: string;
  /** Validation schema — the contract every provider must satisfy. */
  schema: z.ZodType<T>;
  /** Short name for the schema/tool (e.g. "episode"). */
  schemaName: string;
  schemaDescription?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Called with one field's value as it arrives, when the provider streams.
   *
   * Optional on both sides: a provider that cannot stream ignores it, and a
   * caller that does not pass it gets the behaviour it always had. The field is
   * named rather than assumed because only the caller knows which part of its
   * schema is worth showing before the rest lands — for an answer that is the
   * prose, never the quotes it is still deciding on.
   */
  stream?: {
    field: string;
    onText: (soFar: string) => void;
  };
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number;
  /** Input tokens served from the prompt cache, billed at a large discount. */
  cacheReadTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
  provider: ProviderName;
  model: string;
  /** Validation-retry attempts used before success (0 = first try). */
  retries: number;
}

/**
 * The one interface the rest of the app depends on. Providers hide the wildly
 * different ways Claude, OpenAI, and open models produce structured output.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
