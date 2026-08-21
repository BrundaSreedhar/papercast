/**
 * The ledger records what the material covered, not what the reader absorbed.
 * These tests pin that distinction: an item is only "verified" if the judge
 * checked it, a gap only exists if annotations name it, and a suggestion only
 * appears if a studied paper actually cites it.
 */
import { describe, it, expect } from "vitest";
import { recordEpisode } from "./record";
import { openGaps, suggestedReadings, summarize } from "./next";
import { emptyLedger, type Ledger } from "./types";
import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";

const EPISODE: Episode = {
  summary: "s",
  keyPoints: ["The network is the bottleneck", "Only redo log records cross the network"],
  turns: [
    { speaker: "host", text: "Welcome. What problem does this paper solve?" },
    {
      speaker: "guest",
      text: "The authors argue the network is the bottleneck once storage and compute are decoupled.",
    },
    {
      speaker: "guest",
      text: "Only redo log records cross the network, never full data pages.",
    },
  ],
};

const PAPER: PaperStructure = {
  title: "Amazon Aurora",
  abstract: "a",
  sections: [],
  wordCount: 5,
  references: [
    { raw: "…", title: "Spanner: Google's globally distributed database", year: 2012 },
    { raw: "…", title: "The Chubby lock service", year: 2006 },
  ],
};

const base = {
  paperId: "aurora",
  paper: PAPER,
  episode: EPISODE,
  provider: "anthropic",
  model: "claude-sonnet-5",
  minutes: 4,
};

describe("recordEpisode", () => {
  it("falls back to key points when the judge has not run", () => {
    // Recording must work for every episode, not only evaluated ones.
    const l = recordEpisode(emptyLedger(), base);
    const rec = l.papers.aurora!;
    expect(rec.learned).toHaveLength(2);
    expect(rec.learned.every((i) => i.provenance === "stated")).toBe(true);
  });

  it("prefers judge-verified claims, and keeps their evidence", () => {
    const l = recordEpisode(emptyLedger(), {
      ...base,
      verdicts: [
        {
          claim: "The network is the bottleneck",
          verdict: "supported",
          evidence: "the central constraint has moved to the network",
          specific: false,
        },
        { claim: "Aurora uses eight replicas", verdict: "contradicted", specific: true },
      ],
    });
    const items = l.papers.aurora!.learned;
    // Only the supported claim is learnt; a contradicted one is not knowledge.
    expect(items).toHaveLength(1);
    expect(items[0]!.provenance).toBe("verified");
    expect(items[0]!.evidence).toContain("central constraint");
  });

  it("links an item to the turn and moment it was discussed", () => {
    const l = recordEpisode(emptyLedger(), {
      ...base,
      timings: [
        { turnIndex: 0, speaker: "host", startMs: 0, endMs: 4000, chunks: 1 },
        { turnIndex: 1, speaker: "guest", startMs: 4300, endMs: 15000, chunks: 1 },
        { turnIndex: 2, speaker: "guest", startMs: 15300, endMs: 22000, chunks: 1 },
      ],
    });
    const net = l.papers.aurora!.learned.find((i) => i.text.includes("bottleneck"))!;
    expect(net.turnIndex).toBe(1);
    expect(net.startMs).toBe(4300);
  });

  it("leaves a timestamp off rather than guessing one", () => {
    // A wrong timestamp sends the reader to the wrong part of the episode,
    // which is worse than offering no jump at all.
    const l = recordEpisode(emptyLedger(), {
      ...base,
      episode: { ...EPISODE, keyPoints: ["Something the dialogue never discusses at all"] },
      timings: [{ turnIndex: 0, speaker: "host", startMs: 0, endMs: 4000, chunks: 1 }],
    });
    expect(l.papers.aurora!.learned[0]!.startMs).toBeUndefined();
  });

  it("accumulates across sessions without duplicating what is known", () => {
    const first = recordEpisode(emptyLedger(), base);
    const second = recordEpisode(first, base);
    expect(second.papers.aurora!.learned).toHaveLength(2);
    expect(second.papers.aurora!.episodes).toHaveLength(2);
  });

  it("keeps the original date when an item is met again", () => {
    const first = recordEpisode(emptyLedger(), base);
    const when = first.papers.aurora!.learned[0]!.firstSeen;
    const second = recordEpisode(first, base);
    expect(second.papers.aurora!.learned[0]!.firstSeen).toBe(when);
  });

  it("upgrades a stated item once the judge verifies it", () => {
    const first = recordEpisode(emptyLedger(), base);
    const second = recordEpisode(first, {
      ...base,
      verdicts: [
        {
          claim: "The network is the bottleneck",
          verdict: "supported",
          evidence: "quoted",
          specific: false,
        },
      ],
    });
    const item = second.papers.aurora!.learned.find((i) => i.text.includes("bottleneck"))!;
    expect(item.provenance).toBe("verified");
    expect(item.firstSeen).toBe(first.papers.aurora!.learned[0]!.firstSeen);
  });

  it("records coverage gaps from the annotations", () => {
    const l = recordEpisode(emptyLedger(), {
      ...base,
      coverage: {
        expected: ["A", "B", "C"],
        hit: ["A", "B"],
        missed: ["C"],
        coverage: 2 / 3,
      },
    });
    expect(l.papers.aurora!.covered).toEqual(["A", "B"]);
    expect(l.papers.aurora!.missed).toEqual(["C"]);
  });

  it("closes a gap once any episode covers it", () => {
    const first = recordEpisode(emptyLedger(), {
      ...base,
      coverage: { expected: ["A", "B"], hit: ["A"], missed: ["B"], coverage: 0.5 },
    });
    expect(first.papers.aurora!.missed).toEqual(["B"]);

    const second = recordEpisode(first, {
      ...base,
      coverage: { expected: ["A", "B"], hit: ["B"], missed: ["A"], coverage: 0.5 },
    });
    // A covered by the first episode, B by the second: nothing outstanding.
    expect(second.papers.aurora!.missed).toEqual([]);
  });
});

describe("openGaps", () => {
  it("reports each uncovered contribution with its paper", () => {
    const l = recordEpisode(emptyLedger(), {
      ...base,
      coverage: { expected: ["A", "B"], hit: ["A"], missed: ["B"], coverage: 0.5 },
    });
    expect(openGaps(l)).toEqual([
      { paperId: "aurora", paperTitle: "Amazon Aurora", contribution: "B" },
    ]);
  });

  it("reports nothing when no annotations exist to measure against", () => {
    expect(openGaps(recordEpisode(emptyLedger(), base))).toEqual([]);
  });
});

describe("suggestedReadings", () => {
  it("suggests works the studied papers actually cite", () => {
    const s = suggestedReadings(recordEpisode(emptyLedger(), base));
    expect(s.map((x) => x.title)).toContain("Spanner: Google's globally distributed database");
    expect(s[0]!.citedBy).toEqual(["Amazon Aurora"]);
  });

  it("ranks a work cited by several studied papers first", () => {
    let l: Ledger = recordEpisode(emptyLedger(), base);
    l = recordEpisode(l, {
      ...base,
      paperId: "other",
      paper: {
        ...PAPER,
        title: "Another Paper",
        references: [
          { raw: "…", title: "Spanner: Google's globally distributed database", year: 2012 },
        ],
      },
    });
    const s = suggestedReadings(l);
    expect(s[0]!.title).toMatch(/Spanner/);
    expect(s[0]!.citations).toBe(2);
    expect(s[0]!.citedBy).toHaveLength(2);
  });

  it("does not suggest a paper already in the library", () => {
    let l: Ledger = recordEpisode(emptyLedger(), base);
    // Study the cited work itself; it should drop out of the suggestions.
    l = recordEpisode(l, {
      ...base,
      paperId: "spanner",
      paper: {
        ...PAPER,
        title: "Spanner: Google's globally distributed database",
        references: [],
      },
    });
    expect(suggestedReadings(l).map((x) => x.title)).not.toContain(
      "Spanner: Google's globally distributed database",
    );
  });

  it("returns nothing for an empty ledger rather than throwing", () => {
    expect(suggestedReadings(emptyLedger())).toEqual([]);
  });
});

describe("summarize", () => {
  it("counts papers, episodes, items and gaps", () => {
    const l = recordEpisode(emptyLedger(), {
      ...base,
      coverage: { expected: ["A", "B"], hit: ["A"], missed: ["B"], coverage: 0.5 },
    });
    expect(summarize(l)).toEqual({
      papers: 1,
      episodes: 1,
      learned: 2,
      verified: 0,
      gaps: 1,
    });
  });
});
