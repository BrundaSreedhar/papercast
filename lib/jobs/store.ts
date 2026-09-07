/**
 * Where jobs live, and the seam a database slots into.
 *
 * The interface is asynchronous even though the only implementation here keeps
 * everything in a Map, because the point of an interface is the implementation
 * that does not exist yet. A store backed by Postgres answers over a network,
 * and callers written against a synchronous `get` would have to be rewritten
 * line by line the day that changed. Paying for it now costs an `await` per
 * call site and nothing else.
 *
 * Jobs are still lost on restart. That remains the honest trade for a demo —
 * but it is now a property of this implementation rather than of the shape of
 * the code above it.
 */
import { randomUUID } from "node:crypto";
import {
  isTerminal,
  type Job,
  type JobCost,
  type JobError,
  type JobEvent,
  type JobResult,
  type JobStage,
} from "./types";

export type JobListener = (job: Job, event: JobEvent) => void;

/** Undoes a `subscribe`. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * What one progress report can change. Everything is optional because most
 * updates touch a single field: a percentage, or a message, or the result.
 */
export interface JobPatch {
  stage?: JobStage;
  percent?: number;
  paperTitle?: string;
  result?: JobResult;
  error?: JobError;
  /** What to say in the event this update records. Defaults to the stage. */
  message?: string;
  cost?: Partial<JobCost>;
}

/**
 * The contract every store honours.
 *
 * `get` returns a snapshot, not a live handle. The in-memory store happens to
 * hand back the object it is holding, but no caller may rely on that: a stored
 * job read a second time is a second read, and a database will never behave any
 * other way.
 */
export interface JobStore {
  create(options: Job["options"]): Promise<Job>;
  get(id: string): Promise<Job | undefined>;
  list(): Promise<Job[]>;
  /** Record progress and notify subscribers. Undefined if the job is gone. */
  update(id: string, patch: JobPatch): Promise<Job | undefined>;
  /**
   * Watch a job's progress. Events already recorded are replayed first, so a
   * client that connects late still sees the whole story rather than joining
   * midway with no idea what happened.
   */
  subscribe(id: string, fn: JobListener): Promise<Unsubscribe>;
}

/**
 * Jobs in a Map, with in-process subscriptions.
 *
 * The simplest thing that satisfies the interface, and the one the tests and
 * the CLI use so that neither needs a database to run.
 */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<JobListener>>();

  /** Jobs older than this are dropped, so a long-running process stays bounded. */
  constructor(private readonly maxAgeMs = 60 * 60 * 1000) {}

  async create(options: Job["options"]): Promise<Job> {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      stage: "queued",
      percent: 0,
      options,
      cost: { llmInputTokens: 0, llmOutputTokens: 0, llmCachedTokens: 0, ttsCalls: 0 },
      events: [],
    };
    this.jobs.set(job.id, job);
    this.evict();
    return job;
  }

  async get(id: string): Promise<Job | undefined> {
    return this.jobs.get(id);
  }

  async list(): Promise<Job[]> {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(id: string, patch: JobPatch): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;

    if (patch.stage) job.stage = patch.stage;
    if (patch.percent !== undefined) job.percent = patch.percent;
    if (patch.paperTitle) job.paperTitle = patch.paperTitle;
    if (patch.result) job.result = patch.result;
    if (patch.error) job.error = patch.error;
    if (patch.cost) Object.assign(job.cost, patch.cost);
    job.updatedAt = Date.now();

    const event: JobEvent = {
      at: job.updatedAt,
      stage: job.stage,
      percent: job.percent,
      message: patch.message ?? job.stage,
    };
    job.events.push(event);

    for (const fn of this.listeners.get(id) ?? []) fn(job, event);
    if (isTerminal(job.stage)) this.listeners.delete(id);
    return job;
  }

  async subscribe(id: string, fn: JobListener): Promise<Unsubscribe> {
    const job = this.jobs.get(id);
    if (!job) return () => {};
    for (const e of job.events) fn(job, e);
    if (isTerminal(job.stage)) return () => {};

    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => {
      set.delete(fn);
    };
  }

  private evict(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, job] of this.jobs) {
      if (job.createdAt < cutoff) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }
}

export type { Job, JobEvent, JobStage };
