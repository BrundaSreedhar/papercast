/**
 * Demo mode exists to make one guarantee: a stranger with the URL cannot spend
 * more than a known amount. These tests are that guarantee, so they check the
 * ceilings hold under the sequences that would break them — a job released
 * twice, a day rolling over, a manifest naming a paper that is not there.
 */
import { describe, it, expect } from "vitest";
import { DemoGate } from "./gate";
import { parseCatalogue } from "./catalogue";

const limits = {
  concurrentJobs: 1,
  dailyJobs: 3,
  concurrentQuestions: 2,
  dailyQuestions: 4,
};
const t0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("DemoGate", () => {
  it("admits one job and refuses the next until it finishes", () => {
    const gate = new DemoGate(limits);
    expect(gate.admit("job", t0).ok).toBe(true);

    const second = gate.admit("job", t0 + 1000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);

    gate.release("job");
    expect(gate.admit("job", t0 + 2000).ok).toBe(true);
  });

  it("stops at the daily limit even when nothing is running", () => {
    const gate = new DemoGate(limits);
    for (let i = 0; i < limits.dailyJobs; i++) {
      expect(gate.admit("job", t0 + i).ok).toBe(true);
      gate.release("job");
    }

    const refused = gate.admit("job", t0 + 10);
    expect(refused.ok).toBe(false);
    // The refusal has to say when to come back, or it reads as a broken page.
    if (!refused.ok) expect(refused.remedy).toMatch(/hour/);
  });

  it("rolls the daily window forward rather than resetting on a calendar date", () => {
    const gate = new DemoGate(limits);
    for (let i = 0; i < limits.dailyJobs; i++) {
      gate.admit("job", t0 + i);
      gate.release("job");
    }
    expect(gate.admit("job", t0 + DAY - 1).ok).toBe(false);
    expect(gate.admit("job", t0 + DAY).ok).toBe(true);
  });

  it("cannot be talked into extra capacity by releasing more than was admitted", () => {
    const gate = new DemoGate(limits);
    gate.release("job");
    gate.release("job");
    expect(gate.admit("job", t0).ok).toBe(true);
    expect(gate.admit("job", t0).ok).toBe(false);
  });

  it("reports what it is holding, and forgets a window that has expired", () => {
    const gate = new DemoGate(limits);
    gate.admit("job", t0);
    gate.admit("question", t0);
    expect(gate.status(t0)).toMatchObject({
      running: { job: 1, question: 1 },
      startedToday: { job: 1, question: 1 },
    });
    expect(gate.status(t0 + DAY).startedToday).toEqual({ job: 0, question: 0 });
  });

  it("limits questions on their own allowance", () => {
    const gate = new DemoGate(limits);
    for (let i = 0; i < limits.dailyQuestions; i++) {
      expect(gate.admit("question", t0 + i).ok).toBe(true);
      gate.release("question");
    }
    const refused = gate.admit("question", t0 + 100);
    expect(refused.ok).toBe(false);
    // Told which allowance ran out, not the episode one.
    if (!refused.ok) expect(refused.message).toMatch(/question/i);
  });

  it("keeps the shelf usable after today's episodes are gone", () => {
    // The point of separate allowances: a visitor who arrives once the
    // expensive part is spent can still listen and still ask.
    const gate = new DemoGate(limits);
    for (let i = 0; i < limits.dailyJobs; i++) {
      gate.admit("job", t0 + i);
      gate.release("job");
    }
    expect(gate.admit("job", t0 + 10).ok).toBe(false);
    expect(gate.admit("question", t0 + 10).ok).toBe(true);
  });

  it("answers a few questions at once, since they are short and cheap", () => {
    const gate = new DemoGate(limits);
    expect(gate.admit("question", t0).ok).toBe(true);
    expect(gate.admit("question", t0).ok).toBe(true);
    expect(gate.admit("question", t0).ok).toBe(false);
    gate.release("question");
    expect(gate.admit("question", t0).ok).toBe(true);
  });

  it("does not let a job in flight block a question", () => {
    const gate = new DemoGate(limits);
    gate.admit("job", t0);
    expect(gate.admit("question", t0).ok).toBe(true);
  });
});

describe("the demo catalogue", () => {
  const paper = {
    id: "attention",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    year: 2017,
    url: "https://arxiv.org/pdf/1706.03762",
    note: "The transformer paper.",
  };

  it("accepts a well-formed manifest", () => {
    expect(parseCatalogue({ papers: [paper] })).toHaveLength(1);
  });

  it("rejects an id that would not be safe as a filename", () => {
    // The id becomes a path, so anything but a slug is a traversal waiting to
    // happen. Rejecting at parse time keeps that check off the request path.
    expect(() =>
      parseCatalogue({ papers: [{ ...paper, id: "../../etc/passwd" }] }),
    ).toThrow();
    expect(() =>
      parseCatalogue({ papers: [{ ...paper, id: "Attention Paper" }] }),
    ).toThrow();
  });

  it("rejects a manifest with no papers, which would leave the demo unusable", () => {
    expect(() => parseCatalogue({ papers: [] })).toThrow();
  });
});
