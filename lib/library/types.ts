import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";
import type { TurnCitation } from "../ground/index";
import type { TurnTiming } from "../tts/types";
import type { JobCost, JobReview } from "../jobs/types";
import type { PaperConcept, PaperRelation } from "../concepts/extract";

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
  /**
   * Which backend voiced this episode, and with which voices.
   *
   * Stored because answering a question out loud later has to sound like the
   * episode it is about. Without it the answer is spoken by whatever
   * `TTS_PROVIDER` happens to say today, so changing the setting silently gives
   * every past episode a new narrator — which is exactly what happened.
   */
  ttsProvider?: string;
  voices?: string;
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
  /**
   * The paper's key concepts, named by a model and grounded in the paper.
   *
   * Stored rather than derived like the lexical fallback, because producing
   * them costs a model call, and a page anyone can open must not make one.
   * Absent on episodes made before extraction existed or where it failed;
   * `npm run concepts` fills them in.
   */
  concepts?: PaperConcept[];
  /**
   * How those concepts relate, each with the passage that says so.
   *
   * Present, possibly empty, whenever `concepts` came from a run that asked for
   * relations; absent on records from before that.
   */
  relations?: PaperRelation[];
}

/** What the library list shows, without the weight of a whole episode. */
export type EpisodeSummary = Omit<
  EpisodeRecord,
  "episode" | "citations" | "timings" | "paper" | "concepts" | "relations"
>;

export function toSummary(record: EpisodeRecord): EpisodeSummary {
  const {
    episode: _e,
    citations: _c,
    timings: _t,
    paper: _p,
    concepts: _k,
    relations: _r,
    ...summary
  } = record;
  return summary;
}
