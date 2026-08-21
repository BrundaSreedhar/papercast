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

export interface PaperSection {
  heading: string;
  content: string;
}

export interface PaperStructure {
  title: string;
  abstract: string;
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

/** Strip figure/table caption lines and page-number artifacts from a block. */
function cleanBlock(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return true; // keep blank lines for paragraphing; collapsed later
      if (/^(figure|fig\.?|table|algorithm)\s*\d+\b/i.test(t)) return false;
      if (/^\d+$/.test(t)) return false; // stray page numbers
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const lines = text.split("\n");

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
  let buffer: string[] = [];

  const flush = () => {
    const content = cleanBlock(buffer.join("\n"));
    if (content) sections.push({ heading: currentHeading, content });
    buffer = [];
  };

  for (let i = firstContentIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeading(line)) {
      flush();
      currentHeading = line.trim().replace(/[:.]+$/, "");
    } else {
      buffer.push(line);
    }
  }
  flush();

  // Pull out the abstract; drop stripped sections (references/appendix/…).
  let abstract = "";
  const kept: PaperSection[] = [];
  for (const s of sections) {
    const norm = normalizeHeading(s.heading);
    if (norm === "abstract") {
      abstract = s.content;
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
    let body = text.slice(firstContentIdx);
    const refMatch = body.search(/\n\s*(references|bibliography)\s*\n/i);
    if (refMatch !== -1) body = body.slice(0, refMatch);
    const cleaned = cleanBlock(body);
    if (cleaned) kept.push({ heading: "Body", content: cleaned });
  }

  const references = parseReferences(text);

  const wordCount =
    countWords(title) +
    countWords(abstract) +
    kept.reduce((n, s) => n + countWords(s.content), 0);

  return {
    title,
    abstract,
    sections: kept,
    wordCount,
    ...(references.length ? { references } : {}),
  };
}

/** Render a structured paper back to plain text for a prompt. */
export function paperToText(paper: PaperStructure): string {
  const parts: string[] = [];
  if (paper.title) parts.push(`# ${paper.title}`);
  if (paper.abstract) parts.push(`## Abstract\n${paper.abstract}`);
  for (const s of paper.sections) parts.push(`## ${s.heading}\n${s.content}`);
  // Figure descriptions are appended, labelled as derived, so they are
  // available to the writer and to the judge without being mistaken for the
  // paper's own words.
  const figures = figuresToText(paper.figures ?? []);
  if (figures) parts.push(figures);
  return parts.join("\n\n");
}

/** Thin wrapper over pdf-parse; kept separate so parsing stays testable. */
export async function extractTextFromPdf(data: Buffer): Promise<string> {
  // Import the internal module directly to avoid pdf-parse's index debug path.
  const pdf = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdf(data);
  return parsed.text ?? "";
}

/** Full pipeline: PDF bytes -> clean, structured paper. */
export async function extractPaper(data: Buffer): Promise<PaperStructure> {
  const raw = await extractTextFromPdf(data);
  return parsePaperStructure(raw);
}
