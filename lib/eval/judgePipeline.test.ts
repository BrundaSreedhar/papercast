/**
 * Tests for the judge's orchestration, as opposed to its arithmetic.
 *
 * The scoring maths is covered in judge.test.ts. What is riskier is the
 * plumbing around it: which claims reach the model, how verdicts are mapped
 * back onto the claims they belong to, and whether the paper is sent as
 * cacheable context. A mis-mapped verdict still produces a plausible
 * faithfulness score — just an incorrect one — so nothing would surface it.
 */
import { describe, it, expect } from "vitest";
import { extractClaims, scoreCoverage, verifyClaims } from "./judge";
import type { Claim } from "./types";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";
import type { PaperStructure } from "../pdf/extract";
import type { Episode } from "../llm/schema";

const PAPER: PaperStructure = {
  title: "A Test Paper",
  abstract: "We test things.",
  sections: [{ heading: "Body", content: "Aurora uses a quorum." }],
  wordCount: 8,
};

const EPISODE: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: [
    { speaker: "host", text: "Welcome." },
    { speaker: "guest", text: "Aurora uses a quorum." },
  ],
};

/** Returns a fixed payload and records what it was asked. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub";
  last?: StructuredRequest<unknown>;
  calls = 0;
  constructor(private readonly response: unknown) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls++;
    this.last = req as StructuredRequest<unknown>;
    return {
      data: req.schema.parse(this.response),
      usage: { inputTokens: 1, outputTokens: 1 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

const claim = (text: string, factual = true): Claim => ({ turn: 0, text, factual });

describe("extractClaims", () => {
  it("sends the numbered transcript and returns the claims", async () => {
    const provider = new StubProvider({
      claims: [{ turn: 1, text: "Aurora uses a quorum.", factual: true }],
    });
    const { claims } = await extractClaims(EPISODE, { provider });
    expect(claims).toHaveLength(1);
    expect(provider.last?.user).toContain("[1] GUEST: Aurora uses a quorum.");
  });

  it("judges deterministically by default", async () => {
    const provider = new StubProvider({ claims: [] });
    await extractClaims(EPISODE, { provider });
    expect(provider.last?.temperature).toBe(0);
  });
});

describe("verifyClaims", () => {
  it("maps each verdict back onto the claim it was given", async () => {
    // Deliberately out of order: a verdict list that is not in index order must
    // still attach to the right claims.
    const provider = new StubProvider({
      verdicts: [
        { claimIndex: 1, verdict: "contradicted", evidence: "e", specific: true },
        { claimIndex: 0, verdict: "supported", evidence: "e", specific: false },
      ],
    });
    const { verdicts } = await verifyClaims(
      PAPER,
      [claim("first claim"), claim("second claim")],
      { provider },
    );
    const byClaim = Object.fromEntries(verdicts.map((v) => [v.claim, v.verdict]));
    expect(byClaim["first claim"]).toBe("supported");
    expect(byClaim["second claim"]).toBe("contradicted");
  });

  it("excludes non-factual claims from the denominator", async () => {
    const provider = new StubProvider({
      verdicts: [{ claimIndex: 0, verdict: "supported", evidence: "", specific: false }],
    });
    const { verdicts } = await verifyClaims(
      PAPER,
      [claim("a real claim"), claim("that's fascinating", false)],
      { provider },
    );
    expect(verdicts).toHaveLength(1);
    // Conversational filler must never reach the verifier at all.
    expect(provider.last?.user).not.toContain("fascinating");
  });

  it("drops verdicts whose index does not correspond to a claim", async () => {
    const provider = new StubProvider({
      verdicts: [
        { claimIndex: 0, verdict: "supported", evidence: "", specific: false },
        { claimIndex: 7, verdict: "contradicted", evidence: "", specific: true },
        { claimIndex: -1, verdict: "contradicted", evidence: "", specific: true },
      ],
    });
    const { verdicts } = await verifyClaims(PAPER, [claim("only claim")], { provider });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.verdict).toBe("supported");
  });

  it("sends the paper as cacheable context, not inline in the prompt", async () => {
    const provider = new StubProvider({ verdicts: [] });
    await verifyClaims(PAPER, [claim("x")], { provider });
    expect(provider.last?.cacheableContext).toContain("Aurora uses a quorum.");
    expect(provider.last?.user).not.toContain("Aurora uses a quorum.");
  });

  it("makes no call at all when there is nothing factual to verify", async () => {
    const provider = new StubProvider({ verdicts: [] });
    const { verdicts } = await verifyClaims(PAPER, [claim("hello there", false)], {
      provider,
    });
    expect(provider.calls).toBe(0);
    expect(verdicts).toEqual([]);
  });

  it("normalizes empty evidence to undefined", async () => {
    const provider = new StubProvider({
      verdicts: [
        { claimIndex: 0, verdict: "unsupported", evidence: "", specific: false },
      ],
    });
    const { verdicts } = await verifyClaims(PAPER, [claim("x")], { provider });
    expect(verdicts[0]!.evidence).toBeUndefined();
  });
});

describe("scoreCoverage", () => {
  it("partitions contributions into hit and missed", async () => {
    const provider = new StubProvider({
      results: [
        { contribution: "A", mentioned: true, evidence: "q" },
        { contribution: "B", mentioned: false, evidence: "" },
        { contribution: "C", mentioned: true, evidence: "q" },
      ],
    });
    const { coverage } = await scoreCoverage(EPISODE, ["A", "B", "C"], { provider });
    expect(coverage?.hit).toEqual(["A", "C"]);
    expect(coverage?.missed).toEqual(["B"]);
    expect(coverage?.coverage).toBeCloseTo(2 / 3);
  });

  it("reports coverage as not measured, rather than zero, when nothing is annotated", async () => {
    // A newly added paper has no annotations yet. Scoring it 0% would read as
    // "the episode covered nothing" and quietly condemn every new paper.
    const provider = new StubProvider({ results: [] });
    const { coverage } = await scoreCoverage(EPISODE, [], { provider });
    expect(provider.calls).toBe(0);
    expect(coverage).toBeUndefined();
  });

  it("scores full coverage at 1", async () => {
    const provider = new StubProvider({
      results: [{ contribution: "A", mentioned: true, evidence: "q" }],
    });
    const { coverage } = await scoreCoverage(EPISODE, ["A"], { provider });
    expect(coverage?.coverage).toBe(1);
  });
});
