/**
 * Next's own hook for starting instrumentation, called once at boot.
 *
 * The runtime guard is required, not defensive: the tracer is built on
 * `NodeTracerProvider`, which cannot run on the edge runtime, so the real setup
 * lives behind a dynamic import that only the Node runtime reaches.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
