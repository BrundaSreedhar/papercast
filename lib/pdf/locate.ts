/**
 * Finding a quoted passage back in the paper it came from.
 *
 * The judge already returns a quote for every supported claim, and every claim
 * already carries the turn it came from. What has been missing is the last hop:
 * turning that quote into a place a reader can open.
 *
 * Two rules shape this.
 *
 * The search runs over the *rendered* paper — the exact string the writer and
 * the judge were given — never the raw PDF text. The raw text still holds the
 * reference list, running heads and page numbers that extraction deliberately
 * removed, and searching it would let a quote match inside a bibliography and
 * produce a confident citation to a page no model ever read. Rendering carries
 * per-line provenance, so a hit maps back to a real offset and from there to a
 * printed page.
 *
 * And it must never guess. A citation pointing at the wrong page is worse than
 * no citation, because a reader who clicks one and lands somewhere irrelevant
 * stops trusting all of them. A match below the confidence floor returns
 * nothing, and every citation says whether it was found exactly or
 * approximately.
 */
import {
  pageAt,
  renderPaper,
  type PaperStructure,
  type PaperSource,
  type RenderedPaper,
  type TextSegment,
} from "./extract";

/** A located passage: where it is, and how sure we are. */
export interface Citation {
  /** 1-based page number, as printed. */
  page: number;
  /** Last page the passage touches, when it runs across a page break. */
  pageEnd?: number;
  /** Section heading the passage sits under. */
  heading: string;
  /** The passage as it appears in the paper, not as it was quoted. */
  text: string;
  /** Character range within `PaperSource.text`, end-exclusive. */
  start: number;
  end: number;
  /** Exact means the quote was found verbatim once whitespace was normalized. */
  match: "exact" | "approximate";
  /** Share of the quote's words found in the matched window, 0–1. */
  score: number;
}

/**
 * Minimum share of a quote's words that must appear in a window before it is
 * offered. Set where an ordinary paraphrase still lands but an unrelated
 * paragraph sharing common technical vocabulary does not.
 */
const MIN_SCORE = 0.6;

/** Quotes shorter than this carry too little signal to place confidently. */
const MIN_WORDS = 4;

/** Distinct content words a quote needs before it can be placed at all. */
const MIN_CONTENT_WORDS = 4;

/** Tied best windows compared at most; enough for any real passage, bounded for speed. */
const MAX_TIED_WINDOWS = 400;

/** How much wider than the quote the search window runs. */
const WINDOW_SLACK = 1.6;

const WORD = /[a-z0-9]+/g;

/**
 * Words that carry no evidence of what a passage is about.
 *
 * Without this, overlap is dominated by the words every English sentence has.
 * A greeting — "Welcome to PaperCast, where we dive deep into the world of
 * academia" — shares *the, to, of, we, into, where* with any paragraph ever
 * written, which scored it above the threshold and earned it a confident
 * citation to a page about write amplification. Scoring on content words alone
 * is what makes an unmatchable turn score zero instead of a plausible half.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from had has have how i if in into is it its" +
    " may might more most no not of on or our out over should so some such than that the their them then" +
    " there these they this those to up was we were what when where which while who will with would you your" +
    " about across after all also any because been before both each even every here just like made make many" +
    " much new now only other same see still take through very well"
  ).split(" "),
);

/** The words in a string that actually say what it is about. */
function contentWords(s: string): string[] {
  return (s.toLowerCase().match(WORD) ?? []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w),
  );
}

/** A normalized view of a text, plus the map back to its original offsets. */
interface Normalized {
  text: string;
  /** `offsets[i]` is where `text[i]` came from in the original. */
  offsets: number[];
}

/**
 * Collapse whitespace and case so a quote can be compared to the paper.
 *
 * A hyphen immediately before a line break is the PDF wrapping a word across a
 * column edge, not part of the word, so it is dropped and the halves rejoin.
 */
function normalize(raw: string): Normalized {
  let text = "";
  const offsets: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    // A hyphen at a line break is the PDF wrapping a word across a column edge.
    // The newline after it must be swallowed with it, or the two halves rejoin
    // with a space and "availa-\nbility" reads as two words instead of one.
    if (ch === "-" && /^[\r\n]/.test(raw.slice(i + 1, i + 2))) {
      let j = i + 1;
      while (j < raw.length && /[\r\n]/.test(raw[j]!)) j++;
      i = j - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      offsets.push(i);
      pendingSpace = false;
    }
    text += ch.toLowerCase();
    offsets.push(i);
  }

  return { text, offsets };
}

function words(s: string): string[] {
  return s.toLowerCase().match(WORD) ?? [];
}

/**
 * Resolves quotes against one paper. Build it once, then call `find` per quote.
 *
 * Building is the expensive half — a judged episode resolves dozens of quotes
 * against the same document, and re-normalizing 70k characters for each one
 * turns a cheap lookup into a visible pause.
 */
export class PaperLocator {
  private readonly rendered: RenderedPaper;
  private readonly source: PaperSource | undefined;
  private readonly normalized: Normalized;
  /** Words of the normalized text, each with its offset in it. */
  private readonly tokens: { word: string; at: number }[] = [];

  constructor(paper: PaperStructure) {
    this.rendered = renderPaper(paper);
    this.source = paper.source;
    this.normalized = normalize(this.rendered.text);
    for (const m of this.normalized.text.matchAll(WORD)) {
      this.tokens.push({ word: m[0], at: m.index });
    }
  }

  /** True when this paper carries enough provenance to cite at all. */
  get canCite(): boolean {
    return this.source !== undefined && this.rendered.segments.length > 0;
  }

  /**
   * Locate a quote, or return undefined rather than a guess.
   *
   * `minScore` exists because the two callers want different bars. A judge's
   * evidence is near-verbatim and should be held to the default; a spoken turn
   * restates the paper in its own words and would almost never clear it, and a
   * reference there is a pointer to go read, not a claim that the wording
   * matches.
   */
  find(quote: string, minScore: number = MIN_SCORE): Citation | undefined {
    if (!this.canCite) return undefined;
    const wanted = words(quote);
    if (wanted.length < MIN_WORDS) return undefined;
    return this.findExact(quote) ?? this.findApproximate(wanted, minScore);
  }

  /** How many content words a quote has — below a handful, nothing is placeable. */
  static contentWordCount(quote: string): number {
    return new Set(contentWords(quote)).size;
  }

  private findExact(quote: string): Citation | undefined {
    const needle = normalize(quote).text;
    if (!needle) return undefined;
    const at = this.normalized.text.indexOf(needle);
    if (at !== -1) return this.toCitation(at, at + needle.length, "exact", 1);

    // The same passage with the spaces taken out of both sides. PDF extraction
    // loses the space between some words — "by more than2.0 BLEU", "ofN= 6" —
    // and a quote copied correctly from the prose then misses the exact match
    // over one space and falls through to the fuzzy one, which is where
    // citations end up with the wrong section's name.
    const squeezed = needle.replace(/ /g, "");
    if (squeezed.length < 12) return undefined;
    const { text, map } = this.squeezed();
    const hit = text.indexOf(squeezed);
    if (hit === -1) return undefined;
    return this.toCitation(map[hit]!, map[hit + squeezed.length - 1]! + 1, "exact", 1);
  }

  private squeezedCache?: { text: string; map: number[] };
  /** The normalized text without its spaces, with each character's position in it. */
  private squeezed(): { text: string; map: number[] } {
    if (!this.squeezedCache) {
      let text = "";
      const map: number[] = [];
      const n = this.normalized.text;
      for (let i = 0; i < n.length; i++) {
        if (n[i] === " ") continue;
        text += n[i];
        map.push(i);
      }
      this.squeezedCache = { text, map };
    }
    return this.squeezedCache;
  }

  /**
   * Slide a window the length of the quote across the paper's words and keep
   * the window sharing the most of them.
   *
   * Word overlap rather than edit distance: the failure being corrected is a
   * model dropping or reordering a few words, not mistyping them, and overlap
   * stays linear in the length of the paper where edit distance does not.
   */
  private findApproximate(wanted: string[], minScore: number): Citation | undefined {
    // Scored on distinct content words. Counting every occurrence would let a
    // window that repeats one term outrank a window that covers the whole
    // quote, and counting stopwords would let any prose match any prose.
    const want = new Set(wanted.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
    // The window is wider than the quote because the paper is usually the more
    // verbose of the two: a turn compresses a couple of sentences of careful
    // academic prose, so the passage carrying the same content words spans more
    // ground than the restatement of it does. Sizing the window to the quote
    // alone made turns that plainly track a passage score as unplaceable.
    const size = Math.min(this.tokens.length, Math.round(wanted.length * WINDOW_SLACK));
    if (want.size < MIN_CONTENT_WORDS || this.tokens.length < size) return undefined;

    // Distinct matches inside the sliding window, maintained incrementally.
    const seen = new Map<string, number>();
    let distinct = 0;
    const add = (w: string) => {
      if (!want.has(w)) return;
      const n = seen.get(w) ?? 0;
      seen.set(w, n + 1);
      if (n === 0) distinct++;
    };
    const drop = (w: string) => {
      if (!want.has(w)) return;
      const n = seen.get(w) ?? 0;
      seen.set(w, n - 1);
      if (n === 1) distinct--;
    };

    for (let i = 0; i < size; i++) add(this.tokens[i]!.word);

    // Every window that ties for the most matches is a candidate, not only the
    // first: the earliest of several equal windows is the one reaching furthest
    // back, and it tends to open in the section before the passage.
    let best = distinct;
    let starts = [0];
    for (let i = size; i < this.tokens.length; i++) {
      add(this.tokens[i]!.word);
      drop(this.tokens[i - size]!.word);
      if (distinct > best) {
        best = distinct;
        starts = [i - size + 1];
      } else if (distinct === best && starts.length < MAX_TIED_WINDOWS) {
        starts.push(i - size + 1);
      }
    }

    const score = best / want.size;
    if (score < minScore) return undefined;

    // Of the tied windows, the one whose matches sit closest together: the
    // passage itself is compact, and a window straddling a neighbour is not.
    let from = 0;
    let to = -1;
    for (const start of starts) {
      const span = this.tighten(start, Math.min(start + size, this.tokens.length), want);
      if (to < from || span.to - span.from < to - from) ({ from, to } = span);
    }

    const first = this.tokens[from]!;
    const last = this.tokens[to]!;
    return this.toCitation(first.at, last.at + last.word.length, "approximate", score);
  }

  /** The smallest span within [start, end) holding every quote word the window matched. */
  private tighten(
    start: number,
    end: number,
    want: Set<string>,
  ): { from: number; to: number } {
    // Narrow the window to the words that actually matched. The window runs
    // wider than the quote so a verbose passage still fits, and reporting its
    // raw edges would attribute a citation to whatever section the window
    // happened to open in — often the previous one.
    //
    // Narrowed to the smallest span that still holds every word that matched,
    // not merely to the first matching word: the sentence just before a passage
    // often shares a few of its words ("…improves accuracy and BLEU score" ahead
    // of "…by more than 2.0 BLEU … BLEU score of 28.4"), and stopping at the
    // first of them opened the citation in the previous section and named that.
    let from = start;
    let to = end - 1;
    const inSpan = new Map<string, number>();
    for (let i = from; i <= to; i++) {
      const w = this.tokens[i]!.word;
      if (want.has(w)) inSpan.set(w, (inSpan.get(w) ?? 0) + 1);
    }
    const spare = (i: number) => {
      const w = this.tokens[i]!.word;
      return !want.has(w) || (inSpan.get(w) ?? 0) > 1;
    };
    while (from < to && spare(from)) {
      const w = this.tokens[from]!.word;
      if (want.has(w)) inSpan.set(w, inSpan.get(w)! - 1);
      from++;
    }
    while (to > from && spare(to)) {
      const w = this.tokens[to]!.word;
      if (want.has(w)) inSpan.set(w, inSpan.get(w)! - 1);
      to--;
    }

    return { from, to };
  }

  /** The segment covering a position in the rendered text, by binary search. */
  private segmentAt(offset: number): TextSegment | undefined {
    const segs = this.rendered.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid]!;
      if (offset < seg.from) hi = mid - 1;
      else if (offset >= seg.to) lo = mid + 1;
      else return seg;
    }
    return undefined;
  }

  /** Map a normalized range back through the render to the paper, and page it. */
  private toCitation(
    from: number,
    to: number,
    match: Citation["match"],
    score: number,
  ): Citation | undefined {
    const source = this.source;
    if (!source) return undefined;

    const renderStart = this.normalized.offsets[from];
    // The end is exclusive, so it is taken from the last included character.
    const renderLast =
      this.normalized.offsets[Math.min(to, this.normalized.offsets.length) - 1];
    if (renderStart === undefined || renderLast === undefined) return undefined;

    const startSeg = this.segmentAt(renderStart);
    const endSeg = this.segmentAt(renderLast);
    // A hit that begins in scaffolding — a heading, or a figure description —
    // is not the paper speaking, and must not be cited as though it were.
    if (!startSeg) return undefined;

    const start = startSeg.at + (renderStart - startSeg.from);
    const end = endSeg
      ? endSeg.at + (renderLast - endSeg.from) + 1
      : startSeg.at + (startSeg.to - startSeg.from);

    const page = pageAt(source, start);
    if (page === undefined) return undefined;
    const pageEnd = pageAt(source, Math.max(start, end - 1));

    return {
      page,
      ...(pageEnd !== undefined && pageEnd !== page ? { pageEnd } : {}),
      heading: startSeg.heading,
      text: this.rendered.text
        .slice(renderStart, renderLast + 1)
        .replace(/\s+/g, " ")
        .trim(),
      start,
      end,
      match,
      score,
    };
  }
}

/** Convenience for a single lookup; prefer the class when resolving many. */
export function locateQuote(paper: PaperStructure, quote: string): Citation | undefined {
  return new PaperLocator(paper).find(quote);
}
