/**
 * Judge, repair, judge again — and keep whichever episode scored better.
 *
 * This is the one place where evaluation stops being a report and starts being
 * a control loop. Everything it needs already existed: the judge decomposes an
 * episode into claims and marks each against the paper, and the reviser
 * rewrites a turn given the verdict on it. What was missing was the wire
 * between them.
 *
 * Two properties keep the loop honest:
 *
 * 1. Every round is re-judged in full, not just the turns that changed. A
 *    rewrite can introduce a new error, and a partial re-check would not see
 *    it. That costs a second judge pass; prompt caching on the paper absorbs
 *    most of it.
 * 2. The result is the best-scoring round, not the last one. Revision is not
 *    guaranteed to improve anything, so a round that makes the episode worse is
 *    discarded and the previous one stands. Without that, "self-correction"
 *    would be an unfalsifiable claim — exactly what the rest of this project
 *    exists to avoid.
 *
 * Deliberately *not* agentic about which fixes to attempt: the failing set is
 * derived from the verdicts, not chosen by a model.
 */
import { extractClaims, scoreFaithfulness, verifyClaims } from "../eval/judge";
import type { FaithfulnessReport } from "../eval/types";
import { reviseEpisode, type RevisionNote } from "../llm/revise";
import type { Episode } from "../llm/schema";
import type { LLMProvider, Usage } from "../llm/types";
import { addUsage } from "../llm/usage";
import type { PaperStructure } from "../pdf/extract";
import { withSpan } from "../trace/tracer";
import * as A from "../trace/attributes";

export interface RefineOptions {
  /** Model that rewrites the flagged turns. */
  provider: LLMProvider;
  /**
   * Model that grades. Defaults to `provider`. Passing a different one avoids
   * a model grading its own repairs, which is the same self-preference concern
   * the eval harness already flags.
   */
  judgeProvider?: LLMProvider;
  /** Revision rounds to attempt. Each round costs one revise + one judge pass. */
  maxRounds?: number;
  /**
   * Stop early once the hallucination rate is at or below this. Chasing the
   * last vague claim costs a full round for a change no listener would notice.
   */
  targetHallucinationRate?: number;
  onProgress?: (round: number, of: number, message: string) => void;
}

export interface RefineRound {
  /** 0 is the episode as generated; 1+ are revisions. */
  round: number;
  faithfulness: FaithfulnessReport;
  /** Claims that failed and were sent back for repair. */
  failures: number;
  /** Turn indices the reviser actually changed to produce this round. */
  revisedTurns: number[];
}

export interface RefineResult {
  /** The best-scoring episode across all rounds. */
  episode: Episode;
  /** Which round the returned episode came from. */
  bestRound: number;
  rounds: RefineRound[];
  /** Judging plus revision, across every round. */
  usage: Usage;
  /** True when a revision actually beat the original. */
  improved: boolean;
}

const DEFAULT_MAX_ROUNDS = 1;
const DEFAULT_TARGET = 0;

/**
 * The verdicts worth acting on.
 *
 * Contradictions and *specific* unsupported claims — a number, a name, a result
 * the paper never gave — are what hallucination means here, and they are what
 * `hallucinationRate` already counts. Vague unsupported statements ("this is an
 * important problem") are conversational framing; rewriting them churns the
 * script and risks making it worse for no measurable gain.
 */
export function failuresToFix(report: FaithfulnessReport): RevisionNote[] {
  return report.verdicts
    .filter(
      (v) => v.verdict === "contradicted" || (v.verdict === "unsupported" && v.specific),
    )
    .map((v) => ({
      turn: v.turn,
      claim: v.claim,
      verdict: v.verdict as "unsupported" | "contradicted",
      evidence: v.evidence,
    }));
}

/** Lower is better: fewest hallucinations first, then highest faithfulness. */
function isBetter(candidate: FaithfulnessReport, incumbent: FaithfulnessReport): boolean {
  const count = (r: FaithfulnessReport) =>
    r.verdicts.filter(
      (v) => v.verdict === "contradicted" || (v.verdict === "unsupported" && v.specific),
    ).length;
  const a = count(candidate);
  const b = count(incumbent);
  if (a !== b) return a < b;
  return candidate.faithfulness > incumbent.faithfulness;
}

/** Grade one episode against the paper. */
async function judge(
  episode: Episode,
  paper: PaperStructure,
  provider: LLMProvider,
): Promise<{ report: FaithfulnessReport; usage: Usage }> {
  return withSpan("judge", {}, async () => {
    const extracted = await extractClaims(episode, { provider });
    const verified = await verifyClaims(paper, extracted.claims, { provider });
    return {
      report: scoreFaithfulness(verified.verdicts),
      usage: addUsage(extracted.usage, verified.usage),
    };
  });
}

/**
 * The loop, wrapped in a span so its rounds are legible in a trace.
 *
 * Delegating rather than indenting the whole body keeps the tracing addition
 * from touching a single line of the logic below it.
 */
export async function refineEpisode(
  episode: Episode,
  paper: PaperStructure,
  opts: RefineOptions,
): Promise<RefineResult> {
  return withSpan(
    "invoke_agent refine",
    {
      [A.GEN_AI_OPERATION_NAME]: "invoke_agent",
      [A.GEN_AI_AGENT_NAME]: "refine",
      [A.PAPERCAST_MAX_ROUNDS]: opts.maxRounds ?? DEFAULT_MAX_ROUNDS,
    },
    () => runRefine(episode, paper, opts),
  );
}

async function runRefine(
  episode: Episode,
  paper: PaperStructure,
  opts: RefineOptions,
): Promise<RefineResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const target = opts.targetHallucinationRate ?? DEFAULT_TARGET;
  const judgeProvider = opts.judgeProvider ?? opts.provider;

  opts.onProgress?.(0, maxRounds, "Fact-checking the script");
  const first = await withSpan("round 0", { [A.PAPERCAST_ROUND]: 0 }, () =>
    judge(episode, paper, judgeProvider),
  );
  let usage = first.usage;

  const rounds: RefineRound[] = [
    {
      round: 0,
      faithfulness: first.report,
      failures: failuresToFix(first.report).length,
      revisedTurns: [],
    },
  ];

  let best = { episode, report: first.report, round: 0 };
  let current = { episode, report: first.report };

  // A `break` cannot cross the span callback below, so the one early exit
  // inside the round is hoisted to a flag. Everything else is unchanged.
  let stop = false;

  for (let round = 1; round <= maxRounds; round++) {
    const notes = failuresToFix(current.report);
    if (notes.length === 0 || current.report.hallucinationRate <= target) break;

    await withSpan(
      `round ${round}`,
      { [A.PAPERCAST_ROUND]: round, [A.PAPERCAST_FAILURES_IN]: notes.length },
      async () => {
        opts.onProgress?.(
          round,
          maxRounds,
          `Correcting ${notes.length} unsupported claims`,
        );
        const revised = await reviseEpisode(current.episode, paper, notes, {
          provider: opts.provider,
        });
        usage = addUsage(usage, revised.usage);

        // Nothing changed — either the model returned the text it was given or
        // every rewrite was rejected as empty. Another round would repeat it
        // exactly.
        if (revised.revisedTurns.length === 0) {
          stop = true;
          return;
        }

        opts.onProgress?.(round, maxRounds, "Re-checking the corrected script");
        const rejudged = await judge(revised.episode, paper, judgeProvider);
        usage = addUsage(usage, rejudged.usage);

        rounds.push({
          round,
          faithfulness: rejudged.report,
          failures: failuresToFix(rejudged.report).length,
          revisedTurns: revised.revisedTurns,
        });

        if (isBetter(rejudged.report, best.report)) {
          best = { episode: revised.episode, report: rejudged.report, round };
        }
        current = { episode: revised.episode, report: rejudged.report };
      },
    );

    if (stop) break;
  }

  return {
    episode: best.episode,
    bestRound: best.round,
    rounds,
    usage,
    improved: best.round > 0,
  };
}
