/**
 * Tracing every LLM call, without touching a single call site.
 *
 * `LLMProvider` is one method reached through one factory, so a decorator here
 * instruments all five call sites — the script writer, the three judge passes,
 * and the reviser — with no signature changes anywhere.
 *
 * When tracing is off this returns the provider unchanged. That identity return
 * is not a tidiness detail: it is what makes the uninstrumented path provably
 * free, and it is asserted in the tests.
 */
import { SpanKind } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import { estimateCost } from "../eval/report";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";
import * as A from "./attributes";
import {
  capturePayloads,
  getTracer,
  isTracingEnabled,
  recordError,
  truncate,
} from "./tracer";

/** Omit an attribute entirely rather than writing `undefined`. */
function n(key: string, value: number | undefined): Attributes {
  return value === undefined ? {} : { [key]: value };
}

export function traced(inner: LLMProvider): LLMProvider {
  if (!isTracingEnabled()) return inner;

  return {
    name: inner.name,
    model: inner.model,
    generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const provider = A.providerName(inner.name);
      return getTracer().startActiveSpan(
        // The spec's naming convention is `{operation} {model}`. All five of our
        // schemas are the same GenAI operation — a chat completion — so the
        // schema name goes on `gen_ai.prompt.name` rather than into the
        // operation, which is a closed enum that backends filter on.
        `chat ${inner.model}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [A.GEN_AI_OPERATION_NAME]: "chat",
            [A.GEN_AI_PROVIDER_NAME]: provider,
            [A.GEN_AI_SYSTEM]: provider,
            [A.GEN_AI_REQUEST_MODEL]: inner.model,
            [A.GEN_AI_OUTPUT_TYPE]: "json",
            [A.GEN_AI_PROMPT_NAME]: req.schemaName,
            [A.PAPERCAST_SCHEMA]: req.schemaName,
            ...n(A.GEN_AI_REQUEST_MAX_TOKENS, req.maxTokens),
            ...n(A.GEN_AI_REQUEST_TEMPERATURE, req.temperature),
            // Sizes always, content never (unless opted in below).
            [A.PAPERCAST_CONTEXT_CHARS]: req.cacheableContext?.length ?? 0,
            [A.PAPERCAST_USER_CHARS]: req.user.length,
          },
        },
        async (span: Span): Promise<StructuredResult<T>> => {
          if (capturePayloads()) {
            span.setAttribute(
              A.GEN_AI_SYSTEM_INSTRUCTIONS,
              JSON.stringify([{ type: "text", content: truncate(req.system) }]),
            );
            span.setAttribute(
              A.GEN_AI_INPUT_MESSAGES,
              JSON.stringify([
                {
                  role: "user",
                  parts: [
                    ...(req.cacheableContext
                      ? [{ type: "text", content: truncate(req.cacheableContext) }]
                      : []),
                    { type: "text", content: truncate(req.user) },
                  ],
                },
              ]),
            );
          }

          try {
            const result = await inner.generateStructured(req);
            const u = result.usage;
            span.setAttributes({
              [A.GEN_AI_RESPONSE_MODEL]: result.model,
              ...n(A.GEN_AI_USAGE_INPUT_TOKENS, u.inputTokens),
              ...n(A.GEN_AI_USAGE_OUTPUT_TOKENS, u.outputTokens),
              ...n(A.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, u.cacheReadTokens),
              ...n(A.GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS, u.cacheWriteTokens),
              // Schema-validation retries the provider did internally. One span
              // covers all attempts — see the limitation noted in the README.
              [A.PAPERCAST_VALIDATION_RETRIES]: result.retries,
            });

            const cost = estimateCost(result.model, u);
            if (cost !== undefined) span.setAttribute(A.PAPERCAST_COST_USD, cost);

            if (capturePayloads()) {
              span.setAttribute(
                A.GEN_AI_OUTPUT_MESSAGES,
                JSON.stringify([
                  {
                    role: "assistant",
                    parts: [
                      { type: "tool_call", name: req.schemaName, arguments: result.data },
                    ],
                    finish_reason: "tool_calls",
                  },
                ]),
              );
            }
            return result;
          } catch (err) {
            recordError(span, err);
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },
  };
}
