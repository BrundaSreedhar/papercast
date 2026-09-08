/**
 * Concepts are only useful if they are about the paper. Most of these check
 * what is *excluded* — the presenter's framing, generic academic filler, and
 * four spellings of one idea — because a busy map says less than a sparse one.
 */
import { describe, it, expect } from "vitest";
import { buildConceptMap, conceptsFor, sharedConcepts } from "./index";
import type { EpisodeSummary } from "../library/types";

/*
 * A bare word has to be something the paper dwells on, so this repeats its
 * terms the way a real paper does. A fixture that named the Transformer once
 * would be testing a document nobody wrote.
 */
const PAPER = `
  The Transformer is a sequence transduction model based entirely on attention.
  Attention lets the Transformer relate positions of a sequence. We use attention
  in place of recurrence. The attention mechanism scales to long sequences, and
  attention is cheaper than recurrence. Recurrence prevents parallelisation.
  The Transformer trains faster than architectures built on recurrence. Our
  Transformer results on the translation task improve over prior work, and the
  Transformer generalises to other tasks. The Transformer uses attention alone.
`;

describe("conceptsFor", () => {
  it("finds what the episode is about", () => {
    const terms = conceptsFor(
      ["The Transformer relies entirely on attention rather than recurrence."],
      "A model built on attention.",
      PAPER,
    ).map((c) => c.term);
    expect(terms).toContain("attention");
    expect(terms.some((t) => t.includes("transformer"))).toBe(true);
  });

  it("drops a phrase the presenter used that the paper never does", () => {
    // The whole point of checking against the paper: framing is not a concept.
    const terms = conceptsFor(
      ["This groundbreaking breakthrough reshapes the whole field."],
      "",
      PAPER,
    ).map((c) => c.term);
    expect(terms).not.toContain("groundbreaking breakthrough");
    expect(terms).not.toContain("whole field");
  });

  it("keeps one term per family rather than four spellings of one idea", () => {
    const terms = conceptsFor(
      ["The attention mechanism replaces recurrence.", "The attention mechanism scales."],
      "Attention, and the attention mechanism.",
      PAPER,
    ).map((c) => c.term);
    const family = terms.filter((t) => t.includes("attention"));
    expect(family).toHaveLength(1);
  });

  it("ignores words that would describe any paper in any field", () => {
    const terms = conceptsFor(
      ["The results of this approach show significant performance improvements."],
      "",
      PAPER,
    ).map((c) => c.term);
    for (const generic of ["results", "approach", "performance", "paper"]) {
      expect(terms).not.toContain(generic);
    }
  });

  it("does not break a phrase across a conjunction", () => {
    const terms = conceptsFor(
      ["It is cheaper and faster than recurrence."],
      "",
      PAPER,
    ).map((c) => c.term);
    expect(terms.every((t) => !t.includes(" and "))).toBe(true);
  });

  it("returns nothing rather than noise when there is nothing to find", () => {
    expect(conceptsFor([], "", PAPER)).toEqual([]);
    expect(conceptsFor(["Totally unrelated wording here."], "", PAPER)).toEqual([]);
  });

  it("ranks the strongest concept first and normalises to it", () => {
    const concepts = conceptsFor(
      ["Attention, attention, and more attention.", "Also the translation task."],
      "",
      PAPER,
    );
    expect(concepts[0]!.weight).toBe(1);
    for (const c of concepts) expect(c.weight).toBeLessThanOrEqual(1);
  });
});

const episode = (
  id: string,
  terms: string[],
): EpisodeSummary & { concepts: ReturnType<typeof conceptsFor> } =>
  ({
    id,
    createdAt: 1,
    paperTitle: id,
    minutes: 4,
    format: "dialogue",
    turnCount: 1,
    hasAudio: false,
    summary: "",
    keyPoints: [],
    concepts: terms.map((term, i) => ({ term, weight: 1 - i * 0.1 })),
  }) as never;

describe("buildConceptMap", () => {
  it("links two concepts that an episode covers together", () => {
    const map = buildConceptMap([episode("a", ["attention", "transformer"])]);
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]).toMatchObject({
      a: "attention",
      b: "transformer",
      episodes: ["a"],
    });
  });

  it("records every episode that covers a concept", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(map.concepts.find((c) => c.term === "attention")!.episodes).toEqual([
      "a",
      "b",
    ]);
  });

  it("puts the most widely shared concept first", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(map.concepts[0]!.term).toBe("attention");
  });

  it("names only the concepts that actually join episodes", () => {
    const map = buildConceptMap([
      episode("a", ["attention", "transformer"]),
      episode("b", ["attention", "quorum"]),
    ]);
    expect(sharedConcepts(map).map((c) => c.term)).toEqual(["attention"]);
  });

  it("copes with a library of one, which is where everyone starts", () => {
    const map = buildConceptMap([episode("a", ["attention"])]);
    expect(map.concepts).toHaveLength(1);
    expect(map.edges).toEqual([]);
    expect(sharedConcepts(map)).toEqual([]);
  });
});
