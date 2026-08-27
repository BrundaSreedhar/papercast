/**
 * How a command starts and how it dies.
 *
 * Every CLI here ended with the same four lines — catch, print, exit — copied
 * verbatim five times. Tracing forced the issue: `process.exit()` discards
 * whatever the span processor has buffered, and `beforeExit` does not fire on
 * an explicit exit, so without a flush the traces would vanish on exactly the
 * runs worth tracing. Fixing that in five places was the wrong shape, so the
 * tail lives here once.
 *
 * This is also the boundary where a rendered trace becomes console output.
 * Nothing under `lib/` prints; `shutdownTracing` hands back a string and this
 * decides what to do with it.
 */
import { initTracing, shutdownTracing } from "../lib/trace/index";

/** Run a command's main, then flush tracing and exit with the right code. */
export function runEntry(main: () => Promise<void>): void {
  const argv = process.argv.slice(2);

  if (argv.includes("--trace")) {
    initTracing({
      waterfall: true,
      capturePayloads: argv.includes("--trace-payloads"),
    });
  }

  const finish = async (code: number): Promise<never> => {
    // Resolves immediately when tracing was never started.
    const report = await shutdownTracing();
    if (report) process.stdout.write(report);
    process.exit(code);
  };

  main().then(
    () => finish(0),
    (err) => {
      console.error("\n❌  Failed:", err instanceof Error ? err.message : err);
      // The trace is most valuable precisely here, so it is flushed on the
      // failure path too — including the span that recorded the failure.
      return finish(1);
    },
  );
}
