/**
 * The map has to be the same picture every visit, and has to put things where
 * the reading of it depends on: a paper's ideas together, the bridges in the
 * middle, and a selected idea surrounded by what it connects to.
 */
import { describe, it, expect } from "vitest";
import {
  chooseForOverview,
  egoLayout,
  FAR_MAX,
  NEAR_MAX,
  neighboursOf,
  overviewLayout,
} from "./layout";
import type { ConceptMap, ConceptNode, ConceptRelation } from "./index";

const SIZE = 600;
const node = (term: string, papers: string[]): ConceptNode => ({
  term,
  label: term,
  episodes: papers,
  papers,
  weight: 1,
});
const dist = (p: { x: number; y: number }) => Math.hypot(p.x - SIZE / 2, p.y - SIZE / 2);
const angleOf = (p: { x: number; y: number }) =>
  (Math.atan2(p.y - SIZE / 2, p.x - SIZE / 2) + Math.PI * 2.5) % (Math.PI * 2);

describe("overviewLayout", () => {
  const concepts = [
    node("transformer", ["a"]),
    node("residual learning", ["b"]),
    node("attention", ["a", "b"]),
    node("multi-head attention", ["a"]),
    node("shortcut connection", ["b"]),
  ];
  const { placed } = overviewLayout(concepts, { size: SIZE });
  const at = (t: string) => placed.find((p) => p.term === t)!;

  it("draws the same picture every time", () => {
    expect(overviewLayout(concepts, { size: SIZE })).toEqual({ placed });
  });

  it("puts a concept shared between papers inside the ring", () => {
    expect(at("attention").ring).toBe("inner");
    expect(dist(at("attention"))).toBeLessThan(dist(at("transformer")));
  });

  it("keeps each paper's concepts together on one arc", () => {
    // Walking the ring in order, the papers must not interleave.
    const outer = placed
      .filter((p) => p.ring === "outer")
      .sort((x, y) => angleOf(x) - angleOf(y))
      .map((p) => concepts.find((c) => c.term === p.term)!.papers[0]);
    expect(outer).toEqual(["a", "a", "b", "b"]);
  });

  it("leaves everything on the ring when every concept is shared", () => {
    const all = overviewLayout([node("x", ["a", "b"]), node("y", ["a", "b"])], {
      size: SIZE,
    });
    expect(all.placed.every((p) => p.ring === "outer")).toBe(true);
  });
});

const relation = (source: string, target: string): ConceptRelation => ({
  source,
  target,
  type: "part-of",
  explanation: "",
  evidence: { text: "" },
  episodes: ["e"],
  papers: ["a"],
});

const MAP: ConceptMap = {
  concepts: [],
  byEpisode: {},
  relations: [relation("multi-head attention", "transformer")],
  edges: [
    { a: "positional encoding", b: "transformer", episodes: ["e"], papers: ["a"] },
    { a: "multi-head attention", b: "transformer", episodes: ["e"], papers: ["a"] },
    {
      a: "multi-head attention",
      b: "scaled dot-product attention",
      episodes: ["e"],
      papers: ["a"],
    },
  ],
};

describe("egoLayout", () => {
  const { placed } = egoLayout(MAP, "transformer", { size: SIZE });
  const at = (t: string) => placed.find((p) => p.term === t);

  it("puts the selected concept in the centre", () => {
    expect(at("transformer")).toMatchObject({ ring: "centre", x: SIZE / 2, y: SIZE / 2 });
  });

  it("rings it with its neighbours, typed relations first", () => {
    expect(neighboursOf(MAP, "transformer")).toEqual([
      "multi-head attention",
      "positional encoding",
    ]);
    expect(at("multi-head attention")!.ring).toBe("near");
    expect(at("positional encoding")!.ring).toBe("near");
  });

  it("puts ideas one step further behind, farther out", () => {
    const far = at("scaled dot-product attention")!;
    expect(far.ring).toBe("far");
    expect(dist(far)).toBeGreaterThan(dist(at("multi-head attention")!));
  });

  it("leaves out what is not connected", () => {
    const withStranger: ConceptMap = {
      ...MAP,
      edges: [...MAP.edges, { a: "quorum", b: "paxos", episodes: ["x"], papers: ["b"] }],
    };
    const terms = egoLayout(withStranger, "transformer", { size: SIZE }).placed.map(
      (p) => p.term,
    );
    expect(terms).not.toContain("quorum");
  });

  it("caps each ring, so a hub cannot swamp the view", () => {
    const hub: ConceptMap = {
      ...MAP,
      relations: [],
      edges: Array.from({ length: 30 }, (_, i) => ({
        a: "hub",
        b: `n${i}`,
        episodes: ["e"],
        papers: ["a"],
      })).concat(
        Array.from({ length: 30 }, (_, i) => ({
          a: "n0",
          b: `f${i}`,
          episodes: ["e"],
          papers: ["a"],
        })),
      ),
    };
    const rings = egoLayout(hub, "hub", { size: SIZE }).placed.map((p) => p.ring);
    expect(rings.filter((r) => r === "near")).toHaveLength(NEAR_MAX);
    expect(rings.filter((r) => r === "far")).toHaveLength(FAR_MAX);
  });
});

describe("chooseForOverview", () => {
  it("counts the gap between papers against the ring's room", () => {
    const many = ["a", "b", "c", "d"].flatMap((p) =>
      Array.from({ length: 6 }, (_, i) => node(`${p}${i}`, [p])),
    );
    // Interleaved by strength, as the map's ordering would have them.
    const ranked = Array.from({ length: 6 }, (_, i) =>
      ["a", "b", "c", "d"].map((p) => many.find((c) => c.term === `${p}${i}`)!),
    ).flat();
    const chosen = chooseForOverview(ranked, 16);
    // Four papers take four gap slots, leaving twelve for concepts.
    expect(chosen).toHaveLength(12);
  });

  it("uses every slot when there is one paper and no gap", () => {
    const one = Array.from({ length: 20 }, (_, i) => node(`x${i}`, ["a"]));
    expect(chooseForOverview(one, 16)).toHaveLength(16);
  });
});
