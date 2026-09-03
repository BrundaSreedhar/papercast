/**
 * What stops a public URL from being an open tap on somebody's API key.
 *
 * Two limits, for two different failures. A concurrency limit protects the
 * machine: synthesis holds a neural voice model in memory, and a second
 * episode starting beside the first is how a small container dies rather than
 * how it serves two visitors. A daily limit protects the bill, and is the one
 * that matters when a link is passed around.
 *
 * Refusal is deliberately explicit. A demo that silently queues looks broken,
 * and one that silently degrades teaches the visitor nothing, so both limits
 * come back as a message saying which ceiling was hit and when to come back.
 *
 * Time is a parameter rather than a call to `Date.now`, so the rolling window
 * can be tested without waiting a day or mocking the clock.
 */
export interface DemoLimits {
  concurrentJobs: number;
  dailyJobs: number;
}

export type Admission =
  { ok: true } | { ok: false; status: number; message: string; remedy?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export class DemoGate {
  private running = 0;
  private windowStart = 0;
  private startedInWindow = 0;

  constructor(private readonly limits: DemoLimits) {}

  /** Admit a job and count it, or explain why not. */
  admit(now: number = Date.now()): Admission {
    if (now - this.windowStart >= DAY_MS) {
      this.windowStart = now;
      this.startedInWindow = 0;
    }

    if (this.running >= this.limits.concurrentJobs) {
      return {
        ok: false,
        status: 429,
        message: "An episode is already being made.",
        remedy: "This demo runs one at a time. Try again in a minute or two.",
      };
    }

    if (this.startedInWindow >= this.limits.dailyJobs) {
      const hours = Math.max(
        1,
        Math.ceil((this.windowStart + DAY_MS - now) / (60 * 60 * 1000)),
      );
      return {
        ok: false,
        status: 429,
        message: "The demo has made its episodes for today.",
        remedy: `The daily limit exists so a public link cannot run up a bill. It resets in about ${hours} hour${hours === 1 ? "" : "s"}, and the repository runs without any limit at all.`,
      };
    }

    this.running += 1;
    this.startedInWindow += 1;
    return { ok: true };
  }

  /** Called when a job ends, however it ended. */
  release(): void {
    this.running = Math.max(0, this.running - 1);
  }

  /** For the health endpoint: what the gate is currently holding. */
  status(now: number = Date.now()): {
    running: number;
    startedToday: number;
    limits: DemoLimits;
  } {
    const stale = now - this.windowStart >= DAY_MS;
    return {
      running: this.running,
      startedToday: stale ? 0 : this.startedInWindow,
      limits: this.limits,
    };
  }
}
