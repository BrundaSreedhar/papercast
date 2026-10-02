/**
 * Who wrote a paper, and where they work, read from its title page.
 *
 * Episodes do not name a paper's authors. A welcome that reads out fourteen
 * names is a minute nobody listens to, and the names are the part of a paper a
 * listener needs least. Where the work comes from is worth saying, though —
 * "researchers at Google Brain" — so both halves of the author block matter:
 * the names, so the eval can tell when one slipped into a script, and the
 * affiliations, so the writer can say something true instead.
 *
 * The author block is everything between the title and the abstract. Once
 * flattened it is names, footnote markers on their own lines ("∗", "1,2,3,∗"),
 * affiliations, and email addresses, in an order that depends on the layout.
 * Each line is classified on its own, so the order does not matter.
 */
import type { PaperStructure } from "./extract";

export interface FrontMatter {
  /** Author names, as printed: "Ashish Vaswani", "Aidan N. Gomez". */
  authors: string[];
  /** Where they work, as printed and without footnote markers. */
  affiliations: string[];
}

/** The author block never runs longer than this before the abstract. */
const MAX_LINES = 80;

/**
 * Words that make a capitalized phrase an institution rather than a person.
 * "Google Brain" and "Microsoft Research" have a person's shape — two
 * capitalized words — and only the vocabulary tells them apart.
 */
const INSTITUTION = new Set(
  (
    "university universität université universidad college school institute institution " +
    "laboratory laboratories lab labs center centre department faculty academy foundation " +
    "research brain deepmind google microsoft nvidia amazon meta facebook openai anthropic " +
    "apple ibm intel alibaba tencent baidu huawei bytedance samsung salesforce adobe " +
    "inc ltd llc corporation corp company team group ai technology technologies science " +
    "sciences engineering computer computing national state services web cloud"
  ).split(" "),
);

/** A title-page line that is a prize or programme, not a place of work. */
const NOT_AN_AFFILIATION =
  /\b(winner|challenge|award|prize|workshop|conference|preprint)\b/i;

/** Lowercase words an affiliation may contain: "School of Computer Science and …". */
const AFFILIATION_SMALL_WORDS = new Set(
  "of and for at the de del la le für in on".split(" "),
);

/** One capitalized name word: "Ashish", "Ray-Chaudhuri", "Łukasz", or an initial "N.". */
const NAME_WORD = /^(?:\p{Lu}[\p{Ll}'’-]+(?:-\p{Lu}[\p{Ll}'’-]+)?|\p{Lu}\.)$/u;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The lines between the title and the abstract. */
function authorBlock(paper: PaperStructure): string[] {
  const text =
    paper.source?.text ??
    paper.sections.find((s) => s.heading === "Preamble")?.content ??
    "";
  const lines = text.split("\n").map((l) => l.trim());
  const end = lines.findIndex(
    (l, i) => i > 0 && (/^abstract\b/i.test(l) || /^1\.?\s+introduction\b/i.test(l)),
  );
  const block = lines.slice(0, end === -1 ? MAX_LINES : Math.min(end, MAX_LINES));

  // Drop the title, which can wrap across lines and has a person's shape in
  // places ("Small Models, Big Support"), and anything above it.
  const title = norm(paper.title);
  let start = 0;
  block.forEach((l, i) => {
    if (l && title && title.includes(norm(l)) && norm(l).length > 3) start = i + 1;
  });
  return block.slice(start).filter(Boolean);
}

/** A line split into the pieces a name or an affiliation could be. */
function pieces(line: string): string[] {
  return (
    line
      // Names laid out side by side and run together by extraction:
      // "Kaiming HeXiangyu Zhang" is two people.
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1|$2")
      .split(/\||,|;|\s{2,}|\s+and\s+|[∗*†‡§¶]|\b\d+(?:,\d+)*\b/u)
      .map((p) => p.trim())
      .filter(Boolean)
  );
}

/** Whether a word marks an institution: "Research", "University", "Google". */
export function isInstitutionWord(word: string): boolean {
  return INSTITUTION.has(word.toLowerCase().replace(/[.'’,]/g, ""));
}

function isPerson(piece: string): boolean {
  const words = piece.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every((w) => NAME_WORD.test(w))) return false;
  // At least one real word, not only initials.
  if (!words.some((w) => w.length > 2 && !w.endsWith("."))) return false;
  return !words.some((w) => INSTITUTION.has(w.toLowerCase().replace(/[.'’]/g, "")));
}

function isAffiliation(line: string): boolean {
  if (line.includes("@") || NOT_AN_AFFILIATION.test(line) || line.length > 90)
    return false;
  const words = line.split(/\s+/).map((w) => w.replace(/[,.;:()]/g, ""));
  if (!words.some((w) => INSTITUTION.has(w.toLowerCase()))) return false;
  // A sentence ("…hereby grants permission…") is not a place of work.
  return words.every(
    (w) => !/^\p{Ll}/u.test(w) || AFFILIATION_SMALL_WORDS.has(w.toLowerCase()),
  );
}

/** The authors and affiliations printed on a paper's title page. */
export function frontMatter(paper: PaperStructure): FrontMatter {
  const authors: string[] = [];
  const affiliations: string[] = [];
  for (const line of authorBlock(paper)) {
    const bare = line.replace(/^[\d∗*†‡§¶,\s]+/u, "").trim();
    if (!bare) continue;
    if (isAffiliation(bare)) {
      if (!affiliations.includes(bare)) affiliations.push(bare);
      continue;
    }
    if (bare.includes("@")) continue;
    for (const p of pieces(bare)) {
      if (isPerson(p) && !authors.includes(p)) authors.push(p);
    }
  }
  return { authors, affiliations };
}
