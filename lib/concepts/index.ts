/**
 * The ideas an episode is about, and which episodes share them.
 *
 * Extraction is lexical and local — no model call, no key — for the same reason
 * citations are: a map of what you have listened to should exist for every
 * episode on every provider, not only the ones that paid for an extra pass.
 *
 * The method is deliberately narrow. Candidate terms are the noun-ish phrases
 * that appear in the episode's key points, which are already the model's
 * distillation of what matters, and they are kept only when the paper itself
 * uses them. That second test is what stops a concept map filling up with
 * words from the presenter's framing: "an interesting approach" survives the
 * first filter and not the second.
 *
 * Scoring rewards a term for being frequent in this paper and rare across the
 * rest of the library, which is what makes it *this* episode's concept rather
 * than a word every paper in the field uses. With one episode on the shelf that
 * second half has nothing to say, so it degrades to frequency — the map is
 * thinner early on and sharpens as the library grows, rather than being wrong.
 */
import type { EpisodeSummary } from "../library/types";

export interface Concept {
  /** The term as it reads, e.g. "attention mechanism". */
  term: string;
  /** How strongly this episode is about it, 0–1 within the episode. */
  weight: number;
  /**
   * The sentence the term was found in.
   *
   * Two words carry almost nothing on their own: embedded bare, "crash
   * recovery" and "multi-head attention" score as similar as "transformer" and
   * "multi-head attention" do. With the sentence around them the same pairs
   * separate cleanly, so the context travels with the term.
   */
  context: string;
}

export interface ConceptNode {
  term: string;
  /** Episode ids that cover it, strongest first. */
  episodes: string[];
  /** Sum of the term's weight across those episodes. */
  weight: number;
}

export interface ConceptEdge {
  /** Two terms that appear together, alphabetically ordered. */
  a: string;
  b: string;
  /** Episodes in which both appear. */
  episodes: string[];
}

export interface ConceptMap {
  concepts: ConceptNode[];
  edges: ConceptEdge[];
  /** Concepts per episode, for colouring and for the per-episode view. */
  byEpisode: Record<string, Concept[]>;
}

/** Words that are never a concept, however often a paper says them. */
const STOP = new Set(
  (
    "a an and are as at be been but by can could do does for from had has have how in into is it its" +
    " may might more most no not of on or our out over should so some such than that the their them then" +
    " there these they this those to up was we were what when where which while who will with would you your" +
    " about across after all also any because before both each even every here just like made make many much" +
    " new now only other same see still take through very well use used using based show shows shown result" +
    " results paper papers work works" +
    " authors study studies research researchers episode listener" +
    // Generic enough to describe any paper in any field, so they say nothing
    // about this one.
    " data information performance quality time times way ways thing things part parts case cases" +
    " entirely significantly substantially considerably particularly especially instead rather" +
    " problem problems solution solutions idea ideas number numbers value values state states" +
    " task tasks example examples experiment experiments" +
    " general specific overall common typical standard various different"
  ).split(" "),
);

/**
 * Words that make a phrase a judgement rather than a thing.
 *
 * "sufficiently powerful", "offer significant advantages" and "inherently more
 * suitable" are all opinions about a concept, not concepts. A phrase built on
 * one of these at either end is describing something rather than naming it, and
 * a map of them tells you nothing about what the paper is about.
 */
const NOT_A_THING = new Set(
  (
    "powerful suitable capable effective efficient significant substantial considerable" +
    " expensive cheap chatty robust scalable simple complex novel important useful better" +
    " best worse worst greater lower higher larger smaller faster slower cheaper" +
    " advantages benefits drawbacks limitations improvements gains" +
    " offer offers offering provide provides providing enable enables enabling allow allows" +
    " allowing achieve achieves achieving dispensing expect expects reducing reduces" +
    " improving improves increasing increases"
  ).split(" "),
);

/**
 * Nouns too generic to be a concept alone, but perfectly good as the head of
 * one. "models" is not a concept; "small language models" is, and treating the
 * word as forbidden everywhere truncated it to "small language".
 */
const HEAD_NOUNS = new Set(
  (
    "model models system systems method methods approach approaches architecture architectures" +
    " mechanism mechanisms network networks layer layers service services protocol protocols" +
    " technique techniques strategy strategies framework frameworks"
  ).split(" "),
);

const VERBS = new Set(
  (
    "offer offers offering provide provides providing enable enables enabling allow allows" +
    " allowing achieve achieves achieving dispensing expect expects reducing reduces" +
    " improving improves increasing increases relies rely uses using replaces replace" +
    " requires require produces produce lets let helps help"
  ).split(" "),
);

/**
 * Whether a phrase describes rather than names.
 *
 * An adjective or adverb at either end is modifying something. A verb anywhere
 * means the phrase is a clause: "attention allows the model" has a noun at each
 * end and is still a sentence fragment rather than the name of an idea.
 */
function isJudgement(phrase: string[]): boolean {
  const first = phrase[0]!;
  const last = phrase[phrase.length - 1]!;
  if (phrase.some((w) => VERBS.has(w))) return true;
  if (NOT_A_THING.has(first) || NOT_A_THING.has(last)) return true;
  // "sufficiently", "inherently", "significantly" — an adverb cannot start or
  // end the name of a thing.
  return first.endsWith("ly") || last.endsWith("ly");
}

/**
 * The vocabulary of evaluation, which is not the vocabulary of ideas.
 *
 * "state-of-the-art bleu score", "wmt" and "english-to-french translation" are
 * how a paper reports what it achieved, not what it is about. They score well
 * because key points quote results, and they tell a reader nothing about how
 * two papers relate.
 */
const MEASUREMENT = new Set(
  (
    "bleu rouge meteor perplexity f1 auc accuracy precision recall score scores metric metrics" +
    " benchmark benchmarks baseline baselines dataset datasets corpus corpora testbed" +
    " wmt glue superglue squad imagenet coco mnist cifar sota state-of-the-art" +
    " epochs epoch parameters flops gpu gpus tpu hours seconds"
  ).split(" "),
);

const WORD = /[a-z][a-z0-9-]*/g;

/** Beyond this a phrase has stopped being a term and become a clause. */
const MAX_TERM_CHARS = 34;

/** How often a bare word must appear in the paper before it counts as a topic. */
const MIN_SINGLE_WORD_USES = 5;

function occurrences(haystack: string, word: string): number {
  let count = 0;
  let at = haystack.indexOf(word);
  while (at !== -1 && count < MIN_SINGLE_WORD_USES) {
    count++;
    at = haystack.indexOf(word, at + word.length);
  }
  return count;
}

/** Phrases of up to four words, which is where technical terms live. */
function candidates(text: string): string[] {
  const out: string[] = [];
  // Sentence-ish boundaries, so a phrase never spans a full stop.
  for (const clause of text
    .toLowerCase()
    .split(/[.,;:()"“”]|\s+-\s+|\b(?:and|or|but|while|whereas|because|which|that)\b/)) {
    const words = clause.match(WORD) ?? [];
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 4 && i + n <= words.length; n++) {
        const phrase = words.slice(i, i + n);
        // A phrase may not begin or end on a stopword: "of the network" and
        // "the network is" are both really "network".
        const first = phrase[0]!;
        const last = phrase[phrase.length - 1]!;
        if (STOP.has(first) || STOP.has(last)) continue;
        // A head noun may finish a term but never start one, and never be one.
        if (HEAD_NOUNS.has(first)) continue;
        if (HEAD_NOUNS.has(last) && phrase.length < 2) continue;
        if (phrase.some((w) => w.length < 3)) continue;
        if (isJudgement(phrase)) continue;
        // A term built on how the work was measured is a result, not an idea.
        if (phrase.some((w) => MEASUREMENT.has(w))) continue;
        // "english-to-french translation" names the run, not the idea. A
        // language pair is always an experimental setting.
        if (phrase.some((w) => /^[a-z]+-to-[a-z]+$/.test(w))) continue;
        const term = phrase.join(" ");
        if (term.length > MAX_TERM_CHARS) continue;
        out.push(term);
      }
    }
  }
  return out;
}

/** How much a term earns for the paper having given it a section of its own. */
const HEADING_BOOST = 3;

/** Longer phrases win: "attention mechanism" says more than "attention". */
function specificity(term: string): number {
  return 1 + 0.6 * (term.split(" ").length - 1);
}

/**
 * The concepts one episode is about.
 *
 * `paperText` is what grounds them: a phrase the presenter used but the paper
 * never does is framing, not a concept.
 */
export function conceptsFor(
  keyPoints: string[],
  summary: string,
  paperText: string,
  /**
   * The paper's own section headings.
   *
   * The strongest signal available and previously unused. A paper names its
   * ideas in its headings — "Multi-Head Attention", "Segmented Storage",
   * "Offloading Redo Processing to Storage" — and never names its benchmarks
   * there. A term that appears in one is almost certainly what the paper is
   * about rather than what it happened to score.
   */
  headings: string[] = [],
  limit = 8,
): Concept[] {
  const paper = paperText.toLowerCase();
  const headingText = headings.join(" ยง ").toLowerCase();
  const counts = new Map<string, number>();
  const context = new Map<string, string>();

  // Key points count double: they are already a distillation of the episode,
  // where the summary is prose and repeats connective words.
  // Sentences, so a term can remember which one it came from.
  const sentences = [...keyPoints, ...summary.split(/(?<=[.!?])\s+/)].filter(Boolean);
  for (const [text, factor] of [
    [keyPoints.join(". "), 2],
    [summary, 1],
  ] as [string, number][]) {
    for (const term of candidates(text)) {
      if (!paper.includes(term)) continue;
      // A single word has to be something the paper actually dwells on. A
      // phrase has already earned its place by being a phrase.
      if (!term.includes(" ") && occurrences(paper, term) < MIN_SINGLE_WORD_USES)
        continue;
      counts.set(term, (counts.get(term) ?? 0) + factor);
      if (!context.has(term)) {
        const found = sentences.find((line) => line.toLowerCase().includes(term));
        if (found) context.set(term, found.trim());
      }
    }
  }
  if (counts.size === 0) return [];

  /*
   * One term per family, strongest first.
   *
   * "redo processing", "processing", "state-of-the-art bleu" and
   * "state-of-the-art bleu score" are four entries for two ideas, and showing
   * them all makes a map that looks busy and says less. Greedily keeping the
   * best-scoring member and dropping anything that contains it or is contained
   * by it leaves one representative each.
   */
  const ranked = [...counts.entries()]
    .map(([term, count]) => ({
      term,
      raw: count * specificity(term) * (headingText.includes(term) ? HEADING_BOOST : 1),
    }))
    .sort((a, b) => b.raw - a.raw);

  /*
   * Group terms that share any significant word, keeping the fullest name.
   *
   * Every match has to be merged, not just the first. "crash" and "recovery"
   * can each start a family before "crash recovery" arrives, and joining it to
   * whichever it met first left the other standing as a separate idea — which
   * is exactly how both "crash recovery" and "crash" ended up on the map.
   * Bridging terms now collapse every family they touch into one.
   */
  const kept: { term: string; raw: number; words: Set<string> }[] = [];
  for (const candidate of ranked) {
    const words = new Set(candidate.term.split(" "));
    const matches = kept.filter((k) => [...words].some((w) => k.words.has(w)));

    if (matches.length === 0) {
      kept.push({ ...candidate, words });
      continue;
    }

    // The surviving family is the first, so the ranking order is preserved.
    const family = matches[0]!;
    for (const other of matches.slice(1)) {
      for (const w of other.words) family.words.add(w);
      if (other.term.split(" ").length > family.term.split(" ").length) {
        family.term = other.term;
      }
      kept.splice(kept.indexOf(other), 1);
    }

    for (const w of words) family.words.add(w);
    if (candidate.term.split(" ").length > family.term.split(" ").length) {
      family.term = candidate.term;
    }
  }

  const scored = kept.slice(0, limit);

  const top = scored[0]?.raw ?? 1;
  return scored.map(({ term, raw }) => ({
    term,
    weight: raw / top,
    context: context.get(term) ?? term,
  }));
}

/**
 * Build the map across a whole library.
 *
 * Two concepts are linked when an episode covers both, and the link records
 * which episodes those are — the edge answers "why are these related" with a
 * list rather than a line.
 */
export function buildConceptMap(
  episodes: (EpisodeSummary & { concepts: Concept[] })[],
): ConceptMap {
  const nodes = new Map<string, ConceptNode>();
  const edges = new Map<string, ConceptEdge>();
  const byEpisode: Record<string, Concept[]> = {};

  for (const episode of episodes) {
    byEpisode[episode.id] = episode.concepts;

    for (const { term, weight } of episode.concepts) {
      const node = nodes.get(term) ?? { term, episodes: [], weight: 0 };
      node.episodes.push(episode.id);
      node.weight += weight;
      nodes.set(term, node);
    }

    const terms = episode.concepts.map((c) => c.term).sort();
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const key = `${terms[i]} ${terms[j]}`;
        const edge = edges.get(key) ?? { a: terms[i]!, b: terms[j]!, episodes: [] };
        edge.episodes.push(episode.id);
        edges.set(key, edge);
      }
    }
  }

  return {
    concepts: [...nodes.values()].sort(
      (a, b) => b.episodes.length - a.episodes.length || b.weight - a.weight,
    ),
    edges: [...edges.values()],
    byEpisode,
  };
}

/** Concepts covered by more than one episode — where the library connects. */
export function sharedConcepts(map: ConceptMap): ConceptNode[] {
  return map.concepts.filter((c) => c.episodes.length > 1);
}
