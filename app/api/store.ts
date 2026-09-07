import { MemoryJobStore, type JobStore } from "@/lib/jobs/store";

/**
 * One store for the whole server process.
 *
 * Module state is shared across route handlers in a single Node process, which
 * is what this relies on. It is also why the app must run on a long-lived
 * server rather than serverless functions: separate invocations would each get
 * their own empty store, and a job started by one would be invisible to the
 * next. The same constraint applies to the work itself, which outlives any
 * reasonable function timeout.
 */
const globalForStore = globalThis as unknown as { papercastStore?: JobStore };

export const store: JobStore = globalForStore.papercastStore ?? new MemoryJobStore();
// Survive the module reloads that happen during development.
globalForStore.papercastStore = store;
