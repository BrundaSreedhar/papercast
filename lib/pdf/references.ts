/**
 * Parsing a paper's reference list.
 *
 * Extraction strips references from the prose deliberately: showing a model a
 * bibliography invites it to cite works the paper never discussed. But thrown
 * away entirely they are a loss, because they are the one *grounded* answer to
 * "what should I read next" — the authors' own statement of what this work
 * builds on, rather than a model's guess.
 *
 * So they are removed from the text the model sees and kept as structured data
 * beside it.
 */

export interface Reference {
  /** Position in the bibliography, when numbered. */
  index?: number;
  /** The entry as printed, with line wrapping undone. */
  raw: string;
  /** Best guess at the work's title. */
  title?: string;
  /** Year, when one is present. */
  year?: number;
}

/** Where the reference list starts, or -1. */
export function findReferencesStart(text: string): number {
  // The heading is often numbered ("11. REFERENCES"), so leading numbering is
  // optional here just as it is in the section classifier.
  const m = text.match(/\n\s*(?:\d+\.?\s*)?(references|bibliography)\s*\n/i);
  return m?.index !== undefined ? m.index + m[0].length : -1;
}

/**
 * Pull a probable title out of an entry.
 *
 * Entries begin with authors and end with a venue and year. The title is the
 * sentence between them, which is usually the longest full-stop-delimited piece
 * that is not an initialled name list.
 */
function guessTitle(raw: string): string | undefined {
  const parts = raw
    .split(/\.\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const candidates = parts.filter((p) => {
    if (p.split(/\s+/).length < 3) return false;
    // "B. Calder, J. Wang, et al" — mostly initials and commas.
    const initials = (p.match(/\b[A-Z]\./g) ?? []).length;
    return initials < 2;
  });
  if (candidates.length === 0) return undefined;
  return candidates
    .reduce((a, b) => (b.length > a.length ? b : a))
    .replace(/[.,;]+$/, "");
}

/**
 * Parse a reference list into entries.
 *
 * Numbered bibliographies are split on their markers. Unnumbered ones fall back
 * to blank-line separation, which is less reliable but better than returning
 * nothing.
 */
export function parseReferences(text: string): Reference[] {
  const start = findReferencesStart(text);
  if (start === -1) return [];

  // Stop at an appendix, which follows the bibliography in many papers.
  const after = text.slice(start);
  const appendix = after.search(/\n\s*appendix\b/i);
  const body = appendix === -1 ? after : after.slice(0, appendix);

  const numbered = [...body.matchAll(/\[(\d+)\]\s*([\s\S]*?)(?=\n?\[\d+\]|$)/g)];
  const entries: Reference[] =
    numbered.length >= 3
      ? numbered.map((m) => ({
          index: Number(m[1]),
          raw: m[2]!.replace(/\s+/g, " ").trim(),
        }))
      : body
          .split(/\n\s*\n/)
          .map((p) => p.replace(/\s+/g, " ").trim())
          .filter((p) => p.length > 30)
          .map((raw) => ({ raw }));

  return (
    entries
      .filter((e) => e.raw.length > 20)
      // Bibliographies carry manuals, specifications and bare links alongside
      // papers. They are real citations but not things to go and read next.
      .filter(
        (e) => !/https?:\/\/|available at|\bmanual\b|\bdocumentation\b/i.test(e.raw),
      )
      .map((e) => {
        const year = e.raw.match(/\b(19|20)\d{2}\b/);
        return {
          ...e,
          title: guessTitle(e.raw),
          year: year ? Number(year[0]) : undefined,
        };
      })
  );
}

/** Normalize a title for comparison across sources. */
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two titles refer to the same work.
 *
 * Compared by word overlap rather than exact match, because a title in a
 * bibliography is abbreviated, wrapped, and punctuated differently from the
 * same title on its own front page.
 */
export function titlesMatch(a: string, b: string): boolean {
  const wa = new Set(
    normalizeTitle(a)
      .split(" ")
      .filter((w) => w.length > 3),
  );
  const wb = new Set(
    normalizeTitle(b)
      .split(" ")
      .filter((w) => w.length > 3),
  );
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}
