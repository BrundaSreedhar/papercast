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
 * Scoring is lexical — a BM25-shaped sum over the question's content words —
 * because it needs no model, no key and no endpoint, and because a question and
 * the section that answers it usually share the paper's own vocabulary. There
 * is no index: a paper has a few dozen sections, and scoring them all is
 * microseconds.
 *
 * The failure that matters is not a wrong section, it is a missing one, because
 * the model will then say the paper does not address something it does. Three
 * things guard against it: the abstract and introduction are always included
 * since they are the paper's own account of itself, the budget is generous
 * rather than minimal, and a question that matches nothing falls back to the
 * whole paper instead of guessing.
 */
import { paperToText, type PaperStructure } from "../pdf/extract";

export interface Retrieved {
  /** The text to send, in document order. */
  text: string;
  /** Headings that were selected, for showing a reader what was consulted. */
  sections: string[];
  /** True when retrieval declined and the whole paper is being sent. */
  whole: boolean;
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

/**
 * Pick the sections most likely to answer a question.
 *
 * Returns the whole paper when it is short, when nothing matches, or when the
 * selection would not be meaningfully smaller — in every one of those cases
 * retrieving is cost without benefit.
 */
export function retrieveForQuestion(
  paper: PaperStructure,
  question: string,
  budget = DEFAULT_BUDGET,
): Retrieved {
  const whole = paperToText(paper);
  const asked = terms(question);
  if (whole.length <= MIN_PAPER_CHARS || asked.length === 0) {
    return { text: whole, sections: [], whole: true };
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

  const scored = sections.map((section, i) => {
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
    return { i, section, score };
  });

  const matched = scored.filter((s) => s.score > 0);
  if (matched.length === 0) return { text: whole, sections: [], whole: true };

  const chosen = new Set<number>();
  let used = 0;

  /*
   * Whatever scored highest goes in first.
   *
   * The abstract and introduction used to be added before anything else, on the
   * reasoning that they are the paper's own account of itself. On a long paper
   * they are also long, and they were consuming the budget before the section
   * that actually answered the question could be considered — which is how a
   * question about segment size came back citing the introduction and never
   * mentioning ten gigabytes. Relevance is claimed first now, and framing gets
   * whatever is left.
   */
  for (const { i, section } of matched.sort((a, b) => b.score - a.score)) {
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
  if (chosen.size === sections.length) return { text: whole, sections: [], whole: true };

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

  return { text: parts.join("\n\n"), sections: picked, whole: false };
}
