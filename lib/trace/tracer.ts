/**
 * The tracer handle and the two flags that gate everything.
 *
 * Kept separate from `setup.ts` so the decorators can ask "is tracing on?"
 * without importing the SDK — which is what keeps the uninstrumented path free.
 */
import {
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "./attributes";

const TRACER_NAME = "paper-to-podcast";

let enabled = false;
let payloads = false;

/** Cap on a single captured prompt or response, in characters. */
export const PAYLOAD_MAX_CHARS = 4_000;

export function setEnabled(v: boolean): void {
  enabled = v;
}

export function isTracingEnabled(): boolean {
  return enabled;
}

export function setCapturePayloads(v: boolean): void {
  payloads = v;
}

export function capturePayloads(): boolean {
  return enabled && payloads;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Trim a captured payload.
 *
 * The spec sanctions this explicitly: "Instrumentation MAY provide a
 * configuration option allowing to truncate properties such as individual
 * message contents". It matters here because the paper travels as ~120k
 * characters of cacheable context on every judge call.
 */
export function truncate(text: string, max = PAYLOAD_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/**
 * Run `fn` inside a span, so anything it calls nests underneath.
 *
 * Nesting is automatic: `startActiveSpan` puts the span in OTel's active
 * context, which is backed by `AsyncLocalStorage`, so a span opened several
 * awaits deeper — inside a provider decorator, say — picks this one up as its
 * parent with nothing threaded through the call chain.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  return getTracer().startActiveSpan(
    name,
    { attributes },
    async (span: Span): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * A span that records nothing, for when tracing is off.
 *
 * `trace.wrapSpanContext` over an invalid context is the API's own way to hand
 * back a non-recording span, so callers can always write to something.
 */
const NOOP_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * `withSpan`, but the callback receives the span so it can record what it
 * learned along the way — a failed attempt's error and raw response, say.
 */
export function withSpanFor<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(NOOP_SPAN);
  return getTracer().startActiveSpan(
    name,
    { attributes },
    async (span: Span): Promise<T> => {
      try {
        return await fn(span);
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Mark a span failed. Never swallows — the caller still rethrows. */
export function recordError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.setAttribute(ATTR_ERROR_TYPE, error.name);
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}
