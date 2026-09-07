/**
 * Anchoring each spoken turn to the passage of the paper it came from.
 *
 * This runs on every generation, on every provider, with no API key and no
 * model call. That constraint is the whole design: a listener asking "where in
 * the paper does that come from" must get an answer on an ordinary run, not
 * only on one that also paid for a fact-checking pass. The judge belongs to the
 * eval harness and stays there.
 *
 * The method is lexical. A turn explains the paper in its own words, but it
 * reuses the paper's nouns — the system names, the mechanisms, the figures — and
 * that overlap is enough to find the passage it tracks. Sentences are tried one
 * at a time and the strongest match wins, because a turn usually covers one
 * specific claim surrounded by connective tissue, and matching the whole turn at
 * once dilutes the signal that identifies it.
 *
 * What this deliberately does not do is guarantee an anchor. A turn that
 * paraphrases loosely, or an ELI5 turn built on an analogy, has little lexical
 * overlap with anything, and inventing a page for it would be worse than
 * leaving it blank. Turns below the threshold get no reference at all.
 */
import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";
import { PaperLocator, type Citation } from "../pdf/locate";

/** Where one turn came from in the paper. */
export interface TurnCitation extends Citation {
  /** Index of the turn in `episode.turns`. */
  turnIndex: number;
}

/**
 * How much of a sentence must be found before it anchors a turn.
 *
 * Lower than the locator's own floor, which exists for judge quotes that are
 * near-verbatim. A spoken turn restates the paper rather than quoting it, so
 * holding it to the same bar would leave almost every turn unanchored — and a
 * reference is a pointer to read for yourself, not an assertion that the
 * wording matches.
 */
const MIN_TURN_SCORE = 0.45;

/** Sentences shorter than this are connective tissue, not claims. */
const MIN_SENTENCE_WORDS = 6;

/** Split spoken text into sentences without tripping over "e.g." or numbers. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= MIN_SENTENCE_WORDS);
}

/**
 * Find the passage each turn tracks most closely.
 *
 * Returns one citation per turn that could be anchored, in turn order. Turns
 * with no confident match are simply absent rather than present-and-wrong.
 */
export function groundTurns(episode: Episode, paper: PaperStructure): TurnCitation[] {
  const locator = new PaperLocator(paper);
  if (!locator.canCite) return [];

  const out: TurnCitation[] = [];

  episode.turns.forEach((turn, turnIndex) => {
    let best: Citation | undefined;

    // The whole turn first: when a turn closely tracks one passage this finds
    // it outright, and an exact hit beats anything a sentence could score.
    for (const candidate of [turn.text, ...sentences(turn.text)]) {
      const hit = locator.find(candidate, MIN_TURN_SCORE);
      if (hit && (!best || hit.score > best.score)) best = hit;
      if (best?.match === "exact") break;
    }

    if (best && best.score >= MIN_TURN_SCORE) out.push({ ...best, turnIndex });
  });

  return out;
}

/** A one-line reference a person can read: "§3.2 The Log, p.4". */
export function formatCitation(c: Citation): string {
  const pages =
    c.pageEnd && c.pageEnd !== c.page ? `pp.${c.page}–${c.pageEnd}` : `p.${c.page}`;
  return `${c.heading}, ${pages}`;
}

export { PaperLocator, type Citation } from "../pdf/locate";
