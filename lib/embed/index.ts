/**
 * Turning text into vectors, when something local can do it.
 *
 * Two callers want this: the concept map, which asks whether two ideas mean
 * roughly the same thing, and retrieval, which asks which section of a paper a
 * question is about. They were going to grow two copies of the same fetch, the
 * same cache and the same cosine, so it lives here once.
 *
 * Everything about this module is optional by construction. `embedTexts`
 * returns `undefined` rather than throwing when there is no endpoint, no model
 * or no patience, and both callers are written to carry on without it. That is
 * not defensive coding for its own sake — this project's rule is that a page
 * anyone can open works with no key and no local runtime, so anything that
 * needs one has to degrade rather than fail.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { withSpanFor } from "../trace/tracer";
import * as TA from "../trace/attributes";
import { tags } from "../trace/langsmith";

export const EMBED_MODEL = () =>
  process.env.EMBED_MODEL ?? "hf.co/CompendiumLabs/bge-base-en-v1.5-gguf:latest";

const BASE_URL = () =>
  process.env.EMBED_BASE_URL ?? process.env.OPEN_BASE_URL ?? "http://localhost:11434/v1";

const CACHE_DIR = () =>
  process.env.EMBED_CACHE_DIR ?? join(process.cwd(), "data", "embeddings");

/**
 * What a query is prefixed with before it is embedded.
 *
 * BGE is trained asymmetrically: passages are embedded bare, questions with an
 * instruction in front of them. Skipping it is not a small loss. Measured on
 * the Aurora paper, "What happens when a machine dies unexpectedly and comes
 * back?" ranked the recovery section third without the prefix and first with
 * it, and — the part that matters more — an off-topic question scored 0.505
 * against its best section without the prefix and 0.456 with it, against a
 * genuine best of 0.541. Without the prefix there is no gap at all between
 * "this is the answer" and "this paper is not about that".
 *
 * Configurable because it belongs to BGE, not to embeddings in general; point
 * EMBED_MODEL at a symmetric model and set this to empty.
 */
export const queryPrefix = () =>
  process.env.EMBED_QUERY_PREFIX ??
  "Represent this sentence for searching relevant passages: ";

/**
 * Characters of a passage that are embedded.
 *
 * BGE takes 512 tokens and silently truncates past that, so a 5,000-character
 * section is being judged on its first fifth whatever we do. Truncating here
 * makes that explicit and keeps the request small.
 */
const MAX_CHARS = 2_000;

/** Embedding one string is deterministic, so it is worth never doing twice. */
async function cached(key: string): Promise<number[] | undefined> {
  try {
    return JSON.parse(
      await readFile(join(CACHE_DIR(), `${key}.json`), "utf8"),
    ) as number[];
  } catch {
    return undefined;
  }
}

async function store(key: string, vector: number[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR(), { recursive: true });
    await writeFile(join(CACHE_DIR(), `${key}.json`), JSON.stringify(vector), "utf8");
  } catch {
    // A cache that cannot be written is slower, not broken.
  }
}

const keyFor = (model: string, text: string) =>
  createHash("sha256").update(`${model} ${text}`).digest("hex").slice(0, 32);

/**
 * Embed a batch, or return undefined if embedding is not available here.
 *
 * Cached vectors are served from disk and only the rest are requested, which is
 * what makes a second question about the same paper free: its sections were
 * embedded when the first question was asked.
 */
export function embedTexts(
  texts: string[],
  timeoutMs = 20_000,
): Promise<number[][] | undefined> {
  if (texts.length === 0) return Promise.resolve([]);
  // The cached count is the number worth seeing: it is the difference between
  // a question that waits on a model and one answered from disk.
  return withSpanFor(
    "embed",
    {
      [TA.PAPERCAST_EMBED_COUNT]: texts.length,
      [TA.PAPERCAST_EMBED_MODEL]: EMBED_MODEL(),
      ...tags("embed"),
    },
    (span) => run(span),
  );

  async function run(span: import("@opentelemetry/api").Span) {
    const model = EMBED_MODEL();
    const clipped = texts.map((t) => t.slice(0, MAX_CHARS));
    const keys = clipped.map((t) => keyFor(model, t));
    const found = await Promise.all(keys.map(cached));
    const missing = clipped.filter((_, i) => !found[i]);
    span.setAttribute(TA.PAPERCAST_EMBED_CACHED, texts.length - missing.length);
    if (missing.length === 0) return found as number[][];

    let fresh: number[][];
    try {
      const res = await fetch(`${BASE_URL().replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: missing }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { embedding: number[] }[] };
      if (!body.data || body.data.length !== missing.length) return undefined;
      fresh = body.data.map((d) => d.embedding);
    } catch {
      // No endpoint, no model, or too slow. Every caller works without this.
      return undefined;
    }

    let next = 0;
    const out: number[][] = [];
    for (let i = 0; i < clipped.length; i++) {
      const vector = found[i] ?? fresh[next++]!;
      if (!found[i]) void store(keys[i]!, vector);
      out.push(vector);
    }
    return out;
  }
}

/** Embed a question, with whatever the model wants in front of a query. */
export async function embedQuery(
  question: string,
  timeoutMs?: number,
): Promise<number[] | undefined> {
  const got = await embedTexts([`${queryPrefix()}${question}`], timeoutMs);
  return got?.[0];
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** How similar a query vector is to each of `vectors`, in the same order. */
export function similarities(query: number[], vectors: number[][]): number[] {
  return vectors.map((v) => cosine(query, v));
}
