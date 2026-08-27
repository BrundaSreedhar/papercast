/**
 * A record of what has been studied, and what is left.
 *
 * Built from things the pipeline already produces rather than from a model
 * asked "what did they learn". A learnt item traces to a paper, a passage, and
 * a moment in the audio; a gap traces to an annotated contribution the episode
 * did not convey; a suggestion traces to the paper's own bibliography. Nothing
 * here is inferred about the reader — only recorded about the material.
 */

/** How confident we are that an item is grounded in the paper. */
export type Provenance =
  /** Verified claim-by-claim against the paper by the judge. */
  | "verified"
  /** Taken from the episode's key points; grounded, but not individually checked. */
  | "stated";

export interface LearnedItem {
  text: string;
  provenance: Provenance;
  /** Passage from the paper supporting it, when the judge supplied one. */
  evidence?: string;
  /** Dialogue turn where it was discussed, when known. */
  turnIndex?: number;
  /** Where in the audio it was said, so it can be replayed. */
  startMs?: number;
  firstSeen: string;
}

export interface StudiedEpisode {
  at: string;
  minutes: number;
  provider: string;
  model: string;
  turns: number;
  audioPath?: string;
  /** Share of the script found in the audio, when verification ran. */
  transcriptRecall?: number;
}

export interface SuggestedReading {
  title: string;
  year?: number;
  /** Papers in the library that cite this work. */
  citedBy: string[];
  /** Number of papers in the library citing it — the priority signal. */
  citations: number;
  /** Already present in the library. */
  inLibrary: boolean;
}

export interface PaperRecord {
  id: string;
  title: string;
  firstStudied: string;
  lastStudied: string;
  episodes: StudiedEpisode[];
  learned: LearnedItem[];
  /** Annotated contributions the episodes did convey. */
  covered: string[];
  /** Annotated contributions no episode conveyed — concrete gaps. */
  missed: string[];
  /** Titles from this paper's bibliography, for cross-referencing. */
  references: { title: string; year?: number }[];
}

export interface Ledger {
  version: 1;
  updatedAt: string;
  papers: Record<string, PaperRecord>;
}

export function emptyLedger(): Ledger {
  return { version: 1, updatedAt: new Date().toISOString(), papers: {} };
}
