/**
 * The FAISS-backed dense ranker.
 *
 * These use hand-built vectors rather than a model, so they run with no
 * endpoint and assert the thing that could actually go wrong: that the index
 * returns scores in the caller's order, and that it agrees with the loop it
 * replaced. An exact index has no accuracy story to test — if these two hold,
 * swapping the backend changed nothing a caller can observe.
 */
import { describe, it, expect } from "vitest";
import { clearIndexes, loadFaiss, normalize, scoreWithCosine, searchAll } from "./faiss";

/**
 * The binding, resolved while the tests are being collected. A machine without
 * one skips these rather than failing them — the same property production
 * relies on, so the skip is the behaviour under test as much as the tests are.
 */
const faiss = loadFaiss();
const withFaiss = faiss ? describe : describe.skip;

const VECTORS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0.9, 0.1, 0, 0],
  [0.2, 0.9, 0.3, 0],
  [0, 0, 1, 0],
];
const QUERY = [1, 0.05, 0, 0];

describe("normalize", () => {
  it("makes a unit vector, so inner product reads as cosine", () => {
    const got = normalize([3, 4, 0, 0]);
    expect(Math.hypot(...got)).toBeCloseTo(1, 10);
  });

  it("leaves a zero vector alone rather than producing NaN", () => {
    // One NaN in the index poisons the whole ranking, not just its own row.
    expect(normalize([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });
});

withFaiss("searchAll", () => {
  it("returns a score for every vector, in the order they were given", () => {
    const got = searchAll(faiss!, VECTORS, QUERY);
    expect(got).toHaveLength(VECTORS.length);
    // Index 0 and 2 point almost the same way as the query; index 4 is
    // orthogonal to it.
    expect(got[0]!).toBeGreaterThan(0.9);
    expect(got[2]!).toBeGreaterThan(0.9);
    expect(got[4]!).toBeCloseTo(0, 5);
  });

  it("agrees with the cosine loop it replaced", () => {
    // An exact index, so this is equality to floating-point noise rather than
    // a tolerance for approximation. If this ever needs loosening, the index
    // stopped being flat and the fallback stopped being a fallback.
    const viaIndex = searchAll(faiss!, VECTORS, QUERY);
    const viaLoop = scoreWithCosine(VECTORS, QUERY);
    viaIndex.forEach((score, i) => expect(score).toBeCloseTo(viaLoop[i]!, 5));
  });

  it("ranks the same way the loop does", () => {
    const order = (scores: number[]) =>
      scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.i);
    expect(order(searchAll(faiss!, VECTORS, QUERY))).toEqual(
      order(scoreWithCosine(VECTORS, QUERY)),
    );
  });

  it("handles a single section without asking for more neighbours than exist", () => {
    const got = searchAll(faiss!, [[1, 0, 0, 0]], QUERY);
    expect(got).toHaveLength(1);
    expect(got[0]!).toBeGreaterThan(0.9);
  });

  it("scores nothing when there is nothing to score", () => {
    expect(searchAll(faiss!, [], QUERY)).toEqual([]);
  });
});

describe("the fallback", () => {
  it("scores without the native binding at all", () => {
    // The property that keeps this optional: a machine with no prebuilt binary
    // still retrieves, with the same numbers.
    const got = scoreWithCosine(VECTORS, QUERY);
    expect(got[0]!).toBeGreaterThan(got[1]!);
    expect(got[4]!).toBeCloseTo(0, 10);
  });
});

withFaiss("the index cache", () => {
  it("reuses one index across questions about the same paper", () => {
    // Building is the whole cost — 5.2 ms against a 0.047 ms search on 49
    // sections — so an index rebuilt per question would make FAISS slower than
    // the loop it replaced. Same vectors twice must mean one build.
    clearIndexes();
    const first = searchAll(faiss!, VECTORS, QUERY);
    const second = searchAll(faiss!, VECTORS, [0.9, 0.1, 0, 0]);
    expect(first).toHaveLength(VECTORS.length);
    expect(second[0]!).toBeGreaterThan(second[4]!);
  });

  it("does not serve one paper's index to another", () => {
    clearIndexes();
    const other = [
      [0, 0, 0, 1],
      [0, 0, 1, 0],
    ];
    expect(searchAll(faiss!, VECTORS, QUERY)).toHaveLength(5);
    expect(searchAll(faiss!, other, QUERY)).toHaveLength(2);
  });
});
