/**
 * Layer 2: the LLM judge.
 *
 * Faithfulness is scored by decomposition rather than by asking a model to rate
 * an episode out of ten. Pointwise ratings are noisy and unfalsifiable; a list
 * of atomic claims, each marked supported, unsupported, or contradicted against
 * quoted evidence, can be read and disagreed with line by line.
 *
 * Cost shapes the design. Only verification needs the whole paper, so claim
 * extraction sees the script alone and coverage sees the episode against a
 * short list of annotated contributions. The paper is passed as cacheable
 * context, so comparing several providers on the same paper pays for it once.
 */
import type { Episode } from "../llm/schema";
import type { LLMProvider, Usage } from "../llm/types";
import { addUsage } from "../llm/usage";
import { paperToText, type PaperStructure } from "../pdf/extract";
import {
  ClaimExtractionSchema,
  CoverageSchema,
  VerificationSchema,
} from "./judgeSchema";
import type {
  Claim,
  ClaimVerdict,
  CoverageReport,
  FaithfulnessReport,
} from "./types";

export interface JudgeOptions {
  provider: LLMProvider;
  /** Judge deterministically; grading should not vary run to run. */
  temperature?: number;
}

/** Render the dialogue with turn indices so claims can cite their source. */
export function renderDialogue(episode: Episode): string {
  return episode.turns
    .map((t, i) => `[${i}] ${t.speaker.toUpperCase()}: ${t.text}`)
    .join("\n");
}

/* ── pass 1: claim extraction ──────────────────────────────────────────── */

const EXTRACT_SYSTEM = `You break a podcast transcript into atomic claims for fact-checking.

Rules:
- One assertion per claim. Split compound sentences.
- Restate each claim so it stands alone: replace pronouns and references with what they point to.
- Preserve the original meaning exactly. Do not soften, strengthen, or interpret.
- Never split a contrastive or qualified statement in a way that changes what it asserts. "X goes away, but the cost moves to Y" is a single claim about a trade-off, not a standalone claim that X goes away. Keep hedges ("about", "roughly", "up to") attached to the figure they qualify.
- Extract claims about the paper and its subject matter only. Statements about the episode itself — that it discusses a paper, that a speaker is about to explain something — are not claims. Nor is anything about the speakers themselves.
- Mark a claim factual only if it asserts something checkable about the paper or its subject. Greetings, transitions, and reactions ("that's a great question") are not factual.
- Include every claim, even ones you believe are wrong. Judging comes later.`;

export async function extractClaims(
  episode: Episode,
  opts: JudgeOptions,
): Promise<{ claims: Claim[]; usage: Usage }> {
  const result = await opts.provider.generateStructured({
    system: EXTRACT_SYSTEM,
    user: `Break this transcript into atomic claims.\n\n${renderDialogue(episode)}`,
    schema: ClaimExtractionSchema,
    schemaName: "claims",
    schemaDescription: "Atomic claims extracted from the transcript.",
    maxTokens: 8000,
    temperature: opts.temperature ?? 0,
  });
  return { claims: result.data.claims, usage: result.usage };
}

/* ── pass 2: verification ──────────────────────────────────────────────── */

const VERIFY_SYSTEM = `You check claims against a source paper. The paper is the only authority; your own knowledge of the subject is irrelevant and must not be used.

For each claim return one verdict:
- "supported": the paper states this or directly implies it. Quote the supporting text.
- "contradicted": the paper states something incompatible with it. Quote the conflicting text.
- "unsupported": the paper simply does not address it. Evidence is an empty string.

Judge meaning, not wording. A claim that rounds or paraphrases a figure the paper gives ("about 5.4 ms" for a stated 5.38 ms) is supported. A claim that changes the figure's magnitude or meaning is not.

Be strict about specificity: mark a claim specific when it names a number, dataset, system, or concrete result, and not specific when it is a general statement of theme or motivation.`;

export async function verifyClaims(
  paper: PaperStructure,
  claims: Claim[],
  opts: JudgeOptions,
): Promise<{ verdicts: ClaimVerdict[]; usage: Usage }> {
  const factual = claims.filter((c) => c.factual);
  if (factual.length === 0) return { verdicts: [], usage: {} };

  const numbered = factual.map((c, i) => `[${i}] ${c.text}`).join("\n");
  const result = await opts.provider.generateStructured({
    system: VERIFY_SYSTEM,
    cacheableContext: `SOURCE PAPER\n\n${paperToText(paper)}`,
    user: `Judge each claim below against the source paper above. Return exactly ${factual.length} verdicts, one per claim, using the given indices.\n\nCLAIMS\n${numbered}`,
    schema: VerificationSchema,
    schemaName: "verdicts",
    schemaDescription: "A verdict for every claim.",
    maxTokens: 16000,
    temperature: opts.temperature ?? 0,
  });

  const verdicts: ClaimVerdict[] = result.data.verdicts
    .filter((v) => v.claimIndex >= 0 && v.claimIndex < factual.length)
    .map((v) => ({
      turn: factual[v.claimIndex]!.turn,
      claim: factual[v.claimIndex]!.text,
      verdict: v.verdict,
      evidence: v.evidence || undefined,
      specific: v.specific,
    }));

  return { verdicts, usage: result.usage };
}

export function scoreFaithfulness(verdicts: ClaimVerdict[]): FaithfulnessReport {
  const total = verdicts.length;
  const supported = verdicts.filter((v) => v.verdict === "supported").length;
  const contradicted = verdicts.filter((v) => v.verdict === "contradicted").length;
  const unsupported = verdicts.filter((v) => v.verdict === "unsupported").length;
  // Vague unsupported claims are conversational framing; specific ones assert a
  // detail the paper never gave, which is what hallucination actually means.
  const specificUnsupported = verdicts.filter(
    (v) => v.verdict === "unsupported" && v.specific,
  ).length;

  return {
    verdicts,
    totalClaims: total,
    supported,
    unsupported,
    contradicted,
    faithfulness: total ? supported / total : 0,
    hallucinationRate: total ? (contradicted + specificUnsupported) / total : 0,
  };
}

/* ── pass 3: coverage ──────────────────────────────────────────────────── */

const COVERAGE_SYSTEM = `You check whether a podcast episode conveys each of a paper's key contributions.

Mark a contribution mentioned when the episode communicates the same idea, even in different words or at a higher level. Do not require matching terminology. Do not mark it mentioned merely because a related term appears; the idea itself must come across.`;

export async function scoreCoverage(
  episode: Episode,
  expectedContributions: string[],
  opts: JudgeOptions,
): Promise<{ coverage: CoverageReport | undefined; usage: Usage }> {
  // A paper with no annotated contributions has no coverage to measure. That
  // must be reported as absent, not as zero: a score of 0% is a claim that the
  // episode covered nothing, which would condemn every newly added paper until
  // somebody noticed the annotations were missing.
  if (expectedContributions.length === 0) {
    return { coverage: undefined, usage: {} };
  }

  const list = expectedContributions.map((c, i) => `[${i}] ${c}`).join("\n");
  const result = await opts.provider.generateStructured({
    system: COVERAGE_SYSTEM,
    user: `EPISODE\n\nSummary: ${episode.summary}\n\nKey points:\n${episode.keyPoints.map((k) => `- ${k}`).join("\n")}\n\nDialogue:\n${renderDialogue(episode)}\n\nEXPECTED CONTRIBUTIONS\n${list}\n\nFor each contribution, say whether the episode conveys it.`,
    schema: CoverageSchema,
    schemaName: "coverage",
    schemaDescription: "Whether each expected contribution is conveyed.",
    maxTokens: 4000,
    temperature: opts.temperature ?? 0,
  });

  const hit: string[] = [];
  const missed: string[] = [];
  for (const r of result.data.results) {
    (r.mentioned ? hit : missed).push(r.contribution);
  }

  return {
    coverage: {
      expected: expectedContributions,
      hit,
      missed,
      coverage: expectedContributions.length ? hit.length / expectedContributions.length : 0,
    },
    usage: result.usage,
  };
}

/* ── full judgement ────────────────────────────────────────────────────── */

export interface JudgementResult {
  faithfulness: FaithfulnessReport;
  /** Absent when the paper has no annotated contributions to score against. */
  coverage?: CoverageReport;
  claims: Claim[];
  usage: Usage;
  latencyMs: number;
}

export async function judgeEpisode(
  episode: Episode,
  paper: PaperStructure,
  expectedContributions: string[],
  opts: JudgeOptions,
): Promise<JudgementResult> {
  const started = Date.now();

  const extracted = await extractClaims(episode, opts);
  const verified = await verifyClaims(paper, extracted.claims, opts);
  const covered = await scoreCoverage(episode, expectedContributions, opts);

  return {
    faithfulness: scoreFaithfulness(verified.verdicts),
    coverage: covered.coverage,
    claims: extracted.claims,
    usage: [extracted.usage, verified.usage, covered.usage].reduce(addUsage, {}),
    latencyMs: Date.now() - started,
  };
}
