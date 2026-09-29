/**
 * Nearest sections, through a FAISS index.
 *
 * What this replaces is the cosine loop in `./index`, not BM25. FAISS is an
 * index rather than a scoring method: it takes vectors and returns neighbours,
 * it does not read text and has no opinion about relevance. So the lexical
 * ranker still decides *whether* a question retrieves at all, and this only
 * changes how the dense half of the fusion is computed.
 *
 * The index is `IndexFlatIP` over L2-normalised vectors, which makes inner
 * product exactly cosine similarity and makes the search exhaustive. That is
 * deliberate. The approximate indexes are the reason FAISS exists, and they all
 * want training data and tuning to trade recall for speed on corpora of
 * millions. A paper has a few dozen sections — Aurora has 49, Attention has 40
 * — so an approximate index would be slower to build than the search it
 * replaces, and would trade away exactness for nothing.
 *
 * Be clear about what this buys at present scale: nothing, measurably. The
 * search matches the JavaScript loop it replaced to within noise, and the
 * indexes have to be cached per paper just to stop the build cost making it
 * slower. What it buys is structure — the same code answers a library-wide
 * corpus, where the loop would not.
 *
 * The binding is a compiled native module, so it is loaded lazily and its
 * absence is not an error. A machine without it falls back to the pure
 * JavaScript scorer, which returns identical scores — this is an exact index,
 * so the two agree to floating-point noise rather than approximately.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { cosine, embedQuery, embedTexts } from "./index";

/** Scores each passage against the question, or undefined when it cannot. */
export type DenseScorer = (
  question: string,
  passages: string[],
) => Promise<number[] | undefined>;

/** The slice of faiss-node this uses, so the lazy import stays typed. */
interface FlatIndex {
  add(vectors: number[]): void;
  search(query: number[], k: number): { distances: number[]; labels: number[] };
}
interface FaissModule {
  IndexFlatIP: new (dimension: number) => FlatIndex;
}

let cached: FaissModule | null | undefined;

/**
 * The binding, or null if this machine has no usable one.
 *
 * Synchronous, and resolved from the project root rather than from this file's
 * own location, so it does not depend on whether the module graph around it is
 * being treated as CommonJS or as ESM — a distinction this project currently
 * answers differently for the typechecker and for the test runner.
 *
 * Resolved once and remembered, including the failure: a missing native module
 * does not appear halfway through a process, and retrying the load on every
 * question would pay the failure cost repeatedly.
 */
export function loadFaiss(): FaissModule | null {
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(join(process.cwd(), "index.js"));
    const mod = req("faiss-node") as {
      default?: FaissModule;
      IndexFlatIP?: FaissModule["IndexFlatIP"];
    };
    const resolved = mod.IndexFlatIP ? (mod as FaissModule) : mod.default;
    cached = resolved?.IndexFlatIP ? resolved : null;
  } catch {
    // No prebuilt binary for this platform, or no compiler to make one.
    cached = null;
  }
  return cached;
}

/** Unit-length copy, so inner product reads as cosine. */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  // A zero vector has no direction; leaving it alone keeps its score at zero
  // rather than turning it into NaN and poisoning the whole ranking.
  return len === 0 ? v.slice() : v.map((x) => x / len);
}

/**
 * Built indexes, keyed by the vectors that went into them.
 *
 * Building is the whole cost, and it is not small: 5.2 ms for 49 sections of
 * 768 dimensions, 1.6 s for twenty thousand. Almost all of it is marshalling
 * floats across the N-API boundary rather than anything FAISS does. Searching
 * the built index is 0.047 ms — against 0.050 ms for the JavaScript loop this
 * replaced.
 *
 * Which is the honest measurement: at one paper's worth of sections the search
 * is a tie, so the build never amortises and the index is a structural choice
 * rather than a speed one. Caching it per paper is what keeps the cost at
 * roughly 0.8 ms per question instead of 5 ms, which is the difference between
 * invisible and merely irrelevant next to the model call that follows.
 *
 * Where the structure starts paying: at twenty thousand chunks the search is
 * 7.6 ms against 23 ms for the loop, and 1.6 ms if only the top few are wanted.
 * That is library-wide retrieval, not one paper — and the build would then want
 * persisting to disk (`index.write`) rather than rebuilding per process.
 *
 * Bounded, because a long-lived server would otherwise hold an index for every
 * paper anyone had ever asked about. Small, because the working set is one
 * paper: the one being listened to.
 */
const INDEXES = new Map<string, FlatIndex>();
const MAX_INDEXES = 8;

/**
 * Identity of a set of vectors, in constant time.
 *
 * This has to be O(1), not merely cheap. Measured at 49 sections of 768
 * dimensions, hashing a float from every vector costs 0.14 ms and hashing the
 * section texts costs 0.04 ms — against a whole cosine scan of 0.05 ms. A cache
 * whose key costs more than the work it saves is a pessimisation, so the key
 * reads a fixed number of values regardless of how many vectors there are.
 *
 * The vectors come from a content-addressed cache keyed by section text, so
 * shape plus samples from the first and last vector separate any two papers
 * that would actually be searched in the same process.
 */
function keyFor(vectors: number[][]): string {
  const first = vectors[0]!;
  const last = vectors[vectors.length - 1]!;
  return [
    vectors.length,
    first.length,
    first[0],
    first[first.length - 1],
    last[0],
    last[last.length - 1],
  ].join(":");
}

/** Drop the cached index for a set of vectors. Exported for tests. */
export function clearIndexes(): void {
  INDEXES.clear();
}

function indexFor(faiss: FaissModule, vectors: number[][]): FlatIndex {
  const key = keyFor(vectors);
  const hit = INDEXES.get(key);
  if (hit) {
    // Re-inserting marks it as most recently used, so the eviction below takes
    // the paper nobody is reading rather than the one they are.
    INDEXES.delete(key);
    INDEXES.set(key, hit);
    return hit;
  }

  const index = new faiss.IndexFlatIP(vectors[0]!.length);
  // One flat array of n × d; faiss-node infers the count from the dimension.
  index.add(vectors.flatMap((v) => normalize(v)));

  INDEXES.set(key, index);
  if (INDEXES.size > MAX_INDEXES) {
    const oldest = INDEXES.keys().next().value;
    if (oldest !== undefined) INDEXES.delete(oldest);
  }
  return index;
}

/**
 * Search an index of `vectors` for the ones nearest `query`.
 *
 * Returns a score per vector in the original order, because the caller fuses
 * this ranking with a lexical one and needs them aligned. `k` is the whole
 * index: at this size there is nothing to save by asking for fewer, and a
 * partial result would silently become a zero for every section not returned.
 */
export function searchAll(
  faiss: FaissModule,
  vectors: number[][],
  query: number[],
): number[] {
  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) return vectors.map(() => 0);

  const index = indexFor(faiss, vectors);
  const { distances, labels } = index.search(normalize(query), vectors.length);
  const scores = new Array<number>(vectors.length).fill(0);
  labels.forEach((label, i) => {
    // A short index pads with -1, which is not a section.
    if (label >= 0 && label < scores.length) scores[label] = distances[i] ?? 0;
  });
  return scores;
}

/** The same scoring in plain JavaScript, for when the binding is missing. */
export function scoreWithCosine(vectors: number[][], query: number[]): number[] {
  return vectors.map((v) => cosine(query, v));
}

/**
 * Score a paper's sections against a question.
 *
 * Embedding is the expensive half and is unchanged — the vectors come from the
 * same cached client either way, so a second question about the same paper
 * still costs one query embedding whichever backend does the search.
 */
export const faissScorer: DenseScorer = async (question, passages) => {
  const [query, vectors] = await Promise.all([
    embedQuery(question),
    embedTexts(passages),
  ]);
  if (!query || !vectors || vectors.length !== passages.length) return undefined;
  if (vectors.length === 0) return [];

  const faiss = loadFaiss();
  return faiss ? searchAll(faiss, vectors, query) : scoreWithCosine(vectors, query);
};
