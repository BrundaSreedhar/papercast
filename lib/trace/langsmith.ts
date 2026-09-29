/**
 * Sending the traces this project already emits to LangSmith.
 *
 * No SDK, and no second instrumentation path. LangSmith accepts OTLP over HTTP
 * and reads the GenAI semantic conventions, which is exactly what every span
 * here already carries — so this is an endpoint and two headers rather than a
 * client library, a wrapper for every call site, and a second set of names for
 * the same numbers.
 *
 * That is the same reason Jaeger and Grafana work: the spans were never written
 * for a particular backend. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` by hand still
 * works and still wins — this only spares anyone hand-assembling an
 * `x-api-key` header out of documentation.
 *
 * What LangSmith adds on top of the conventions is its own small vocabulary —
 * tags, metadata, a run name — and those are plain span attributes under a
 * `langsmith.` prefix. They are set here and nowhere else, so the rest of the
 * project stays free of any one vendor's names.
 */
import type { Attributes, Span } from "@opentelemetry/api";

/** LangSmith's OTLP collector. The exporter appends `/v1/traces`. */
export const LANGSMITH_ENDPOINT = "https://api.smith.langchain.com/otel";

/** Free-text labels LangSmith shows on a run and lets you filter by. */
export const LANGSMITH_TAGS = "langsmith.span.tags";
/** Prefix for arbitrary key/values LangSmith shows beside a run. */
export const LANGSMITH_METADATA = "langsmith.metadata";
/** Overrides the displayed run name, which otherwise is the span name. */
export const LANGSMITH_RUN_NAME = "langsmith.trace.name";
/** Groups runs that belong to one conversation. */
export const LANGSMITH_SESSION = "langsmith.metadata.session_id";

export interface LangsmithConfig {
  apiKey: string;
  project: string;
  endpoint: string;
}

/**
 * LangSmith settings, or undefined when no key is configured.
 *
 * Reads the same variable names LangSmith's own tooling uses, so a machine
 * already set up for it needs nothing new. `LANGCHAIN_` is the older spelling
 * and is still what a lot of existing `.env` files carry.
 */
export function langsmithConfig(): LangsmithConfig | undefined {
  const apiKey = (
    process.env.LANGSMITH_API_KEY ??
    process.env.LANGCHAIN_API_KEY ??
    ""
  ).trim();
  if (!apiKey) return undefined;

  // Tracing is opt-out rather than opt-in once a key exists: someone who has
  // set a key has said what they want. "false" and "0" turn it back off.
  const flag = (process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2 ?? "")
    .trim()
    .toLowerCase();
  if (flag === "false" || flag === "0") return undefined;

  return {
    apiKey,
    project: (
      process.env.LANGSMITH_PROJECT ??
      process.env.LANGCHAIN_PROJECT ??
      "papercast"
    ).trim(),
    endpoint: (
      process.env.LANGSMITH_ENDPOINT ??
      process.env.LANGCHAIN_ENDPOINT ??
      LANGSMITH_ENDPOINT
    ).trim(),
  };
}

/**
 * The exporter settings for a LangSmith config.
 *
 * Returned rather than applied to `process.env`, so the caller decides and a
 * test can read them without mutating the environment it runs in.
 */
export function langsmithExporterOptions(cfg: LangsmithConfig): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: `${cfg.endpoint.replace(/\/$/, "")}/v1/traces`,
    headers: {
      "x-api-key": cfg.apiKey,
      // Which project the run lands in. LangSmith reads this per request, so
      // one deployment can send different runs to different projects.
      "Langsmith-Project": cfg.project,
    },
  };
}

/**
 * Tags for a span, in the form LangSmith reads.
 *
 * Comma-separated rather than a JSON array because that is what its OTLP
 * mapping accepts, and blanks are dropped so a caller can pass an optional
 * value without composing the string itself.
 */
export function tags(...values: (string | undefined | false)[]): Attributes {
  const kept = values.filter((v): v is string => Boolean(v && v.trim()));
  return kept.length ? { [LANGSMITH_TAGS]: kept.join(",") } : {};
}

/** Metadata for a span, under the prefix LangSmith expects. */
export function metadata(
  values: Record<string, string | number | boolean | undefined>,
): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    out[`${LANGSMITH_METADATA}.${key}`] = value;
  }
  return out;
}

/** Name a run, and tag it, on a span that already exists. */
export function label(
  span: Span,
  name: string,
  ...values: (string | undefined | false)[]
): void {
  span.setAttribute(LANGSMITH_RUN_NAME, name);
  const t = tags(...values);
  for (const [key, value] of Object.entries(t)) span.setAttribute(key, value!);
}
