import type { Episode } from "../llm/schema";
import type { PaperStructure } from "../pdf/extract";

/** Severity of a failed check. Errors gate CI; warnings are reported only. */
export type Severity = "error" | "warning";

export interface CheckResult {
  id: string;
  label: string;
  passed: boolean;
  severity: Severity;
  /** Human-readable explanation, present when the check fails. */
  detail?: string;
}

export interface DeterministicReport {
  checks: CheckResult[];
  errors: number;
  warnings: number;
  /** Fraction of checks passed, 0–1. */
  complianceScore: number;
}

/** Everything a check needs to judge an episode. */
export interface CheckContext {
  episode: Episode;
  paper: PaperStructure;
  /** Target length the episode was generated for. */
  minutes: number;
  showName: string;
}

/** One atomic factual assertion pulled out of the dialogue. */
export interface Claim {
  /** Index of the dialogue turn the claim came from. */
  turn: number;
  text: string;
  /**
   * Whether the claim asserts something checkable about the paper. Filler such
   * as "that's fascinating" is conversational, not factual, and is excluded
   * from the faithfulness denominator.
   */
  factual: boolean;
}

export type Verdict = "supported" | "unsupported" | "contradicted";

export interface ClaimVerdict {
  /**
   * Dialogue turn the claim came from. Carried through from extraction so a
   * failed verdict points at the text that has to change, not just at a score.
   */
  turn: number;
  claim: string;
  verdict: Verdict;
  /** Quote from the paper backing a `supported` verdict, or the conflict. */
  evidence?: string;
  /**
   * A specific unsupported claim (a number, a name, a result) is a
   * hallucination; a vague unsupported one is usually harmless framing.
   */
  specific: boolean;
}

export interface FaithfulnessReport {
  verdicts: ClaimVerdict[];
  totalClaims: number;
  supported: number;
  unsupported: number;
  contradicted: number;
  /** supported / totalClaims */
  faithfulness: number;
  /** (contradicted + specific unsupported) / totalClaims */
  hallucinationRate: number;
}

export interface CoverageReport {
  expected: string[];
  hit: string[];
  missed: string[];
  /** hit / expected */
  coverage: number;
}

export interface EvalCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
}

export interface EvalResult {
  paperId: string;
  paperTitle: string;
  /** Provider and model that generated the episode under test. */
  generator: { provider: string; model: string };
  /** Provider and model that judged it. */
  judge: { provider: string; model: string };
  /**
   * True when the same model both wrote and graded the episode. Self-preference
   * bias is well documented, so every report carries this flag rather than
   * quietly presenting the score as neutral.
   */
  selfJudged: boolean;
  deterministic: DeterministicReport;
  faithfulness?: FaithfulnessReport;
  coverage?: CoverageReport;
  generationCost?: EvalCost;
  judgeCost?: EvalCost;
}
