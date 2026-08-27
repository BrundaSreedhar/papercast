/**
 * Correcting the turns the judge rejected.
 *
 * The judge already produces exactly what a fix needs: which claim failed,
 * which turn said it, and the passage from the paper that contradicts it. Until
 * now that ended up in a report. Here it goes back to the model as a repair
 * order.
 *
 * Rewriting is deliberately *narrow*. Only the turns carrying a failed claim
 * are sent back, and only their text is replaced — the speaker, the turn count,
 * and the ordering are untouched. That is not just economy: strict host/guest
 * alternation is an error-level deterministic check, so a revision that dropped
 * or merged a turn would trade a faithfulness failure for a structural one.
 * Regenerating the whole episode would also discard the good material and
 * change the length the audio was budgeted for.
 */
import { z } from "zod";
import { paperToText, type PaperStructure } from "../pdf/extract";
import type { Episode } from "./schema";
import type { LLMProvider, Usage } from "./types";

/** One thing the judge found wrong, addressed to the turn that said it. */
export interface RevisionNote {
  /** Index of the dialogue turn carrying the claim. */
  turn: number;
  claim: string;
  verdict: "unsupported" | "contradicted";
  /** The passage the judge quoted, when it had one to quote. */
  evidence?: string;
}

export const RevisionSchema = z.object({
  revisions: z
    .array(
      z.object({
        turn: z.number().int().describe("Index of the turn being rewritten."),
        text: z
          .string()
          .describe(
            "The rewritten turn, in the same speaking voice and at roughly the same length. Never empty.",
          ),
      }),
    )
    .describe("One entry per turn you were asked to fix, in the order given."),
});

export const REVISE_SYSTEM = `You are correcting factual errors in a podcast script about an academic paper.

A fact-checker has read the script against the paper and flagged specific statements. Some assert things the paper never says; others contradict what it says. Your job is to repair exactly those turns and nothing else.

HOW TO FIX A TURN:
- If the paper supports a corrected version of the statement, state the correct version, taking the detail from the paper.
- If the paper simply does not address the statement, cut it. Keep the rest of the turn.
- If cutting leaves the turn with nothing to say, replace the flagged statement with something the paper does support on the same subject — do not pad with filler.
- Never defend, hedge, or explain the error. Do not say "the paper doesn't specify" unless that is genuinely the point being made.

WHAT MUST NOT CHANGE:
- Return every turn you were given, keyed by the index you were given. Never return an empty turn.
- Keep the same speaker's voice: the host asks, the guest explains. You are not told which is which — infer it from the text and preserve it.
- Keep roughly the same length. This script is timed for audio, and a turn that collapses to one line shortens the episode.
- Keep it spoken: contractions, short sentences, no markdown, no bullet points, no stage directions.
- Do not introduce new claims, numbers, names, or comparisons beyond what the paper states. A fix that invents a different fact is not a fix.
- Do not name the speakers, credential them, or attribute the work to them. The authors wrote the paper; the speakers are discussing it.`;

export interface ReviseOptions {
  provider: LLMProvider;
  /** Repairs should not vary run to run. */
  temperature?: number;
}

export interface ReviseResult {
  episode: Episode;
  /** Turn indices whose text actually changed. */
  revisedTurns: number[];
  usage: Usage;
  model: string;
}

/** Group notes by turn and render them as the repair order sent to the model. */
export function buildRevisionRequest(episode: Episode, notes: RevisionNote[]): string {
  const byTurn = new Map<number, RevisionNote[]>();
  for (const note of notes) {
    // A note pointing outside the dialogue cannot be acted on. The judge indexes
    // turns itself, so this is defensive rather than expected.
    if (note.turn < 0 || note.turn >= episode.turns.length) continue;
    const list = byTurn.get(note.turn) ?? [];
    list.push(note);
    byTurn.set(note.turn, list);
  }

  const blocks = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, turnNotes]) => {
      const problems = turnNotes
        .map((n) => {
          const what =
            n.verdict === "contradicted" ? "CONTRADICTS THE PAPER" : "NOT IN THE PAPER";
          const quote = n.evidence
            ? `\n    The paper says: "${n.evidence}"`
            : "\n    The paper does not address this at all.";
          return `  - ${what}: ${n.claim}${quote}`;
        })
        .join("\n");
      return `TURN [${turn}] — ${episode.turns[turn]!.speaker.toUpperCase()}\n  Current text: ${episode.turns[turn]!.text}\n  Problems found:\n${problems}`;
    });

  return `Rewrite each of the following turns so that every statement in it is supported by the paper above.\n\n${blocks.join("\n\n")}`;
}

/** Replace the text of revised turns, leaving structure and speakers alone. */
export function applyRevisions(
  episode: Episode,
  revisions: { turn: number; text: string }[],
): { episode: Episode; revisedTurns: number[] } {
  const turns = episode.turns.map((t) => ({ ...t }));
  const revisedTurns: number[] = [];

  for (const r of revisions) {
    if (r.turn < 0 || r.turn >= turns.length) continue;
    const text = r.text.trim();
    // An empty rewrite would leave a turn with nothing to say, which breaks
    // strict alternation downstream and synthesizes as silence. Keeping the
    // original is the lesser failure: it stays flagged rather than becoming a
    // structural error.
    if (!text) continue;
    if (text === turns[r.turn]!.text) continue;
    turns[r.turn]!.text = text;
    revisedTurns.push(r.turn);
  }

  return {
    episode: { ...episode, turns },
    revisedTurns: revisedTurns.sort((a, b) => a - b),
  };
}

/**
 * Rewrite the flagged turns against the paper.
 *
 * The paper goes in as cacheable context because the loop judges, revises, and
 * re-judges the same paper several times over; without caching the paper would
 * dominate the bill of every round.
 */
export async function reviseEpisode(
  episode: Episode,
  paper: PaperStructure,
  notes: RevisionNote[],
  opts: ReviseOptions,
): Promise<ReviseResult> {
  if (notes.length === 0) {
    return { episode, revisedTurns: [], usage: {}, model: opts.provider.model };
  }

  const result = await opts.provider.generateStructured({
    system: REVISE_SYSTEM,
    cacheableContext: `SOURCE PAPER\n\n${paperToText(paper)}`,
    user: buildRevisionRequest(episode, notes),
    schema: RevisionSchema,
    schemaName: "revisions",
    schemaDescription: "A corrected version of each flagged turn.",
    maxTokens: 8000,
    temperature: opts.temperature ?? 0,
  });

  const applied = applyRevisions(episode, result.data.revisions);
  return {
    episode: applied.episode,
    revisedTurns: applied.revisedTurns,
    usage: result.usage,
    model: result.model,
  };
}
