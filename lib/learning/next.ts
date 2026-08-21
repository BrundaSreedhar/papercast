/**
 * What is left to learn.
 *
 * Everything here is derived from the record rather than guessed. A gap is a
 * contribution the annotations name and no episode conveyed. A suggested
 * reading is a work the papers already studied actually cite. Neither asks a
 * model what to read next, which would be unfalsifiable and would undo the one
 * property the rest of the project is built on.
 */
import { titlesMatch } from "../pdf/references";
import type { Ledger, SuggestedReading } from "./types";

export interface Gap {
  paperId: string;
  paperTitle: string;
  /** A key contribution the annotations list that no episode conveyed. */
  contribution: string;
}

/** Contributions no episode has covered, across every paper studied. */
export function openGaps(ledger: Ledger): Gap[] {
  return Object.values(ledger.papers).flatMap((p) =>
    p.missed.map((contribution) => ({
      paperId: p.id,
      paperTitle: p.title,
      contribution,
    })),
  );
}

/**
 * Works worth reading next, ranked by how many studied papers cite them.
 *
 * A work cited by several papers already read is, by the authors' own
 * reckoning, foundational to the area being studied — which is a stronger and
 * far more checkable signal than a model's opinion.
 */
export function suggestedReadings(ledger: Ledger, limit = 10): SuggestedReading[] {
  const papers = Object.values(ledger.papers);
  const byTitle = new Map<string, SuggestedReading>();

  for (const paper of papers) {
    // Count each cited work once per citing paper, however often it appears.
    const seenHere = new Set<string>();
    for (const ref of paper.references) {
      const key = [...byTitle.keys()].find((k) => titlesMatch(k, ref.title)) ?? ref.title;
      if (seenHere.has(key)) continue;
      seenHere.add(key);

      const entry = byTitle.get(key) ?? {
        title: ref.title,
        year: ref.year,
        citedBy: [],
        citations: 0,
        inLibrary: false,
      };
      entry.citedBy.push(paper.title);
      entry.citations += 1;
      byTitle.set(key, entry);
    }
  }

  // A cited work already studied is not a suggestion; it is history.
  for (const [key, entry] of byTitle) {
    entry.inLibrary = papers.some((p) => titlesMatch(p.title, key));
  }

  return [...byTitle.values()]
    .filter((e) => !e.inLibrary)
    .sort((a, b) => b.citations - a.citations || (b.year ?? 0) - (a.year ?? 0))
    .slice(0, limit);
}

export interface Summary {
  papers: number;
  episodes: number;
  learned: number;
  verified: number;
  gaps: number;
}

export function summarize(ledger: Ledger): Summary {
  const papers = Object.values(ledger.papers);
  const learned = papers.flatMap((p) => p.learned);
  return {
    papers: papers.length,
    episodes: papers.reduce((n, p) => n + p.episodes.length, 0),
    learned: learned.length,
    verified: learned.filter((l) => l.provenance === "verified").length,
    gaps: papers.reduce((n, p) => n + p.missed.length, 0),
  };
}
