/**
 * The zero-config view: a span tree printed at the end of a run.
 *
 * `ConsoleSpanExporter` emits a JSON blob per span, which is unreadable for the
 * thing this exists to show — the shape of the agent loop. So spans are
 * collected in process and rendered as a tree.
 *
 * A `SpanProcessor` rather than a `SpanExporter`, for two reasons. Semantically
 * we are collecting in process, not exporting over a wire. Practically,
 * `SpanExporter.export` is typed against `ExportResult` from
 * `@opentelemetry/core`, which would drag that package into the dependency list
 * for no benefit; `SpanProcessor` needs only `Context` and `ReadableSpan`.
 *
 * `renderWaterfall` is pure — spans in, string out. That is what lets it be
 * tested without a filesystem or a collector, and it is why nothing under
 * `lib/` prints: the string travels up to an entrypoint, which decides whether
 * to write it.
 */
import { SpanStatusCode, type Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_ERROR_TYPE,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  PAPERCAST_COST_USD,
  PAPERCAST_SCHEMA,
  PAPERCAST_TASK,
  PAPERCAST_VALIDATION_ERROR,
} from "./attributes";

/** Collects finished spans so they can be rendered as a tree at shutdown. */
export class WaterfallProcessor implements SpanProcessor {
  private readonly spans: ReadableSpan[] = [];

  onStart(_span: ReadableSpan, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Deliberately keeps the spans: shutdown flushes exporters, then we render. */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  render(): string {
    return renderWaterfall(this.spans);
  }

  get size(): number {
    return this.spans.length;
  }
}

/** OTel reports times as [seconds, nanoseconds]. */
function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

/**
 * Order two [seconds, nanoseconds] pairs.
 *
 * Element-wise, because collapsing an HrTime into one number overflows
 * MAX_SAFE_INTEGER and silently rounds the nanosecond half away — which would
 * make sibling ordering arbitrary for spans that start in the same millisecond.
 */
function compareStart(a: ReadableSpan, b: ReadableSpan): number {
  return a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1];
}

function num(span: ReadableSpan, key: string): number | undefined {
  const v = span.attributes[key];
  return typeof v === "number" ? v : undefined;
}

function secs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Matches the money formatting already used in the eval report. */
function usd(n: number | undefined): string {
  if (n === undefined || n === 0) return "";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

function count(n: number | undefined): string {
  return n === undefined ? "" : n.toLocaleString("en-US");
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  usd: number;
}

/**
 * Render finished spans as an indented tree.
 *
 * Token and cost columns are summed over each subtree, so a parent line reports
 * what everything beneath it consumed — which is the number you actually want
 * when asking what a refine round cost.
 */
export function renderWaterfall(spans: ReadableSpan[]): string {
  if (spans.length === 0) return "";

  const byId = new Map<string, ReadableSpan>();
  for (const s of spans) byId.set(s.spanContext().spanId, s);

  const children = new Map<string, ReadableSpan[]>();
  const roots: ReadableSpan[] = [];
  for (const s of spans) {
    const parentId = s.parentSpanContext?.spanId;
    // A span whose parent is not in this set is a root for rendering purposes.
    // That happens legitimately: the web app starts a job without awaiting it,
    // so its parent request span may have ended elsewhere.
    if (parentId && byId.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(s);
      children.set(parentId, list);
    } else {
      roots.push(s);
    }
  }

  roots.sort(compareStart);
  for (const list of children.values()) list.sort(compareStart);

  // Subtree totals, computed once per span rather than re-walked per line.
  const totals = new Map<string, Totals>();
  function totalFor(span: ReadableSpan): Totals {
    const id = span.spanContext().spanId;
    const cached = totals.get(id);
    if (cached) return cached;
    const t: Totals = {
      input: num(span, GEN_AI_USAGE_INPUT_TOKENS) ?? 0,
      output: num(span, GEN_AI_USAGE_OUTPUT_TOKENS) ?? 0,
      cacheRead: num(span, GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS) ?? 0,
      usd: num(span, PAPERCAST_COST_USD) ?? 0,
    };
    for (const child of children.get(id) ?? []) {
      const c = totalFor(child);
      t.input += c.input;
      t.output += c.output;
      t.cacheRead += c.cacheRead;
      t.usd += c.usd;
    }
    totals.set(id, t);
    return t;
  }

  const rows: { label: string; detail: string }[] = [];

  function walk(
    span: ReadableSpan,
    prefix: string,
    isLast: boolean,
    depth: number,
  ): void {
    const branch = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
    const schema = span.attributes[PAPERCAST_SCHEMA] ?? span.attributes[PAPERCAST_TASK];
    const name = schema ? `${span.name}  ${String(schema)}` : span.name;
    const failed = span.status.code === SpanStatusCode.ERROR;

    const t = totalFor(span);
    const parts = [secs(durationMs(span))];
    if (t.input || t.output) parts.push(`${count(t.input)} in → ${count(t.output)} out`);
    if (t.cacheRead) parts.push(`${count(t.cacheRead)} cached`);
    const money = usd(t.usd);
    if (money) parts.push(money);
    if (failed) parts.push(`✗ ${String(span.attributes[ATTR_ERROR_TYPE] ?? "error")}`);

    // A rejected attempt does not throw — the provider retries instead — so it
    // has no error status and would otherwise render as an unremarkable span
    // that merely took a while. The reason it was rejected is the whole point
    // of splitting attempts out at all.
    const rejected = span.attributes[PAPERCAST_VALIDATION_ERROR];
    if (rejected) parts.push(`✗ rejected: ${String(rejected)}`);

    rows.push({ label: `${prefix}${branch}${name}`, detail: parts.join("  ") });

    const kids = children.get(span.spanContext().spanId) ?? [];
    const childPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : "│  ");
    kids.forEach((k, i) => walk(k, childPrefix, i === kids.length - 1, depth + 1));
  }

  roots.forEach((r, i) => walk(r, "", i === roots.length - 1, 0));

  const width = Math.min(60, Math.max(...rows.map((r) => r.label.length)));
  const body = rows
    .map((r) => `${r.label.padEnd(width)}  ${r.detail}`.trimEnd())
    .join("\n");

  return `\n── TRACE ${"─".repeat(58)}\n${body}\n`;
}
