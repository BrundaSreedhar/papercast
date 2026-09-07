/**
 * Section-aware extraction of an academic paper.
 *
 * The valuable, model-facing work here is NOT "get the text" — it's producing
 * *clean, structured* text: dropping the reference list, appendices, and figure
 * caption noise that otherwise pollute a summary and invite hallucinated
 * citations. The parsing logic is a pure function so it can be unit-tested
 * without a real PDF.
 */

import { parseReferences, type Reference } from "./references";
import { figuresToText } from "../vision/describe";
import type { FigureDescription } from "../vision/types";

/** One retained line of a section, and where it came from in the source text. */
export interface SourceLine {
  text: string;
  /** Offset of this line's first character in `PaperSource.text`. */
  at: number;
}

export interface PaperSection {
  heading: string;
  content: string;
  /**
   * The lines `content` was rebuilt from, each carrying its offset in the
   * source text.
   *
   * Content is not a slice of the paper — caption lines and stray page numbers
   * are dropped from inside a block and what is left is rejoined — so there is
   * no single range to record. Provenance is therefore kept a level down, per
   * line, which is enough to resolve any position in `content` back to a
   * position in the PDF, and from there to a page.
   *
   * Absent when a structure was parsed from bare text rather than a PDF.
   */
  lines?: SourceLine[];
}

/** Where one page sits inside `PaperSource.text`. */
export interface PageSpan {
  /** 1-based, as a reader would count it. */
  page: number;
  /** Character range within the source text, end-exclusive. */
  start: number;
  end: number;
}

/**
 * The paper's text before structuring, with page boundaries kept.
 *
 * Structured extraction throws away exactly what a citation needs: it drops the
 * reference list, reorders nothing but keeps no offsets, and strips page numbers
 * as artifacts. So the flat text is retained alongside it, and every page is
 * recorded as a character range into that one string. Anything found in the text
 * can then be resolved to the page it was printed on.
 */
export interface PaperSource {
  text: string;
  pages: PageSpan[];
}

export interface PaperStructure {
  title: string;
  abstract: string;
  /** Provenance for the abstract, which is lifted out of the sections. */
  abstractLines?: SourceLine[];
  sections: PaperSection[];
  /** Word count of retained content (title + abstract + sections). */
  wordCount: number;
  /**
   * Descriptions of figures and tables, when a vision model has read them.
   *
   * Held separately from `sections` because they are model-generated rather
   * than extracted, and everything downstream needs to be able to tell the
   * difference.
   */
  figures?: FigureDescription[];
  /**
   * The paper's bibliography.
   *
   * Kept out of the text the model sees — a visible reference list invites
   * fabricated citations — but retained here, because it is the authors' own
   * grounded statement of what this work builds on.
   */
  references?: Reference[];
  /**
   * The flat text and its page boundaries, when the paper came from a real PDF.
   * Absent when a structure was parsed from text alone, as the tests do, which
   * is why every consumer must treat citation as best-effort.
   */
  source?: PaperSource;
}

/** Bounds on how far a wrapped title may run before we stop joining lines. */
const MAX_TITLE_LINES = 3;
const MAX_TITLE_CHARS = 250;

/** Sections we drop wholesale — they add noise and invite fabricated citations. */
const STRIP_HEADINGS = [
  "references",
  "bibliography",
  "acknowledgment",
  "acknowledgments",
  "acknowledgement",
  "acknowledgements",
  "appendix",
  "appendices",
  "supplementary",
  "supplementary material",
];

/** Common unnumbered section titles found in papers. */
const KNOWN_HEADINGS = [
  "abstract",
  "introduction",
  "background",
  "related work",
  "prior work",
  "motivation",
  "method",
  "methods",
  "methodology",
  "approach",
  "model",
  "architecture",
  "experiments",
  "experimental setup",
  "results",
  "evaluation",
  "analysis",
  "discussion",
  "limitations",
  "future work",
  "conclusion",
  "conclusions",
  ...STRIP_HEADINGS,
];

/** Normalize a heading for comparison: lowercase, strip leading numbering. */
function normalizeHeading(line: string): string {
  return line
    .trim()
    .replace(/^\d+(\.\d+)*\.?\s*/, "") // "3.2 Model" -> "Model"
    .replace(/[:.]+$/, "")
    .toLowerCase()
    .trim();
}

/** Is a stripped section (references/appendix/etc.)? */
function isStripHeading(line: string): boolean {
  const n = normalizeHeading(line);
  return STRIP_HEADINGS.some((h) => n === h || n.startsWith(h + " ") || n === h + "s");
}

/**
 * Heuristic heading classifier. Academic PDFs vary wildly once flattened to
 * text, so we accept three signals: numbered headings, a known-title list, and
 * short ALL-CAPS lines.
 */
function isHeading(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line || line.length > 80) return false;

  const words = line.split(/\s+/);
  if (words.length > 10) return false;

  // (a) Numbered: "1 Introduction", "3.2. Model Architecture"
  if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(line)) return true;

  // (b) Known unnumbered heading (allow a trailing colon)
  const norm = normalizeHeading(line);
  if (KNOWN_HEADINGS.includes(norm)) return true;

  // (c) Short ALL-CAPS line, e.g. "RELATED WORK"
  if (/^[A-Z][A-Z0-9 :-]{2,60}$/.test(line) && words.length <= 8) return true;

  return false;
}

/**
 * Detect an author or affiliation line, which marks the end of a wrapped title.
 * Not every paper leaves a blank line between the two, so the title joiner
 * needs a content signal as well as a layout one.
 */
function looksLikeAuthorLine(line: string): boolean {
  // Email addresses only ever appear in the author block.
  if (line.includes("@")) return true;

  // Affiliation keywords.
  if (
    /\b(universit|institute|department|college|laborator|labs?|school of|academy|research cent(er|re)|inc\.|ltd\.|llc|gmbh|corporation)\b/i.test(
      line,
    )
  ) {
    return true;
  }

  // "Firstname Lastname, …" — a personal name immediately followed by a comma.
  if (/^[A-Z][a-z]+\s+[A-Z][a-zA-Z.'’-]+\s*,/.test(line)) return true;

  // A comma-separated list of three or more fragments.
  if ((line.match(/,/g) ?? []).length >= 2) return true;

  return false;
}

/** Split text into lines, recording where each one starts. */
function splitLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    out.push({ text: line, at });
    at += line.length + 1; // the newline that separated them
  }
  return out;
}

/** Is this line a caption or a stray page number rather than prose? */
function isNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return false; // blank lines are paragraphing, not noise
  if (/^(figure|fig\.?|table|algorithm)\s*\d+\b/i.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  return false;
}

/**
 * Strip caption and page-number lines from a block, keeping offsets.
 *
 * Reproduces exactly what the string version did — drop noise lines, collapse
 * runs of blank lines to one, trim the ends — but line by line, so every
 * surviving line still knows where it came from. The blank-run test compares
 * against the empty string rather than a trimmed one because the original
 * collapsed literal `\n{3,}`, and a whitespace-only line broke that run.
 */
function cleanBlockLines(lines: SourceLine[]): SourceLine[] {
  const kept: SourceLine[] = [];
  for (const line of lines) {
    if (isNoise(line.text)) continue;
    if (line.text === "" && kept[kept.length - 1]?.text === "") continue;
    kept.push(line);
  }

  while (kept.length && kept[0]!.text.trim() === "") kept.shift();
  while (kept.length && kept[kept.length - 1]!.text.trim() === "") kept.pop();

  // The old `.trim()` also stripped whitespace inside the first and last lines.
  const first = kept[0];
  if (first) {
    const lead = first.text.length - first.text.trimStart().length;
    kept[0] = { text: first.text.trimStart(), at: first.at + lead };
  }
  const last = kept[kept.length - 1];
  if (last) kept[kept.length - 1] = { text: last.text.trimEnd(), at: last.at };

  return kept;
}

/** The text of a cleaned block, exactly as `content` holds it. */
function linesToContent(lines: SourceLine[]): string {
  return lines.map((l) => l.text).join("\n");
}

function countWords(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Parse flattened paper text into a clean structure. Pure and deterministic.
 */
export function parsePaperStructure(raw: string): PaperStructure {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\f/g, "\n");
  // Offsets index `text`, which is what `PaperSource.text` holds: the page
  // splitter applies the same normalization before recording page ranges, so
  // the two agree character for character.
  const sourceLines = splitLines(text);
  const lines = sourceLines.map((l) => l.text);

  // Title: the first substantial line, plus any wrapped continuation lines.
  // Flattened PDFs break a long title across several lines with no punctuation
  // to mark the join, so we keep appending until a blank line or a heading ends
  // the block — bounded so a title-less document can't swallow the body.
  let title = "";
  let firstContentIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length >= 4 && !isHeading(t)) {
      const parts = [t];
      let j = i + 1;
      while (
        j < lines.length &&
        parts.length < MAX_TITLE_LINES &&
        parts.join(" ").length < MAX_TITLE_CHARS
      ) {
        const next = lines[j]!.trim();
        if (!next || isHeading(next) || looksLikeAuthorLine(next)) break;
        parts.push(next);
        j++;
      }
      title = parts.join(" ").replace(/\s+/g, " ").trim();
      // `j` indexes the terminating blank/heading line, which the section loop
      // below still needs to see.
      firstContentIdx = j;
      break;
    }
  }

  // Group remaining lines into sections keyed by the latest heading.
  const sections: PaperSection[] = [];
  let currentHeading = "Preamble";
  let buffer: SourceLine[] = [];

  const flush = () => {
    const cleaned = cleanBlockLines(buffer);
    const content = linesToContent(cleaned);
    if (content) sections.push({ heading: currentHeading, content, lines: cleaned });
    buffer = [];
  };

  for (let i = firstContentIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeading(line)) {
      flush();
      currentHeading = line.trim().replace(/[:.]+$/, "");
    } else {
      buffer.push(sourceLines[i]!);
    }
  }
  flush();

  // Pull out the abstract; drop stripped sections (references/appendix/…).
  let abstract = "";
  let abstractLines: SourceLine[] | undefined;
  const kept: PaperSection[] = [];
  for (const s of sections) {
    const norm = normalizeHeading(s.heading);
    if (norm === "abstract") {
      abstract = s.content;
      abstractLines = s.lines;
      continue;
    }
    if (isStripHeading(s.heading)) continue;
    // Drop the leading "Preamble" bucket unless it holds real content.
    if (s.heading === "Preamble" && countWords(s.content) < 25) continue;
    kept.push(s);
  }

  // Fallback: no headings detected — keep the whole cleaned body, but still
  // truncate at a References/Bibliography marker if one appears.
  if (kept.length === 0 && !abstract) {
    // `firstContentIdx` counts lines, not characters. Slicing the text with it
    // used to chop a handful of characters off the front and leave the title
    // sitting in the body.
    let body = sourceLines.slice(firstContentIdx);
    const refAt = body.findIndex((l) =>
      /^\s*(references|bibliography)\s*$/i.test(l.text),
    );
    if (refAt !== -1) body = body.slice(0, refAt);
    const cleaned = cleanBlockLines(body);
    const content = linesToContent(cleaned);
    if (content) kept.push({ heading: "Body", content, lines: cleaned });
  }

  const references = parseReferences(text);

  const wordCount =
    countWords(title) +
    countWords(abstract) +
    kept.reduce((n, s) => n + countWords(s.content), 0);

  return {
    title,
    abstract,
    abstractLines,
    sections: kept,
    wordCount,
    ...(references.length ? { references } : {}),
  };
}

/** Render a structured paper back to plain text for a prompt. */
/** A run of rendered text that came verbatim from one line of the paper. */
export interface TextSegment {
  /** Range within the rendered text, end-exclusive. */
  from: number;
  to: number;
  /** Where this run starts in `PaperSource.text`. */
  at: number;
  /** The section it belongs to, for a citation a person can read. */
  heading: string;
}

export interface RenderedPaper {
  text: string;
  /**
   * Provenance for the parts of `text` that came from the paper. Headings,
   * markdown scaffolding and figure descriptions are deliberately absent: they
   * are this function's own words or a vision model's, and nothing that is not
   * the paper's own text may be cited as if it were.
   */
  segments: TextSegment[];
}

/**
 * Render the paper for a model, and record where every line of it came from.
 *
 * This is the string the writer and the judge both see, which is exactly why
 * citations must be resolved against it rather than against the raw PDF text.
 * The raw text still holds the reference list, running heads and page numbers
 * that extraction deliberately removed; searching it would let a quote match
 * inside a bibliography and produce a confident citation to a page the model
 * never read.
 */
export function renderPaper(paper: PaperStructure): RenderedPaper {
  const segments: TextSegment[] = [];
  let text = "";

  const addBlank = () => {
    if (text) text += "\n\n";
  };
  /** Append text that belongs to nobody — scaffolding, not the paper's words. */
  const addSynthetic = (s: string) => {
    text += s;
  };
  const addLines = (
    lines: SourceLine[] | undefined,
    fallback: string,
    heading: string,
  ) => {
    if (!lines || lines.length === 0) {
      addSynthetic(fallback);
      return;
    }
    lines.forEach((line, i) => {
      if (i > 0) addSynthetic("\n");
      const from = text.length;
      text += line.text;
      // A blank line carries no citable content and would only add noise to a
      // binary search that has to run for every quote.
      if (line.text) segments.push({ from, to: text.length, at: line.at, heading });
    });
  };

  if (paper.title) {
    addSynthetic(`# ${paper.title}`);
  }
  if (paper.abstract) {
    addBlank();
    addSynthetic("## Abstract\n");
    addLines(paper.abstractLines, paper.abstract, "Abstract");
  }
  for (const section of paper.sections) {
    addBlank();
    addSynthetic(`## ${section.heading}\n`);
    addLines(section.lines, section.content, section.heading);
  }
  const figures = figuresToText(paper.figures ?? []);
  if (figures) {
    addBlank();
    addSynthetic(figures);
  }

  return { text, segments };
}

/**
 * The paper as a model sees it.
 *
 * Delegates to `renderPaper` rather than assembling its own copy, so the string
 * the model is given and the string citations are resolved against cannot drift
 * apart. Figure descriptions are appended, labelled as derived, so they are
 * available to the writer and to the judge without being mistaken for the
 * paper's own words — and they carry no provenance, so they can never be cited.
 */
export function paperToText(paper: PaperStructure): string {
  return renderPaper(paper).text;
}

/** Separator between pages. Fixed here because the offsets depend on it. */
const PAGE_SEPARATOR = "\n\n";

/**
 * Extract the text one page at a time, and record where each page lands.
 *
 * The page renderer mirrors pdf-parse's own — same text-item joining, same
 * line-break rule — so the text is byte-for-byte what the rest of the pipeline
 * already parses. The joined string is then assembled here rather than taken
 * from pdf-parse's return value, so the recorded offsets cannot drift from the
 * text they index no matter what the library does internally.
 */
export async function extractSourceFromPdf(data: Buffer): Promise<PaperSource> {
  // Import the internal module directly to avoid pdf-parse's index debug path.
  const pdf = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const pageTexts: string[] = [];

  await pdf(data, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let text = "";
      for (const item of content.items) {
        text +=
          lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      // Normalized here, once, so that `PaperSource.text` is already in the
      // form the parser works in and a recorded offset means the same thing on
      // both sides. The replacements below are the parser's own.
      const normalized = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n");
      pageTexts.push(normalized);
      return normalized;
    },
  });

  let text = "";
  const pages: PageSpan[] = [];
  pageTexts.forEach((pageText, i) => {
    if (i > 0) text += PAGE_SEPARATOR;
    const start = i === 0 ? 0 : pages[i - 1]!.end;
    text += pageText;
    pages.push({ page: i + 1, start, end: text.length });
  });
  // Spans run edge to edge so every offset resolves. The separator between two
  // pages is an artifact this function introduced, and a line that lands in it
  // belongs to the page that just ended rather than to nothing at all.
  const lastPage = pages[pages.length - 1];
  if (lastPage) lastPage.end = text.length;

  return { text, pages };
}

/** Thin wrapper over pdf-parse; kept separate so parsing stays testable. */
export async function extractTextFromPdf(data: Buffer): Promise<string> {
  return (await extractSourceFromPdf(data)).text;
}

/** Full pipeline: PDF bytes -> clean, structured paper, with its pages kept. */
export async function extractPaper(data: Buffer): Promise<PaperStructure> {
  const source = await extractSourceFromPdf(data);
  return { ...parsePaperStructure(source.text), source };
}

/** The page a character offset in `source.text` falls on, if any. */
export function pageAt(source: PaperSource, offset: number): number | undefined {
  return source.pages.find((p) => offset >= p.start && offset < p.end)?.page;
}
