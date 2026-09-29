/**
 * The whole of every span, written down.
 *
 * `LogProcessor` prints one line per span — operation, model, tokens, duration
 * — which is what a terminal beside a dev server is for. It is deliberately not
 * enough to answer "what exactly did we send it". That question needs the
 * prompt, the sections that were chosen, the chunk of text handed to the voice,
 * the script that came back, and it needs them after the run rather than
 * scrolling past during it.
 *
 * So this writes every span as one JSON object per line. JSONL rather than
 * prose because the useful thing to do with it is `jq`: filter to one job,
 * pull out every prompt, diff two runs. And appended rather than held in
 * memory, so a server can run for a week and a crash still leaves the evidence
 * up to the moment it happened.
 *
 * Content only appears when payload capture is on. Everything else — names,
 * counts, durations, attributes describing shape — is always written, because
 * none of it is anybody's document.
 */
import { appendFileSync } from "node:fs";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";

export type DetailSink = (line: string) => void;

function hrToMs(span: ReadableSpan): number {
  const [s, n] = span.duration;
  return s * 1000 + n / 1_000_000;
}

function isoOf(span: ReadableSpan): string {
  const [s, n] = span.startTime;
  return new Date(s * 1000 + n / 1_000_000).toISOString();
}

/**
 * One span as a JSON line.
 *
 * Exported so it can be tested without a provider, and so anything that wants
 * the same record does not invent a second shape for it.
 */
export function formatDetail(span: ReadableSpan): string {
  const ctx = span.spanContext();
  return JSON.stringify({
    at: isoOf(span),
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    durationMs: Number(hrToMs(span).toFixed(2)),
    // 2 is ERROR. Recorded as a word so a reader does not have to know that.
    status: span.status.code === 2 ? "error" : "ok",
    ...(span.status.message ? { error: span.status.message } : {}),
    attributes: span.attributes,
    ...(span.events.length
      ? { events: span.events.map((e) => ({ name: e.name, attributes: e.attributes })) }
      : {}),
  });
}

/**
 * Writes each finished span to a sink as JSON.
 *
 * Every span, not only this project's own — a detailed log exists for the run
 * that went wrong, and filtering out the framework's spans is the caller's job
 * with `jq`, not a decision to bake in here.
 */
export class DetailProcessor implements SpanProcessor {
  constructor(private readonly write: DetailSink) {}

  onStart(_span: ReadableSpan, _parent: Context): void {}

  onEnd(span: ReadableSpan): void {
    try {
      this.write(formatDetail(span));
    } catch {
      // A log that cannot be written must not take down the run it describes.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A sink appending to a file, one line per span.
 *
 * Synchronous on purpose. Span export is fire-and-forget and a process can exit
 * moments after the span that explains why; an async write would be the one
 * lost. The volume is a few lines per model call, which is not a rate that
 * needs buffering.
 */
export function fileSink(path: string): DetailSink {
  return (line) => appendFileSync(path, line + "\n", "utf8");
}
