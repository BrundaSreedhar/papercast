/**
 * Tracing for the web app. Node runtime only — see instrumentation.ts.
 *
 * Next instruments its own requests, so with a global tracer provider
 * registered, a job's spans nest under Next's server span without any change
 * to the route handlers.
 */
import { initTracing, shutdownTracing } from "./lib/trace/index";

if (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
) {
  initTracing({ serviceName: "paper-to-podcast-web", waterfall: false });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void shutdownTracing().then(() => process.exit(0)));
  }
}
