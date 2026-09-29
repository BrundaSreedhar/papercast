/**
 * Turning tracing on, and getting the spans out before the process dies.
 *
 * Built on `NodeTracerProvider` from the stable 2.x line rather than `NodeSDK`,
 * which is still 0.x and brings metrics and logs we do not want. Fifteen lines
 * of configuration buys exactly the trace signal.
 *
 * `provider.register()` does more than it looks like: it installs an
 * `AsyncLocalStorageContextManager` and the W3C propagators globally. That is
 * what makes span nesting automatic, so nothing in the pipeline has to thread a
 * span through its call chain.
 */
// Importing the config module runs dotenv, so OTEL_* vars in .env are visible
// below. The ordering is load-bearing, so it is stated rather than assumed.
import "../config/env";
import { context, trace } from "@opentelemetry/api";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "./attributes";
import { setCapturePayloads, setEnabled } from "./tracer";
import { WaterfallProcessor } from "./waterfall";
import { LogProcessor } from "./log";
import { DetailProcessor, fileSink, type DetailSink } from "./detail";
import { langsmithConfig, langsmithExporterOptions } from "./langsmith";

export interface InitOptions {
  serviceName?: string;
  /**
   * Collect spans for an end-of-run waterfall. Right for a CLI, wrong for a
   * server: a long-lived process would accumulate spans forever and never
   * reach the point where they get rendered.
   */
  waterfall?: boolean;
  capturePayloads?: boolean;
  /**
   * Print each span as it finishes, through this sink.
   *
   * For a server, where a waterfall never gets rendered and an OTLP collector
   * is more setup than someone wants in order to see which model was called.
   */
  log?: (line: string) => void;
  /**
   * Write every span in full, as JSON, through this sink.
   *
   * Defaults to a file named by `TRACE_DETAIL_FILE`. Separate from `log`
   * because they answer different questions: one is a line to glance at while
   * a server runs, this is the record to read afterwards.
   */
  detail?: DetailSink;
  /** Test seam — extra processors, e.g. an in-memory exporter. */
  processors?: SpanProcessor[];
}

let provider: NodeTracerProvider | undefined;
let waterfall: WaterfallProcessor | undefined;

/** True when an OTLP endpoint is configured, by either standard env var. */
function otlpConfigured(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(),
  );
}

/**
 * Whether anything is configured that spans could be sent to.
 *
 * Both entrypoints used to test for an OTLP endpoint by hand, which meant a
 * LangSmith key or a detail-log path did nothing until someone also passed
 * `--trace`. Setting a key is a clear enough statement of intent.
 */
export function tracingDestinationConfigured(): boolean {
  return Boolean(
    otlpConfigured() ||
    langsmithConfig() ||
    process.env.TRACE_DETAIL_FILE?.trim() ||
    process.env.TRACE_LOG?.trim() === "1",
  );
}

/** A file sink when TRACE_DETAIL_FILE names one, and nothing otherwise. */
function detailFileSink(): DetailSink | undefined {
  const path = process.env.TRACE_DETAIL_FILE?.trim();
  return path ? fileSink(path) : undefined;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Idempotent: initializing twice keeps the first provider. */
export function initTracing(opts: InitOptions = {}): void {
  if (provider) return;
  // The standard OTel kill switch. NodeSDK honours it for you; a hand-built
  // provider has to check it.
  if (envFlag("OTEL_SDK_DISABLED")) return;

  const processors: SpanProcessor[] = [];

  if (opts.waterfall) {
    waterfall = new WaterfallProcessor();
    processors.push(waterfall);
  }

  if (opts.log) processors.push(new LogProcessor(opts.log));

  const detail = opts.detail ?? detailFileSink();
  if (detail) processors.push(new DetailProcessor(detail));

  // Only when an endpoint is actually configured. The exporter defaults to
  // http://localhost:4318 when constructed bare, so building it
  // unconditionally would leave a machine with no collector retrying refused
  // connections in the background for the whole run.
  if (otlpConfigured()) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  // LangSmith is reached over the same OTLP the rest of this speaks, so it is
  // an exporter rather than an integration. A second one: a run can land in
  // LangSmith and in a local Grafana at once, which is the point of having
  // written the spans to a spec instead of to a vendor.
  const langsmith = langsmithConfig();
  if (langsmith) {
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter(langsmithExporterOptions(langsmith))),
    );
  }

  if (opts.processors) processors.push(...opts.processors);
  if (processors.length === 0) return;

  provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]:
          opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "paper-to-podcast",
        [ATTR_SERVICE_VERSION]: "2.0.0",
      }),
    ),
    // Not `addSpanProcessor` — that method no longer exists on the 2.x
    // provider. Passing an array is also why the waterfall and OTLP export can
    // both be live at once: they are simply two entries.
    spanProcessors: processors,
  });
  provider.register();

  setEnabled(true);
  setCapturePayloads(
    opts.capturePayloads ?? envFlag("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"),
  );
}

/**
 * Flush everything and return the rendered waterfall, if one was collected.
 *
 * Returning the string rather than printing it is deliberate: nothing under
 * `lib/` writes to the console. The caller — an entrypoint — decides.
 */
export async function shutdownTracing(): Promise<string | undefined> {
  if (!provider) return undefined;

  const p = provider;
  const w = waterfall;
  provider = undefined;
  waterfall = undefined;
  setEnabled(false);
  setCapturePayloads(false);

  try {
    await p.forceFlush();
    await p.shutdown();
  } catch {
    // A collector that went away must not take the run down with it — and the
    // waterfall below is still worth printing.
  }

  // Without disabling the globals, a second initTracing in the same process
  // (every test after the first) is refused and silently keeps the old
  // provider, which makes for a baffling afternoon.
  trace.disable();
  context.disable();

  const report = w?.render();
  return report && report.trim() ? report : undefined;
}

/** Whether tracing has been initialized in this process. */
export function isInitialized(): boolean {
  return provider !== undefined;
}
