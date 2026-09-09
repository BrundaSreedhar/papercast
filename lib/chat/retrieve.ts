/**
 * Choosing the part of the paper a question actually needs.
 *
 * Writing an episode needs the whole paper: a four-minute summary assembled
 * from three retrieved fragments would miss most of what the paper argues, and
 * coverage is the thing that stops faithfulness rewarding silence. Answering a
 * question is the opposite problem. "What write quorum does it use?" is
 * answered by one section, and sending sixteen thousand tokens to find it is
 * what makes a small local model slow and inattentive.
 *
 * So the two paths differ, and only this one retrieves.
 *
 * Two rankers, fused. Lexical scoring is a BM25-shaped sum over the question's
 * content words, and it needs no model, no key and no endpoint — which is why
 * it, alone, decides whether retrieval happens at all. Dense scoring embeds the
 * question and the sections and compares them, which catches the questions
 * lexical matching is blind to, because a reader asks in their own words and a
 * paper answers in its own. That half runs through a FAISS index
 * (`lib/embed/faiss.ts`); it is exhaustive rather than approximate, so it is
 * the same ranking the cosine loop produced, computed in C++.
 *
 * Measured on Attention Is All You Need, five questions whose answering section
 * was known in advance: lexical scoring alone lost two of them. "Why did they
 * stop using recurrence?" never selected "Why Self-Attention", and "how well
 * did it do at translating into German?" never selected "Machine Translation" —
 * neither section uses the word the reader used. Fusing the two rankers
 * recovered both and lost none of the three lexical scoring already had.
 *
 * The failure that matters is not a wrong section, it is a missing one, because
 * the model will then say the paper does not address something it does. Four
 * things guard against it: the abstract and introduction are included when
 * there is room since they are the paper's own account of itself, the budget is
 * generous rather than minimal, a question that matches nothing falls back to
 * the whole paper instead of guessing, and dense retrieval may reorder that
 * fallback but never overrule it — see `bm25 keeps the veto` below.
 */
import { paperToText, type PaperStructure } from "../pdf/extract";
import { faissScorer, type DenseScorer } from "../embed/faiss";

export interface Retrieved {
  /** The text to send, in document order. */
  text: string;
  /** Headings that were selected, for showing a reader what was consulted. */
  sections: string[];
  /** True when retrieval declined and the whole paper is being sent. */
  whole: boolean;
  /**
   * Which rankers actually ran.
   *
   * "hybrid" only when embedding was available and returned vectors, so this
   * reports what happened rather than what was configured.
   */
  method: "lexical" | "hybrid";
}

/**
 * Scores each passage against the question, or undefined when it cannot.
 *
 * Injectable so the fusion can be tested without an embedding endpoint, and so
 * a different vector store can be dropped in without this file knowing — which
 * is exactly how FAISS arrived: it is one implementation of this type, and
 * nothing in the fusion below had to change for it.
 */
export type { DenseScorer };

export interface RetrieveOptions {
  /** Characters of paper to aim for. */
  budget?: number;
  /** Pass null to skip dense scoring entirely. */
  dense?: DenseScorer | null;
}

/**
 * Characters of paper to aim for, roughly 2,500 tokens.
 *
 * Raised after measuring: at 6,000 the answers lost the facts. "How long does
 * crash recovery take?" came back as "a relatively short amount of time" where
 * the whole paper gave "under ten seconds", because the section holding the
 * number never fit. A retrieval that saves tokens by dropping the answer has
 * saved nothing.
 */
const DEFAULT_BUDGET = 10_000;

/** Below this a paper is small enough that choosing part of it saves nothing. */
const MIN_PAPER_CHARS = 8_000;

/**
 * How many sections dense scoring may put forward that lexical scoring did not.
 *
 * Small on purpose. Cosine ranks every section whether or not any of them is
 * relevant, so the tail of this list is always noise; the head is where the
 * paraphrased question is rescued.
 */
const DENSE_CANDIDATES = 5;

/**
 * Reciprocal rank fusion's damping constant, at its conventional 60.
 *
 * Fusing by rank rather than by score is the point: BM25 is unbounded and
 * cosine sits in a narrow band near 0.5, so any attempt to add or average the
 * two scores directly is really a hidden decision about which ranker wins.
 */
const RRF_K = 60;

/** Sections whose own words make them worth having whatever the question is. */
const ALWAYS = /^(abstract|\d+\.?\s*)?(introduction|background)?$/i;

const WORD = /[a-z][a-z0-9-]{2,}/g;

const STOP = new Set(
  (
    "the and for that this with what which how why does did are was were has have had" +
    " you your they them their there here from into over under about between during" +
    " can could should would may might will shall must its it's not but out its" +
    " use used using paper authors study work does explain describe tell say says"
  ).split(" "),
);

function terms(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w));
}

/** Rank of each index in a scoring, best first; absent when it did not score. */
function ranking(
  scores: number[],
  keep: (score: number) => boolean,
): Map<number, number> {
  const order = scores
    .map((score, i) => ({ i, score }))
    .filter((s) => keep(s.score))
    .sort((a, b) => b.score - a.score);
  return new Map(order.map((s, rank) => [s.i, rank]));
}

/**
 * Pick the sections most likely to answer a question.
 *
 * Returns the whole paper when it is short, when nothing matches, or when the
 * selection would not be meaningfully smaller — in every one of those cases
 * retrieving is cost without benefit.
 */
export async function retrieveForQuestion(
  paper: PaperStructure,
  question: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved> {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const dense = opts.dense === undefined ? faissScorer : opts.dense;

  const whole = paperToText(paper);
  const asked = terms(question);
  if (whole.length <= MIN_PAPER_CHARS || asked.length === 0) {
    return { text: whole, sections: [], whole: true, method: "lexical" };
  }

  const sections = paper.sections;
  const bodies = sections.map((s) => terms(s.content));

  // Inverse document frequency, so a word in every section counts for little
  // and a word in one section counts for a lot.
  const appearsIn = new Map<string, number>();
  for (const body of bodies) {
    for (const w of new Set(body)) appearsIn.set(w, (appearsIn.get(w) ?? 0) + 1);
  }
  const idf = (w: string) =>
    Math.log(1 + sections.length / (1 + (appearsIn.get(w) ?? 0)));

  const wanted = new Set(asked);
  const averageLength =
    bodies.reduce((n, b) => n + b.length, 0) / Math.max(1, bodies.length);

  const lexical = sections.map((section, i) => {
    const body = bodies[i]!;
    const counts = new Map<string, number>();
    for (const w of body) if (wanted.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);

    // BM25's saturation and length normalisation: a section does not become
    // twice as relevant for saying a word twice, and a long section does not
    // win by being long.
    const k = 1.5;
    const b = 0.75;
    const norm = 1 - b + (b * body.length) / Math.max(1, averageLength);
    let score = 0;
    for (const [w, tf] of counts) {
      score += idf(w) * ((tf * (k + 1)) / (tf + k * norm));
    }
    // A question's words in the heading are a strong signal: a paper titles a
    // section after what it is about.
    for (const w of terms(section.heading)) if (wanted.has(w)) score += 2 * idf(w);
    return score;
  });

  /*
   * BM25 keeps the veto.
   *
   * Dense scoring cannot decide that retrieval should happen, only which
   * sections it picks — because cosine has no way to say "none of these". On
   * the Aurora paper the best section for an off-topic question scored 0.456
   * against a genuine best of 0.541, which a threshold can just about separate;
   * on Attention Is All You Need the same probe scored 0.497 against a genuine
   * best of 0.506, which nothing can. So an absolute floor was measured and
   * rejected: it works on one paper and silently stops working on the next.
   * A question with no lexical purchase on the paper still falls back to the
   * whole text, exactly as it did before dense retrieval existed.
   */
  const lexicalRank = ranking(lexical, (score) => score > 0);
  if (lexicalRank.size === 0) {
    return { text: whole, sections: [], whole: true, method: "lexical" };
  }

  let denseRank = new Map<number, number>();
  let method: Retrieved["method"] = "lexical";
  if (dense) {
    const scores = await dense(
      question,
      sections.map((s) => `${s.heading}. ${s.content}`),
    );
    if (scores && scores.length === sections.length) {
      method = "hybrid";
      // Only the head of the dense ranking, and only for sections lexical
      // scoring did not already put forward: the rest is cosine ordering noise.
      const full = ranking(scores, () => true);
      denseRank = new Map(
        [...full].filter(([i, rank]) => rank < DENSE_CANDIDATES || lexicalRank.has(i)),
      );
    }
  }

  // Reciprocal rank fusion. With one ranker this is order-preserving, so the
  // lexical-only path is exactly the ranking it was before.
  const fused = [...new Set([...lexicalRank.keys(), ...denseRank.keys()])]
    .map((i) => {
      const l = lexicalRank.get(i);
      const d = denseRank.get(i);
      const score =
        (l === undefined ? 0 : 1 / (RRF_K + l)) + (d === undefined ? 0 : 1 / (RRF_K + d));
      return { i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const chosen = new Set<number>();
  let used = 0;

  /*
   * Whatever ranked highest goes in first.
   *
   * The abstract and introduction used to be added before anything else, on the
   * reasoning that they are the paper's own account of itself. On a long paper
   * they are also long, and they were consuming the budget before the section
   * that actually answered the question could be considered — which is how a
   * question about segment size came back citing the introduction and never
   * mentioning ten gigabytes. Relevance is claimed first now, and framing gets
   * whatever is left.
   */
  for (const { i } of fused) {
    const section = sections[i]!;
    if (used + section.content.length > budget && chosen.size > 0) continue;
    chosen.add(i);
    used += section.content.length;
  }

  // The paper's own framing, if there is still room for it.
  sections.forEach((section, i) => {
    if (chosen.has(i) || !ALWAYS.test(section.heading.trim())) return;
    if (used + section.content.length > budget) return;
    chosen.add(i);
    used += section.content.length;
  });

  // Nothing was excluded, so there is no saving to have and the full text keeps
  // the abstract and title framing that assembling parts would lose.
  if (chosen.size === sections.length) {
    return { text: whole, sections: [], whole: true, method };
  }

  const parts: string[] = [];
  if (paper.title) parts.push(`# ${paper.title}`);
  if (paper.abstract) parts.push(`## Abstract\n${paper.abstract}`);
  const picked: string[] = [];
  // Document order, so the paper still reads as a paper rather than a ranking.
  [...chosen]
    .sort((a, b) => a - b)
    .forEach((i) => {
      const section = sections[i]!;
      parts.push(`## ${section.heading}\n${section.content}`);
      picked.push(section.heading);
    });

  return { text: parts.join("\n\n"), sections: picked, whole: false, method };
}
