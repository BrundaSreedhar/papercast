import type { Episode } from "../llm/schema";
import type { TurnTiming } from "../tts/types";
import type { TurnCitation } from "../ground/index";

/**
 * Stages a job moves through, in order. Generation and synthesis each take tens
 * of seconds, which is why the work is a job with a timeline rather than a
 * request that blocks: a minute of silence is indistinguishable from a hang.
 */
export const STAGES = [
  "queued",
  "parsing",
  "scripting",
  "reviewing",
  "synthesizing",
  "verifying",
  "done",
] as const;

export type JobStage = (typeof STAGES)[number] | "error";

/**
 * Relative cost of each stage, from measured runs: parsing is near-instant,
 * scripting around 50 seconds, review roughly as long again (it grades the
 * script, rewrites the bad turns, then grades it a second time), synthesis
 * around 35, and verification roughly as long as synthesis. Weighting by real
 * cost keeps the reported percentage honest instead of jumping in equal steps.
 *
 * These are weights, not percentages. A run that skips review or verification
 * renormalizes over the stages it will actually pass through — see
 * `activeStages` — so the bar still ends at 100 without a jump at the finish.
 */
export const STAGE_WEIGHTS: Record<Exclude<JobStage, "error">, number> = {
  queued: 0,
  parsing: 3,
  scripting: 34,
  reviewing: 28,
  synthesizing: 24,
  verifying: 11,
  done: 0,
};

/** Which stages a run will actually pass through, given what it was asked for. */
export function activeStages(opts: {
  revise: boolean;
  audio: boolean;
  verify: boolean;
}): readonly JobStage[] {
  return STAGES.filter(
    (s) =>
      (s !== "reviewing" || opts.revise) &&
      (s !== "synthesizing" || opts.audio) &&
      (s !== "verifying" || (opts.audio && opts.verify)),
  );
}

export interface JobEvent {
  at: number;
  stage: JobStage;
  /** Overall completion, 0–100. */
  percent: number;
  message: string;
}

export interface JobCost {
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCachedTokens: number;
  ttsCalls: number;
  usd?: number;
}

/** Outcome of the fact-check-and-repair pass, when it ran. */
export interface JobReview {
  /** Faithfulness of the script as first written, 0–1. */
  faithfulnessBefore: number;
  /** Faithfulness of the script that was kept, 0–1. */
  faithfulnessAfter: number;
  /** Unsupported or contradicted claims before repair, and in the kept script. */
  failuresBefore: number;
  failuresAfter: number;
  /** Turn indices rewritten in the kept script. */
  revisedTurns: number[];
  /** Revision rounds attempted. */
  rounds: number;
  /** False when no revision beat the original and it was kept as written. */
  improved: boolean;
}

export interface JobResult {
  episode: Episode;
  /** Present when the job was asked to fact-check and repair the script. */
  review?: JobReview;
  /**
   * Why the fact-check did not complete, when it was asked for and failed. The
   * episode is still delivered; this says plainly that it went unchecked rather
   * than letting the absence of a review look like a clean bill of health.
   */
  reviewError?: JobError;
  /**
   * Where each turn came from in the paper, when it could be placed.
   *
   * Computed by lexical matching on every run — no model call, no API key, and
   * nothing to do with the eval harness. Turns that cannot be placed
   * confidently are absent rather than pointed at the wrong page.
   */
  citations?: TurnCitation[];
  audioPath?: string;
  timings?: TurnTiming[];
  totalMs?: number;
  /** Share of the script recognized in the audio, when verification ran. */
  transcriptRecall?: number;
}

export interface JobError {
  /** Stable identifier a client can branch on. */
  code: string;
  /** Safe to show a user: no stack traces, no credentials. */
  message: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
  /**
   * The stage the job was in when it failed.
   *
   * Terminal state overwrites `stage` with "error", so without this the one
   * fact a person always wants — where did it break — is the one fact the
   * failure does not carry.
   */
  failedStage?: JobStage;
  /**
   * Short reference printed in the server log beside the full error.
   *
   * The detail cannot travel to a browser, but "something went wrong" with no
   * way to find the real cause is not a diagnosis either. This is the handle
   * that connects the two without leaking anything.
   */
  ref?: string;
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: JobStage;
  percent: number;
  paperTitle?: string;
  options: { minutes: number; provider?: string; verify: boolean; revise?: boolean };
  cost: JobCost;
  events: JobEvent[];
  result?: JobResult;
  error?: JobError;
}

export function isTerminal(stage: JobStage): boolean {
  return stage === "done" || stage === "error";
}

/**
 * Overall percentage given the stage, how far through it we are, and which
 * stages this particular run includes.
 */
export function overallPercent(
  stage: JobStage,
  withinStage = 0,
  active: readonly JobStage[] = STAGES,
): number {
  if (stage === "error") return 100;
  if (stage === "done") return 100;

  const stages = active.includes(stage) ? active : STAGES;
  let before = 0;
  let total = 0;
  let reached = false;
  for (const s of stages) {
    if (s === "error") continue;
    if (s === stage) reached = true;
    else if (!reached) before += STAGE_WEIGHTS[s];
    total += STAGE_WEIGHTS[s];
  }
  if (total === 0) return 0;

  const clamped = Math.min(1, Math.max(0, withinStage));
  return Math.round(((before + STAGE_WEIGHTS[stage] * clamped) / total) * 100);
}
