/**
 * What stops a public URL from being an open tap on somebody's API key.
 *
 * Two limits, for two different failures. A concurrency limit protects the
 * machine: synthesis holds a neural voice model in memory, and a second
 * episode starting beside the first is how a small container dies rather than
 * how it serves two visitors. A daily limit protects the bill, and is the one
 * that matters when a link is passed around.
 *
 * Both limits are counted per kind of work, because an episode and a question
 * cost different amounts and failing one should not close the other. An
 * episode is minutes of model time and a dozen synthesis calls; a question is
 * a handful of calls from the agent as it reads the paper. Counting them
 * together would mean either a question allowance so small it is useless or an
 * episode allowance large enough to be expensive. Counting them separately
 * also keeps the demo's best part working after the expensive part is spent:
 * when today's episodes are gone, the ones already on the shelf can still be
 * listened to and asked about.
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
  concurrentQuestions: number;
  dailyQuestions: number;
}

/** The two things a visitor can spend the deployment's credentials on. */
export type DemoWork = "job" | "question";

export type Admission =
  { ok: true } | { ok: false; status: number; message: string; remedy?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

interface Ceilings {
  concurrent: number;
  daily: number;
}

/** What each kind of work is called and how a visitor is told it ran out. */
const WORDING: Record<
  DemoWork,
  { busy: string; busyRemedy: string; spent: string; noun: string }
> = {
  job: {
    busy: "An episode is already being made.",
    busyRemedy: "This demo makes one at a time. Try again in a minute or two.",
    spent: "The demo has made its episodes for today.",
    noun: "episodes",
  },
  question: {
    busy: "Another question is being answered right now.",
    busyRemedy: "This demo answers a couple at a time. Try again in a moment.",
    spent: "The demo has answered its questions for today.",
    noun: "questions",
  },
};

export class DemoGate {
  private readonly running: Record<DemoWork, number> = { job: 0, question: 0 };
  private readonly startedInWindow: Record<DemoWork, number> = { job: 0, question: 0 };
  private windowStart = 0;

  constructor(private readonly limits: DemoLimits) {}

  private ceilings(kind: DemoWork): Ceilings {
    return kind === "job"
      ? { concurrent: this.limits.concurrentJobs, daily: this.limits.dailyJobs }
      : {
          concurrent: this.limits.concurrentQuestions,
          daily: this.limits.dailyQuestions,
        };
  }

  /**
   * Admit a piece of work and count it, or explain why not.
   *
   * The window is shared by both kinds and rolls for whichever asks first,
   * which keeps "today" meaning one thing rather than two drifting clocks.
   */
  admit(kind: DemoWork, now: number = Date.now()): Admission {
    if (now - this.windowStart >= DAY_MS) {
      this.windowStart = now;
      this.startedInWindow.job = 0;
      this.startedInWindow.question = 0;
    }

    const { concurrent, daily } = this.ceilings(kind);
    const words = WORDING[kind];

    if (this.running[kind] >= concurrent) {
      return {
        ok: false,
        status: 429,
        message: words.busy,
        remedy: words.busyRemedy,
      };
    }

    if (this.startedInWindow[kind] >= daily) {
      const hours = Math.max(
        1,
        Math.ceil((this.windowStart + DAY_MS - now) / (60 * 60 * 1000)),
      );
      return {
        ok: false,
        status: 429,
        message: words.spent,
        remedy: `The daily limit exists so a public link cannot run up a bill. It resets in about ${hours} hour${hours === 1 ? "" : "s"}, and the repository runs without any limit at all.`,
      };
    }

    this.running[kind] += 1;
    this.startedInWindow[kind] += 1;
    return { ok: true };
  }

  /** Called when a piece of work ends, however it ended. */
  release(kind: DemoWork): void {
    this.running[kind] = Math.max(0, this.running[kind] - 1);
  }

  /** For the health endpoint: what the gate is currently holding. */
  status(now: number = Date.now()): {
    running: Record<DemoWork, number>;
    startedToday: Record<DemoWork, number>;
    limits: DemoLimits;
  } {
    const stale = now - this.windowStart >= DAY_MS;
    return {
      running: { ...this.running },
      startedToday: stale ? { job: 0, question: 0 } : { ...this.startedInWindow },
      limits: this.limits,
    };
  }
}
