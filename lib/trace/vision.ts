/**
 * The same decorator, for the figure-reading model.
 *
 * `describePage` returns a bare string, so there are no token counts and no
 * cost to record — duration, page, and payload sizes are what a vision span
 * can honestly carry. Widening `VisionProvider` to return usage would fix that,
 * and would be a signature change on an interface with two implementations.
 */
import { SpanKind } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { VisionProvider } from "../vision/types";
import * as A from "./attributes";
import {
  capturePayloads,
  getTracer,
  isTracingEnabled,
  recordError,
  truncate,
} from "./tracer";

export function tracedVision(inner: VisionProvider): VisionProvider {
  if (!isTracingEnabled()) return inner;

  return {
    name: inner.name,
    model: inner.model,
    describePage(png: Buffer, captions: string[]): Promise<string> {
      const provider = A.providerName(inner.name);
      return getTracer().startActiveSpan(
        `chat ${inner.model}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            [A.GEN_AI_OPERATION_NAME]: "chat",
            [A.GEN_AI_PROVIDER_NAME]: provider,
            [A.GEN_AI_SYSTEM]: provider,
            [A.GEN_AI_REQUEST_MODEL]: inner.model,
            [A.GEN_AI_OUTPUT_TYPE]: "text",
            [A.PAPERCAST_TASK]: "describe_page",
            // Size only. Never base64 the page onto a span under any flag —
            // that is megabytes each with nothing to learn from it.
            [A.PAPERCAST_IMAGE_BYTES]: png.byteLength,
            [A.PAPERCAST_CAPTION_COUNT]: captions.length,
          },
        },
        async (span: Span): Promise<string> => {
          try {
            const description = await inner.describePage(png, captions);
            if (capturePayloads()) {
              span.setAttribute(
                A.GEN_AI_OUTPUT_MESSAGES,
                JSON.stringify([
                  {
                    role: "assistant",
                    parts: [{ type: "text", content: truncate(description) }],
                  },
                ]),
              );
            }
            return description;
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
