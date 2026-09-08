import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";
import type { TurnCitation } from "../ground/index";
import type { TurnTiming } from "../tts/types";
import type { JobCost, JobReview } from "../jobs/types";

/**
 * A finished episode, kept after the job that made it has gone.
 *
 * Jobs live in memory and are evicted within the hour, which is right for a
 * job — it is a unit of work, not a thing anyone keeps. An episode is the
 * opposite: it took minutes and real money to produce, and a listener expects
 * to find it again tomorrow.
 *
 * The paper travels with the record rather than being re-extracted on demand.
 * Extraction is deterministic, so re-running it would give the same answer, but
 * only if the original PDF is still around — and in the deployed demo it is a
 * file in the image, while locally it was a upload that no longer exists
 * anywhere. Keeping it also means the citations in this record and any answer
 * given about the paper later are resolved against exactly the same text.
 */
export interface EpisodeRecord {
  /** The id of the job that produced it, and the audio file's stem. */
  id: string;
  createdAt: number;
  paperTitle: string;
  /** Catalogue id, when the paper came from the demo shelf. */
  paperId?: string;
  /** Length the episode was generated for, in minutes. */
  minutes: number;
  /** Which voice arrangement produced it. */
  format: "dialogue" | "solo" | "eli5";
  provider?: string;
  model?: string;
  turnCount: number;
  totalMs?: number;
  /** False when the run produced a transcript only. */
  hasAudio: boolean;
  transcriptRecall?: number;
  review?: JobReview;
  cost?: JobCost;

  /**
   * The episode's own summary and key points, lifted to the top level.
   *
   * They live inside `episode` too, but the shelf shows them and the shelf
   * deliberately never loads a whole transcript — a list of twenty episodes
   * would mean reading twenty papers off disk to print twenty paragraphs.
   */
  summary: string;
  keyPoints: string[];

  episode: Episode;
  citations?: TurnCitation[];
  timings?: TurnTiming[];
  /** The paper as every model saw it, so later answers cite the same text. */
  paper: PaperStructure;
}

/** What the library list shows, without the weight of a whole episode. */
export type EpisodeSummary = Omit<
  EpisodeRecord,
  "episode" | "citations" | "timings" | "paper"
>;

export function toSummary(record: EpisodeRecord): EpisodeSummary {
  const { episode: _e, citations: _c, timings: _t, paper: _p, ...summary } = record;
  return summary;
}
