/**
 * Spans as they finish, one line each.
 *
 * The waterfall renders a whole run as a tree once it has ended, which is right
 * for a command and useless for a server: a long-lived process would collect
 * spans forever and never reach the point where they are drawn. And the OTLP
 * exporter needs a collector running, which is a lot to ask of someone who
 * only wants to see which model was just called.
 *
 * So this prints each span as it closes — the operation, the model, what it
 * cost and how long it took — which is what a terminal beside a dev server is
 * actually for.
 *
 * It formats but never prints. The sink is passed in, because nothing under
 * `lib/` writes to a console, and that rule is what lets the same code run
 * behind a CLI, a server and a test.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "./attributes";

export type Sink = (line: string) => void;

function ms(span: ReadableSpan): number {
  const [s, n] = span.duration;
  return s * 1000 + n / 1_000_000;
}

function duration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * One line describing a finished span.
 *
 * Exported so it can be tested without a tracer provider, and so anything else
 * that wants the same summary does not reinvent the format.
 */
export function formatSpan(span: ReadableSpan): string {
  const a = span.attributes;
  const parts: string[] = [];

  // The model is the thing being asked for. Response model over request model:
  // they differ when a provider silently serves a dated snapshot.
  const model = a[GEN_AI_RESPONSE_MODEL] ?? a[GEN_AI_REQUEST_MODEL];
  parts.push(span.name);
  // The span name usually ends in the model already — "chat qwen2:7b-32k" —
  // and printing it twice on the same line reads as a mistake.
  if (model && !span.name.includes(String(model))) parts.push(String(model));

  const input = num(a[GEN_AI_USAGE_INPUT_TOKENS]);
  const output = num(a[GEN_AI_USAGE_OUTPUT_TOKENS]);
  const cached = num(a[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]);
  if (input !== undefined || output !== undefined) {
    const tokens = `${input ?? 0} in → ${output ?? 0} out`;
    parts.push(cached ? `${tokens} (${cached} cached)` : tokens);
  }

  parts.push(duration(ms(span)));
  if (span.status.code === 2) {
    parts.push(`FAILED${span.status.message ? `: ${span.status.message}` : ""}`);
  }

  return `  ${parts.join("  ·  ")}`;
}

/**
 * Whether a span is worth a line.
 *
 * A dev server produces a span per request, per static asset and per route
 * segment, and burying the two model calls someone actually wants in that is
 * the same as printing nothing. Only spans this project created are logged.
 */
function ours(span: ReadableSpan): boolean {
  return (
    span.attributes[GEN_AI_OPERATION_NAME] !== undefined ||
    span.instrumentationScope?.name === "paper-to-podcast"
  );
}

export class LogProcessor implements SpanProcessor {
  constructor(private readonly write: Sink) {}

  onStart(_span: ReadableSpan, _parent: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (ours(span)) this.write(formatSpan(span));
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
