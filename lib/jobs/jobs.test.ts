/**
 * The job layer's job is to report honestly on work that takes a minute. What
 * matters is that progress only moves forward, that a client connecting late
 * still learns what happened, and that a failure reaching a browser says
 * something useful without leaking internals.
 */
import { describe, it, expect } from "vitest";
import { JobStore } from "./store";
import { activeStages, overallPercent, isTerminal, STAGE_WEIGHTS, STAGES } from "./types";
import { toJobError } from "./errors";
import { ContextTruncationError } from "../llm/contextGuard";
import { OutputTruncationError } from "../llm/errors";

const opts = { minutes: 4, verify: false };

describe("overallPercent", () => {
  it("weights stages by how long they actually take", () => {
    // Scripting is the single most expensive stage, and parsing is near-free.
    expect(STAGE_WEIGHTS.scripting).toBeGreaterThan(STAGE_WEIGHTS.synthesizing);
    expect(overallPercent("parsing", 1)).toBeLessThan(10);
  });

  it("passes halfway once the script is written, on a transcript-only run", () => {
    const stages = activeStages({ revise: false, audio: false, verify: false });
    expect(overallPercent("scripting", 1, stages)).toBeGreaterThan(45);
  });

  it("never goes backwards across the stage order", () => {
    let prev = -1;
    for (const s of STAGES) {
      const p = overallPercent(s, 0);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("interpolates within a stage", () => {
    const a = overallPercent("synthesizing", 0);
    const b = overallPercent("synthesizing", 0.5);
    const c = overallPercent("synthesizing", 1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("clamps a nonsensical fraction rather than exceeding the stage", () => {
    expect(overallPercent("parsing", 5)).toBe(overallPercent("parsing", 1));
    expect(overallPercent("parsing", -3)).toBe(overallPercent("parsing", 0));
  });

  it("reports completion for terminal stages", () => {
    expect(overallPercent("done")).toBe(100);
    expect(overallPercent("error")).toBe(100);
  });

  it("has weights that sum to a full timeline", () => {
    const total = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  /**
   * A run that skips review or verification used to leave the bar short and
   * then jump to 100 at the end. Percentages are normalized over the stages the
   * run will actually pass through, so the last stage really does finish at 100.
   */
  it("finishes at 100 on the last stage a run actually reaches", () => {
    expect(
      overallPercent("scripting", 1, activeStages({ revise: false, audio: false, verify: false })),
    ).toBe(100);
    expect(
      overallPercent("synthesizing", 1, activeStages({ revise: false, audio: true, verify: false })),
    ).toBe(100);
    expect(
      overallPercent("reviewing", 1, activeStages({ revise: true, audio: false, verify: false })),
    ).toBe(100);
    expect(
      overallPercent("verifying", 1, activeStages({ revise: true, audio: true, verify: true })),
    ).toBe(100);
  });

  it("never goes backwards within a run that reviews and verifies", () => {
    const stages = activeStages({ revise: true, audio: true, verify: true });
    let prev = -1;
    for (const s of stages) {
      const p = overallPercent(s, 0, stages);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("leaves room for the stages still to come when review is on", () => {
    const stages = activeStages({ revise: true, audio: true, verify: true });
    expect(overallPercent("scripting", 1, stages)).toBeLessThan(
      overallPercent("reviewing", 1, stages),
    );
  });

  it("falls back to the full timeline for a stage the run said it would skip", () => {
    // Defensive: reporting an inactive stage should still produce a sane number
    // rather than dividing by a total that does not include it.
    const stages = activeStages({ revise: false, audio: false, verify: false });
    const p = overallPercent("verifying", 1, stages);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(100);
  });
});

describe("activeStages", () => {
  it("drops review when the run was not asked to fact-check", () => {
    expect(activeStages({ revise: false, audio: true, verify: true })).not.toContain("reviewing");
    expect(activeStages({ revise: true, audio: true, verify: true })).toContain("reviewing");
  });

  it("drops synthesis and verification for a transcript-only run", () => {
    const stages = activeStages({ revise: false, audio: false, verify: true });
    expect(stages).not.toContain("synthesizing");
    // Verification checks audio, so it cannot happen without audio.
    expect(stages).not.toContain("verifying");
  });

  it("keeps the canonical stage order", () => {
    const stages = activeStages({ revise: true, audio: true, verify: true });
    expect([...stages]).toEqual([...STAGES]);
  });
});

describe("isTerminal", () => {
  it("identifies the stages after which nothing more happens", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("scripting")).toBe(false);
  });
});

describe("JobStore", () => {
  it("creates a job in the queued stage with a distinct id", () => {
    const store = new JobStore();
    const a = store.create(opts);
    const b = store.create(opts);
    expect(a.stage).toBe("queued");
    expect(a.percent).toBe(0);
    expect(a.id).not.toBe(b.id);
  });

  it("records an event for every update", () => {
    const store = new JobStore();
    const job = store.create(opts);
    store.update(job.id, { stage: "parsing", percent: 4, message: "Reading" });
    store.update(job.id, { stage: "scripting", percent: 20, message: "Writing" });
    expect(store.get(job.id)!.events.map((e) => e.message)).toEqual(["Reading", "Writing"]);
  });

  it("accumulates cost rather than replacing it", () => {
    const store = new JobStore();
    const job = store.create(opts);
    store.update(job.id, { cost: { llmInputTokens: 100 } });
    store.update(job.id, { cost: { ttsCalls: 23 } });
    const cost = store.get(job.id)!.cost;
    expect(cost.llmInputTokens).toBe(100);
    expect(cost.ttsCalls).toBe(23);
  });

  it("notifies a subscriber as progress happens", () => {
    const store = new JobStore();
    const job = store.create(opts);
    const seen: string[] = [];
    store.subscribe(job.id, (_j, e) => seen.push(e.message));
    store.update(job.id, { stage: "parsing", message: "Reading" });
    store.update(job.id, { stage: "scripting", message: "Writing" });
    expect(seen).toEqual(["Reading", "Writing"]);
  });

  it("replays history to a late subscriber", () => {
    // A browser that connects after work started must still see the story.
    const store = new JobStore();
    const job = store.create(opts);
    store.update(job.id, { stage: "parsing", message: "Reading" });
    store.update(job.id, { stage: "scripting", message: "Writing" });

    const seen: string[] = [];
    store.subscribe(job.id, (_j, e) => seen.push(e.message));
    expect(seen).toEqual(["Reading", "Writing"]);
  });

  it("replays events carrying their own stage, not the job's current one", () => {
    // Regression: a stream handler that read the job's stage saw every replayed
    // event as terminal, ended the response on the first, then wrote to a
    // closed stream and took the server process down with it.
    const store = new JobStore();
    const job = store.create(opts);
    store.update(job.id, { stage: "parsing", message: "Reading" });
    store.update(job.id, { stage: "scripting", message: "Writing" });
    store.update(job.id, { stage: "done", percent: 100, message: "Ready" });

    const stages: string[] = [];
    store.subscribe(job.id, (_j, e) => stages.push(e.stage));
    expect(stages).toEqual(["parsing", "scripting", "done"]);
    // Exactly one terminal event, so a consumer ends the stream exactly once.
    expect(stages.filter((s) => s === "done")).toHaveLength(1);
  });

  it("stops notifying once a job has finished", () => {
    const store = new JobStore();
    const job = store.create(opts);
    const seen: string[] = [];
    store.subscribe(job.id, (_j, e) => seen.push(e.message));
    store.update(job.id, { stage: "done", percent: 100, message: "Ready" });
    store.update(job.id, { stage: "parsing", message: "should not arrive" });
    expect(seen).toEqual(["Ready"]);
  });

  it("lets a subscriber unsubscribe", () => {
    const store = new JobStore();
    const job = store.create(opts);
    const seen: string[] = [];
    const off = store.subscribe(job.id, (_j, e) => seen.push(e.message));
    off();
    store.update(job.id, { stage: "parsing", message: "Reading" });
    expect(seen).toEqual([]);
  });

  it("returns undefined for an unknown job rather than throwing", () => {
    const store = new JobStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.update("nope", { stage: "done" })).toBeUndefined();
    expect(() => store.subscribe("nope", () => {})).not.toThrow();
  });

  it("evicts jobs past their retention window", () => {
    const store = new JobStore(-1); // everything is already expired
    store.create(opts);
    store.create(opts);
    expect(store.list().length).toBeLessThanOrEqual(1);
  });
});

describe("toJobError", () => {
  it("explains a truncated context in terms a user can act on", () => {
    const e = toJobError(new ContextTruncationError(17000, 4096, "qwen2:7b"));
    expect(e.code).toBe("context_truncated");
    expect(e.message).not.toMatch(/qwen2|4096/); // no internals leak
    expect(e.remedy).toBeTruthy();
  });

  it("recognizes an exhausted output budget", () => {
    expect(toJobError(new OutputTruncationError("claude-sonnet-5", 2500)).code).toBe(
      "output_truncated",
    );
  });

  it("classifies credential and rate-limit failures", () => {
    expect(toJobError(new Error("401 Unauthorized: invalid api key")).code).toBe("auth_failed");
    expect(toJobError(new Error("429 rate limit exceeded")).code).toBe("rate_limited");
  });

  it("tells an empty account apart from a bad key", () => {
    // Both arrive as a rejected request, and the fixes have nothing in common.
    const e = toJobError(
      new Error("400 Your credit balance is too low to access the Anthropic API."),
    );
    expect(e.code).toBe("no_credit");
    expect(e.remedy).toMatch(/local model/);
    expect(toJobError(new Error("insufficient_quota")).code).toBe("no_credit");
  });

  it("classifies an unreachable provider", () => {
    expect(toJobError(new Error("connect ECONNREFUSED 127.0.0.1:11434")).code).toBe(
      "provider_unreachable",
    );
  });

  it("never passes an unrecognized message through to the client", () => {
    // Raw errors can carry request details; the detail belongs in the log.
    const e = toJobError(new Error("Bearer sk-ant-secret-value failed at line 42"));
    expect(e.code).toBe("internal");
    expect(e.message).not.toContain("sk-ant");
    expect(e.message).not.toContain("line 42");
  });
});
