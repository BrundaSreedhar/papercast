/**
 * Anchoring is only worth having if a missing reference is the normal answer
 * for a turn that cannot be placed. Most of these tests are about what does
 * *not* get a citation: greetings, questions, and analogies that share nothing
 * with the paper but grammar.
 */
import { describe, it, expect } from "vitest";
import { parsePaperStructure, type PaperStructure } from "../pdf/extract";
import type { Episode } from "../llm/schema";
import { groundTurns, formatCitation } from "./index";

const RAW = [
  "Amazon Aurora Design Considerations",
  "",
  "Abstract",
  "Aurora pushes redo processing to a multi-tenant scale-out storage service.",
  "",
  "2.2 Segmented Storage",
  "We partition the database volume into small fixed size segments of ten gigabytes each.",
  "Each segment is replicated six ways across three availability zones using a write quorum.",
  "",
  "6 Lessons Learned",
  "Zero-Downtime Patch upgrades the engine without dropping active connections.",
].join("\n");

const paper: PaperStructure = {
  ...parsePaperStructure(RAW),
  source: { text: RAW, pages: [{ page: 1, start: 0, end: RAW.length }] },
};

const episode = (texts: string[]): Episode => ({
  summary: "s",
  keyPoints: ["k"],
  turns: texts.map((text) => ({ speaker: "host" as const, text })),
});

describe("groundTurns", () => {
  it("anchors a turn that restates a passage, naming its section and page", () => {
    const [c] = groundTurns(
      episode([
        "Aurora partitions the database volume into fixed size segments of ten gigabytes each.",
      ]),
      paper,
    );
    expect(c).toBeDefined();
    expect(c!.turnIndex).toBe(0);
    expect(c!.page).toBe(1);
    expect(c!.heading).toMatch(/segmented storage/i);
  });

  it("gives a greeting no reference at all", () => {
    // The failure this exists to prevent: "Welcome to PaperCast, where we dive
    // deep into the world of academia" shares the, to, we, of and into with
    // every paragraph ever written, and once scored a confident page number.
    const cites = groundTurns(
      episode([
        "Welcome to PaperCast, where we dive deep into the world of academia today.",
      ]),
      paper,
    );
    expect(cites).toHaveLength(0);
  });

  it("gives an analogy no reference, since it shares no content with the paper", () => {
    const cites = groundTurns(
      episode([
        "Imagine a giant library where every book gets copied onto six different shelves.",
      ]),
      paper,
    );
    expect(cites).toHaveLength(0);
  });

  it("anchors only the turns it can place, leaving the rest absent", () => {
    const cites = groundTurns(
      episode([
        "Welcome along, it is good to have you here with us again.",
        "Each segment is replicated six ways across three availability zones using a write quorum.",
      ]),
      paper,
    );
    expect(cites.map((c) => c.turnIndex)).toEqual([1]);
  });

  it("returns nothing at all when the paper has no PDF behind it", () => {
    // Fixtures and tests parse structures from bare text; asking for references
    // must be answerable with "none" rather than throwing.
    expect(
      groundTurns(
        episode(["Aurora partitions the volume into segments."]),
        parsePaperStructure(RAW),
      ),
    ).toEqual([]);
  });

  it("never reports a page the paper does not have", () => {
    for (const c of groundTurns(
      episode([
        "Aurora partitions the database volume into fixed size segments of ten gigabytes each.",
        "Zero-Downtime Patch upgrades the engine without dropping active connections.",
      ]),
      paper,
    )) {
      expect(c.page).toBeGreaterThanOrEqual(1);
      expect(c.page).toBeLessThanOrEqual(paper.source!.pages.length);
    }
  });
});

describe("formatCitation", () => {
  const base = {
    page: 4,
    heading: "3.2 Offloading Redo Processing",
    text: "…",
    start: 0,
    end: 1,
    match: "exact" as const,
    score: 1,
  };

  it("reads as a reference a person can follow", () => {
    expect(formatCitation(base)).toBe("3.2 Offloading Redo Processing, p.4");
  });

  it("shows a range when a passage runs over a page break", () => {
    expect(formatCitation({ ...base, pageEnd: 5 })).toBe(
      "3.2 Offloading Redo Processing, pp.4–5",
    );
  });
});
