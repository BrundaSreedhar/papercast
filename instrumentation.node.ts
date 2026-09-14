/**
 * Tracing for the web app. Node runtime only — see instrumentation.ts.
 *
 * Next instruments its own requests, so with a global tracer provider
 * registered, a job's spans nest under Next's server span without any change
 * to the route handlers.
 *
 * Two ways to see them, and they are for different questions. An OTLP endpoint
 * sends the whole tree somewhere it can be explored, which is what you want
 * when something is slow and you do not know why. `TRACE_LOG=1` prints each
 * span as it finishes in the terminal beside the server, which is what you want
 * when you only need to know which model was just called and what it cost.
 */
import {
  initTracing,
  shutdownTracing,
  tracingDestinationConfigured,
} from "./lib/trace/index";

const toConsole = process.env.TRACE_LOG?.trim() === "1";

// An OTLP endpoint, a LangSmith key or a detail-log path all count: each is
// somewhere for spans to go, and none of them should need a second switch.
if (tracingDestinationConfigured()) {
  initTracing({
    serviceName: "paper-to-podcast-web",
    waterfall: false,
    // The one place in this path that prints. Nothing under lib/ does.
    ...(toConsole ? { log: (line: string) => console.log(line) } : {}),
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void shutdownTracing().then(() => process.exit(0)));
  }
}
