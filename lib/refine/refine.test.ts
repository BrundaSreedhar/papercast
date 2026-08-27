import { describe, it, expect } from "vitest";
import { failuresToFix, refineEpisode } from "./refine";
import { scoreFaithfulness } from "../eval/judge";
import type { ClaimVerdict } from "../eval/types";
import type { Episode } from "../llm/schema";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";
import type { PaperStructure } from "../pdf/extract";

const PAPER: PaperStructure = {
  title: "Amazon Aurora",
  abstract: "We move the log to storage.",
  sections: [{ heading: "Introduction", content: "The network is the bottleneck." }],
  wordCount: 8,
};

const EPISODE: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: [
    { speaker: "host", text: "turn zero" },
    { speaker: "guest", text: "turn one" },
    { speaker: "host", text: "turn two" },
    { speaker: "guest", text: "turn three" },
  ],
};

type Grade = "supported" | "unsupported-specific" | "unsupported-vague" | "contradicted";

const toVerdict = (g: Grade) => ({
  verdict:
    g === "contradicted"
      ? "contradicted"
      : g === "supported"
        ? "supported"
        : "unsupported",
  specific: g !== "unsupported-vague",
  evidence: g === "supported" || g === "contradicted" ? "the paper says so" : "",
});

/**
 * Stands in for a whole judge + reviser. Grades are scripted per judging pass;
 * rewrites are scripted per revision. One claim is emitted per dialogue turn,
 * so a grade at index i is a verdict about turn i.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  readonly calls: string[] = [];
  private pass = 0;
  private revision = 0;

  constructor(
    private grades: Grade[][],
    private rewrites: { turn: number; text: string }[][] = [],
  ) {}

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req.schemaName);
    const usage = { inputTokens: 10, outputTokens: 5 };
    const wrap = (data: unknown): StructuredResult<T> => ({
      data: req.schema.parse(data),
      usage,
      provider: this.name,
      model: this.model,
      retries: 0,
    });

    if (req.schemaName === "claims") {
      return wrap({
        claims: EPISODE.turns.map((t, i) => ({
          turn: i,
          text: `claim from ${t.text}`,
          factual: true,
        })),
      });
    }
    if (req.schemaName === "verdicts") {
      const grades = this.grades[this.pass++] ?? this.grades[this.grades.length - 1]!;
      return wrap({
        verdicts: grades.map((g, i) => ({ claimIndex: i, ...toVerdict(g) })),
      });
    }
    if (req.schemaName === "revisions") {
      return wrap({ revisions: this.rewrites[this.revision++] ?? [] });
    }
    throw new Error(`unexpected schema ${req.schemaName}`);
  }
}

const verdict = (over: Partial<ClaimVerdict> = {}): ClaimVerdict => ({
  turn: 0,
  claim: "c",
  verdict: "supported",
  specific: true,
  ...over,
});

describe("failuresToFix", () => {
  it("sends contradictions and specific unsupported claims back for repair", () => {
    const notes = failuresToFix(
      scoreFaithfulness([
        verdict({ turn: 1, verdict: "contradicted", claim: "wrong" }),
        verdict({ turn: 2, verdict: "unsupported", specific: true, claim: "invented" }),
      ]),
    );
    expect(notes.map((n) => n.turn)).toEqual([1, 2]);
    expect(notes.map((n) => n.claim)).toEqual(["wrong", "invented"]);
  });

  it("leaves vague unsupported framing alone", () => {
    // "This is an important area of research" — unsupported but harmless, and
    // rewriting it would churn the script for no measurable gain.
    const notes = failuresToFix(
      scoreFaithfulness([verdict({ verdict: "unsupported", specific: false })]),
    );
    expect(notes).toEqual([]);
  });

  it("carries the judge's evidence through to the repair order", () => {
    const notes = failuresToFix(
      scoreFaithfulness([
        verdict({ verdict: "contradicted", evidence: "write traffic fell by 7.7x" }),
      ]),
    );
    expect(notes[0]!.evidence).toBe("write traffic fell by 7.7x");
  });
});

describe("refineEpisode", () => {
  it("judges once and stops when every claim checks out", async () => {
    const provider = new ScriptedProvider([
      ["supported", "supported", "supported", "supported"],
    ]);
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    expect(provider.calls).toEqual(["claims", "verdicts"]);
    expect(result.rounds).toHaveLength(1);
    expect(result.improved).toBe(false);
    expect(result.bestRound).toBe(0);
    expect(result.episode).toBe(EPISODE);
  });

  it("rewrites the failing turn and keeps the repaired script", async () => {
    const provider = new ScriptedProvider(
      [
        ["supported", "contradicted", "supported", "supported"],
        ["supported", "supported", "supported", "supported"],
      ],
      [[{ turn: 1, text: "corrected turn one" }]],
    );
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    expect(provider.calls).toEqual([
      "claims",
      "verdicts",
      "revisions",
      "claims",
      "verdicts",
    ]);
    expect(result.improved).toBe(true);
    expect(result.bestRound).toBe(1);
    expect(result.episode.turns[1]!.text).toBe("corrected turn one");
    expect(result.rounds[0]!.failures).toBe(1);
    expect(result.rounds[1]!.failures).toBe(0);
    expect(result.rounds[1]!.revisedTurns).toEqual([1]);
  });

  it("discards a revision that made the episode worse", async () => {
    // Self-correction has to be falsifiable: a rewrite that introduces two new
    // problems must not be presented as an improvement.
    const provider = new ScriptedProvider(
      [
        ["supported", "contradicted", "supported", "supported"],
        ["contradicted", "contradicted", "supported", "supported"],
      ],
      [[{ turn: 1, text: "worse turn one" }]],
    );
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    expect(result.bestRound).toBe(0);
    expect(result.improved).toBe(false);
    expect(result.episode.turns[1]!.text).toBe("turn one");
    // The failed attempt is still on the record rather than hidden.
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[1]!.failures).toBe(2);
  });

  it("keeps a revision that reduces failures without eliminating them", async () => {
    const provider = new ScriptedProvider(
      [
        ["contradicted", "contradicted", "supported", "supported"],
        ["supported", "contradicted", "supported", "supported"],
      ],
      [[{ turn: 0, text: "corrected turn zero" }]],
    );
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    expect(result.bestRound).toBe(1);
    expect(result.improved).toBe(true);
    expect(result.episode.turns[0]!.text).toBe("corrected turn zero");
  });

  it("never repairs vague unsupported framing", async () => {
    const provider = new ScriptedProvider([
      ["supported", "unsupported-vague", "supported", "supported"],
    ]);
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    expect(provider.calls).not.toContain("revisions");
    expect(result.rounds).toHaveLength(1);
  });

  it("runs at most the rounds it was given", async () => {
    const failing: Grade[] = ["supported", "contradicted", "supported", "supported"];
    const provider = new ScriptedProvider(
      [failing, failing, failing],
      [[{ turn: 1, text: "attempt one" }], [{ turn: 1, text: "attempt two" }]],
    );
    const result = await refineEpisode(EPISODE, PAPER, { provider, maxRounds: 2 });

    expect(provider.calls.filter((c) => c === "revisions")).toHaveLength(2);
    expect(result.rounds).toHaveLength(3);
  });

  it("stops early once the hallucination rate is under the target", async () => {
    const provider = new ScriptedProvider([
      ["supported", "supported", "supported", "contradicted"],
    ]);
    const result = await refineEpisode(EPISODE, PAPER, {
      provider,
      maxRounds: 2,
      targetHallucinationRate: 0.3,
    });

    // One failure in four claims is 25%, already inside the target.
    expect(provider.calls).not.toContain("revisions");
    expect(result.rounds).toHaveLength(1);
  });

  it("stops when the reviser changes nothing rather than looping on it", async () => {
    const failing: Grade[] = ["supported", "contradicted", "supported", "supported"];
    const provider = new ScriptedProvider([failing, failing], [[]]);
    const result = await refineEpisode(EPISODE, PAPER, { provider, maxRounds: 2 });

    expect(provider.calls.filter((c) => c === "revisions")).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.improved).toBe(false);
  });

  it("adds up the tokens spent judging and repairing", async () => {
    const provider = new ScriptedProvider(
      [
        ["supported", "contradicted", "supported", "supported"],
        ["supported", "supported", "supported", "supported"],
      ],
      [[{ turn: 1, text: "corrected" }]],
    );
    const result = await refineEpisode(EPISODE, PAPER, { provider });

    // Five calls at 10 in / 5 out each.
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it("can grade with a different model than it repairs with", async () => {
    const repairer = new ScriptedProvider([], [[{ turn: 1, text: "corrected" }]]);
    const grader = new ScriptedProvider([
      ["supported", "contradicted", "supported", "supported"],
      ["supported", "supported", "supported", "supported"],
    ]);
    await refineEpisode(EPISODE, PAPER, { provider: repairer, judgeProvider: grader });

    expect(repairer.calls).toEqual(["revisions"]);
    expect(grader.calls).toEqual(["claims", "verdicts", "claims", "verdicts"]);
  });

  it("reports progress for the check, the repair, and the re-check", async () => {
    const provider = new ScriptedProvider(
      [
        ["supported", "contradicted", "supported", "supported"],
        ["supported", "supported", "supported", "supported"],
      ],
      [[{ turn: 1, text: "corrected" }]],
    );
    const messages: string[] = [];
    await refineEpisode(EPISODE, PAPER, {
      provider,
      onProgress: (_r, _o, m) => messages.push(m),
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatch(/fact-check/i);
    expect(messages[1]).toMatch(/1 unsupported/i);
    expect(messages[2]).toMatch(/re-check/i);
  });
});
