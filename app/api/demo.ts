import { NextResponse } from "next/server";
import { demoConfig } from "@/lib/config/env";
import { DemoGate } from "@/lib/demo/index";

/**
 * One gate for the whole server process, for the same reason the job store is:
 * a limit that each request re-creates is not a limit. See `./store`.
 */
const cfg = demoConfig();
const globalForGate = globalThis as unknown as { papercastGate?: DemoGate };

export const gate =
  globalForGate.papercastGate ??
  new DemoGate({
    concurrentJobs: cfg.concurrentJobs,
    dailyJobs: cfg.dailyJobs,
    concurrentQuestions: cfg.concurrentQuestions,
    dailyQuestions: cfg.dailyQuestions,
  });
globalForGate.papercastGate = gate;

export const demo = cfg;

/**
 * Take a slot for a question, or the response that says why not.
 *
 * Every route that answers a question spends the deployment's credentials, so
 * each one has to ask; returning the refusal ready-made keeps the three of
 * them from wording the same limit three different ways. Off demo mode it
 * admits everything and holds nothing, so a local run is unaffected.
 */
export function admitQuestion(): { refusal: NextResponse | null; done: () => void } {
  if (!demo.enabled) return { refusal: null, done: () => {} };

  const admission = gate.admit("question");
  if (!admission.ok) {
    return {
      refusal: NextResponse.json(
        { error: admission.message, remedy: admission.remedy },
        { status: admission.status },
      ),
      done: () => {},
    };
  }

  // Released once, however the answer ends: a slot leaked here is a demo that
  // refuses every later question until the process restarts.
  let released = false;
  return {
    refusal: null,
    done: () => {
      if (released) return;
      released = true;
      gate.release("question");
    },
  };
}
