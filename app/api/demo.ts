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
  new DemoGate({ concurrentJobs: cfg.concurrentJobs, dailyJobs: cfg.dailyJobs });
globalForGate.papercastGate = gate;

export const demo = cfg;
