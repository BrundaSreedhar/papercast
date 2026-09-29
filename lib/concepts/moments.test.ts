/**
 * A moment is a promise: click it and you hear the idea. So these check that a
 * moment is only ever a turn that says the idea's name, and that the link lands
 * on the right turn at the right time.
 */
import { describe, it, expect } from "vitest";
import {
  clock,
  conceptMoments,
  findMoments,
  momentHref,
  momentLabel,
  relationKey,
  type EpisodeTranscript,
} from "./moments";
import { buildConceptMap, type Concept, type ConceptRelationInput } from "./index";
import type { EpisodeSummary } from "../library/types";

const EPISODE: EpisodeTranscript = {
  id: "ep1",
  turns: [
    { text: "Welcome to the show. Today, a paper about sequence models." },
    { text: "The Transformer drops recurrence entirely. It relies on attention alone." },
    { text: "So how does multi-head attention fit into the Transformer?" },
    {
      text: "Each head attends separately. Multi-head attention is part of every layer.",
    },
    { text: "And recurrent networks? RNNs process one token at a time." },
  ],
  timings: [
    { turnIndex: 0, startMs: 0 },
    { turnIndex: 1, startMs: 12_000 },
    { turnIndex: 2, startMs: 31_500 },
    { turnIndex: 3, startMs: 40_000 },
    { turnIndex: 4, startMs: 75_000 },
  ],
};

describe("findMoments", () => {
  it("finds the turns that say the name, with their start times", () => {
    const found = findMoments(EPISODE, [["Transformer"]]);
    expect(found.map((m) => [m.turnIndex, m.startMs])).toEqual([
      [1, 12_000],
      [2, 31_500],
    ]);
  });

  it("quotes the sentence the name is in, not the whole turn", () => {
    const [m] = findMoments(EPISODE, [["Transformer"]]);
    expect(m!.snippet).toBe("The Transformer drops recurrence entirely.");
  });

  it("finds an idea by its alias", () => {
    const found = findMoments(EPISODE, [["recurrent neural network", "RNN"]]);
    expect(found.map((m) => m.turnIndex)).toEqual([4]);
  });

  it("matches whole words only", () => {
    // "attention" is inside "multi-head attention", but "tension" is not a word here.
    expect(findMoments(EPISODE, [["tension"]])).toEqual([]);
  });

  it("finds a relation only where one turn names both ends", () => {
    const found = findMoments(EPISODE, [["multi-head attention"], ["Transformer"]]);
    expect(found.map((m) => m.turnIndex)).toEqual([2]);
  });

  it("stops at a few moments per episode", () => {
    const chatty: EpisodeTranscript = {
      id: "x",
      turns: Array.from({ length: 10 }, () => ({ text: "The Transformer again." })),
    };
    expect(findMoments(chatty, [["Transformer"]])).toHaveLength(3);
  });

  it("works on a transcript without audio", () => {
    const [m] = findMoments({ ...EPISODE, timings: undefined }, [["Transformer"]]);
    expect(m!.startMs).toBeUndefined();
    expect(momentLabel(m!)).toBe("turn 2");
  });
});

describe("links", () => {
  it("opens the episode cued to the turn, scrolled to it", () => {
    expect(momentHref("abc", 4)).toBe("/library/abc?turn=4#turn-4");
  });

  it("labels a moment by its time", () => {
    expect(clock(75_000)).toBe("1:15");
    expect(
      momentLabel({ episodeId: "e", turnIndex: 4, startMs: 75_000, snippet: "" }),
    ).toBe("1:15");
  });
});

const summary = (id: string): EpisodeSummary =>
  ({
    id,
    createdAt: 1,
    paperTitle: `paper ${id}`,
    minutes: 4,
    format: "dialogue",
    turnCount: 1,
    hasAudio: true,
    summary: "",
    keyPoints: [],
  }) as EpisodeSummary;

const concept = (over: Partial<Concept>): Concept => ({
  term: "x",
  weight: 1,
  context: "",
  ...over,
});

describe("conceptMoments", () => {
  const relations: ConceptRelationInput[] = [
    {
      source: "multi-head attention",
      type: "part-of",
      target: "transformer",
      explanation: "e",
      evidence: { text: "q" },
    },
  ];
  const map = buildConceptMap([
    {
      ...summary("ep1"),
      concepts: [
        concept({ term: "transformer", label: "Transformer" }),
        concept({ term: "multi-head attention" }),
        concept({ term: "recurrent neural network", aliases: ["RNN"] }),
        concept({ term: "positional encoding" }),
      ],
      relations,
    },
  ]);
  const found = conceptMoments(map, [EPISODE]);

  it("gives each concept its moments, searched under its aliases too", () => {
    expect(found.byConcept["transformer"]!.map((m) => m.turnIndex)).toEqual([1, 2]);
    expect(found.byConcept["recurrent neural network"]!.map((m) => m.turnIndex)).toEqual([
      4,
    ]);
  });

  it("leaves out a concept the episode never says aloud", () => {
    expect(found.byConcept["positional encoding"]).toBeUndefined();
  });

  it("gives a relation the turns that say both of its ends", () => {
    const key = relationKey(map.relations[0]!);
    expect(found.byRelation[key]!.map((m) => m.turnIndex)).toEqual([2]);
  });
});
