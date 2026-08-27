import type { Usage } from "./types";

/**
 * Add up token usage across calls.
 *
 * Every multi-call flow — the three judge passes, the refine loop, a job that
 * scripts and then repairs — needs to report one total. Each had grown its own
 * copy of this; there is only one sensible definition, so it lives here.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  };
}
