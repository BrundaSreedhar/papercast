/**
 * Turning a finished episode into ledger entries.
 *
 * Two sources of learnt items, in order of confidence. When the judge has run,
 * its supported claims are used: each was checked against the paper and carries
 * the passage that supports it. When it has not, the episode's key points are
 * used instead — grounded in the paper, but not individually verified.
 *
 * Recording degrades rather than refusing, because the alternative is a history
 * that only exists for runs somebody paid to evaluate.
 */
import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";
import type { ClaimVerdict, CoverageReport } from "../eval/types";
import type { TurnTiming } from "../tts/types";
import type { LearnedItem, Ledger, PaperRecord, StudiedEpisode } from "./types";

export interface RecordInput {
  paperId: string;
  paper: PaperStructure;
  episode: Episode;
  provider: string;
  model: string;
  minutes: number;
  timings?: TurnTiming[];
  audioPath?: string;
  transcriptRecall?: number;
  /** Judge output, when an evaluation ran. */
  verdicts?: ClaimVerdict[];
  coverage?: CoverageReport;
}

/** Locate the turn a claim came from, so it can be replayed. */
function findTurn(episode: Episode, text: string): number | undefined {
  const words = text
    .toLowerCase()
    .match(/[a-z][a-z0-9'-]{4,}/g)
    ?.slice(0, 8);
  if (!words?.length) return undefined;

  let best = -1;
  let bestScore = 0;
  episode.turns.forEach((turn, i) => {
    const lower = turn.text.toLowerCase();
    const score = words.filter((w) => lower.includes(w)).length / words.length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  // Below roughly half the distinctive words in common, the match is a guess
  // and a wrong timestamp is worse than none.
  return bestScore >= 0.5 && best >= 0 ? best : undefined;
}

function toItems(input: RecordInput, now: string): LearnedItem[] {
  const { episode, verdicts } = input;

  const source = verdicts?.length
    ? verdicts
        .filter((v) => v.verdict === "supported")
        .map((v) => ({ text: v.claim, evidence: v.evidence, provenance: "verified" as const }))
    : episode.keyPoints.map((text) => ({
        text,
        evidence: undefined,
        provenance: "stated" as const,
      }));

  return source.map(({ text, evidence, provenance }) => {
    const turnIndex = findTurn(episode, text);
    const timing =
      turnIndex !== undefined
        ? input.timings?.find((t) => t.turnIndex === turnIndex)
        : undefined;
    return {
      text,
      provenance,
      ...(evidence ? { evidence } : {}),
      ...(turnIndex !== undefined ? { turnIndex } : {}),
      ...(timing ? { startMs: Math.round(timing.startMs) } : {}),
      firstSeen: now,
    };
  });
}

/** Two items are the same thing if their wording matches once normalized. */
function sameItem(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

/**
 * Add an episode to the ledger.
 *
 * Re-studying a paper adds to what is known rather than replacing it: new items
 * are appended, and an item already present keeps its original date, because
 * the useful fact is when it was first met. A verified item supersedes a merely
 * stated one, since the same fact checked is worth more than the fact asserted.
 */
export function recordEpisode(ledger: Ledger, input: RecordInput): Ledger {
  const now = new Date().toISOString();
  const existing = ledger.papers[input.paperId];

  const episodeRecord: StudiedEpisode = {
    at: now,
    minutes: input.minutes,
    provider: input.provider,
    model: input.model,
    turns: input.episode.turns.length,
    ...(input.audioPath ? { audioPath: input.audioPath } : {}),
    ...(input.transcriptRecall !== undefined
      ? { transcriptRecall: input.transcriptRecall }
      : {}),
  };

  const incoming = toItems(input, now);
  const learned = [...(existing?.learned ?? [])];
  for (const item of incoming) {
    const at = learned.findIndex((l) => sameItem(l.text, item.text));
    if (at === -1) {
      learned.push(item);
    } else if (learned[at]!.provenance === "stated" && item.provenance === "verified") {
      learned[at] = { ...item, firstSeen: learned[at]!.firstSeen };
    }
  }

  const record: PaperRecord = {
    id: input.paperId,
    title: input.paper.title || input.paperId,
    firstStudied: existing?.firstStudied ?? now,
    lastStudied: now,
    episodes: [...(existing?.episodes ?? []), episodeRecord],
    learned,
    covered: input.coverage
      ? [...new Set([...(existing?.covered ?? []), ...input.coverage.hit])]
      : (existing?.covered ?? []),
    // A contribution covered by any episode is no longer missing, even if this
    // particular one skipped it.
    missed: input.coverage
      ? input.coverage.missed.filter(
          (m) => ![...(existing?.covered ?? []), ...input.coverage!.hit].includes(m),
        )
      : (existing?.missed ?? []),
    references: (input.paper.references ?? [])
      .filter((r) => r.title)
      .map((r) => ({ title: r.title!, ...(r.year ? { year: r.year } : {}) })),
  };

  return { ...ledger, papers: { ...ledger.papers, [input.paperId]: record } };
}
