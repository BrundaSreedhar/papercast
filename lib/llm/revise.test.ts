import { describe, it, expect } from "vitest";
import {
  applyRevisions,
  buildRevisionRequest,
  reviseEpisode,
  RevisionSchema,
  type RevisionNote,
} from "./revise";
import type { Episode } from "./schema";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types";
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
    { speaker: "host", text: "What is the core idea?" },
    { speaker: "guest", text: "They cut write traffic by 912 percent." },
    { speaker: "host", text: "And what limits it?" },
    { speaker: "guest", text: "The network is the bottleneck." },
  ],
};

const note = (turn: number, over: Partial<RevisionNote> = {}): RevisionNote => ({
  turn,
  claim: "Write traffic fell by 912 percent",
  verdict: "unsupported",
  ...over,
});

/** Returns whatever revisions it is constructed with, recording the request. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  last?: StructuredRequest<unknown>;
  constructor(private revisions: { turn: number; text: string }[]) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    return {
      data: req.schema.parse({ revisions: this.revisions }),
      usage: { inputTokens: 100, outputTokens: 40 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("buildRevisionRequest", () => {
  it("sends the flagged turn's current text and the paper's contradicting quote", () => {
    const req = buildRevisionRequest(EPISODE, [
      note(1, { verdict: "contradicted", evidence: "write traffic fell by 7.7x" }),
    ]);
    expect(req).toContain("TURN [1]");
    expect(req).toContain("They cut write traffic by 912 percent.");
    expect(req).toContain("CONTRADICTS THE PAPER");
    expect(req).toContain("write traffic fell by 7.7x");
  });

  it("says the paper is silent when the judge had nothing to quote", () => {
    const req = buildRevisionRequest(EPISODE, [note(1)]);
    expect(req).toContain("NOT IN THE PAPER");
    expect(req).toContain("does not address this");
  });

  it("groups several failed claims under one turn", () => {
    const req = buildRevisionRequest(EPISODE, [
      note(1, { claim: "first problem" }),
      note(1, { claim: "second problem" }),
    ]);
    expect(req.match(/TURN \[1\]/g)).toHaveLength(1);
    expect(req).toContain("first problem");
    expect(req).toContain("second problem");
  });

  it("ignores a note pointing outside the dialogue", () => {
    const req = buildRevisionRequest(EPISODE, [note(99)]);
    expect(req).not.toContain("TURN [99]");
  });

  it("names the speaker so the rewrite keeps the right voice", () => {
    expect(buildRevisionRequest(EPISODE, [note(1)])).toContain("GUEST");
    expect(buildRevisionRequest(EPISODE, [note(0)])).toContain("HOST");
  });
});

describe("applyRevisions", () => {
  it("replaces only the revised turn and reports which changed", () => {
    const { episode, revisedTurns } = applyRevisions(EPISODE, [
      { turn: 1, text: "They cut write traffic by 7.7 times." },
    ]);
    expect(revisedTurns).toEqual([1]);
    expect(episode.turns[1]!.text).toBe("They cut write traffic by 7.7 times.");
    expect(episode.turns[0]!.text).toBe(EPISODE.turns[0]!.text);
    expect(episode.turns[3]!.text).toBe(EPISODE.turns[3]!.text);
  });

  it("never changes turn count, order, or speakers", () => {
    // Strict alternation is an error-level check; a revision must not break it.
    const { episode } = applyRevisions(EPISODE, [{ turn: 1, text: "new" }]);
    expect(episode.turns).toHaveLength(EPISODE.turns.length);
    expect(episode.turns.map((t) => t.speaker)).toEqual(
      EPISODE.turns.map((t) => t.speaker),
    );
  });

  it("keeps the original when the rewrite comes back empty", () => {
    // A blank turn would break alternation and synthesize as silence.
    const { episode, revisedTurns } = applyRevisions(EPISODE, [{ turn: 1, text: "   " }]);
    expect(revisedTurns).toEqual([]);
    expect(episode.turns[1]!.text).toBe(EPISODE.turns[1]!.text);
  });

  it("does not count an unchanged rewrite as a revision", () => {
    const { revisedTurns } = applyRevisions(EPISODE, [
      { turn: 1, text: EPISODE.turns[1]!.text },
    ]);
    expect(revisedTurns).toEqual([]);
  });

  it("ignores an out-of-range turn index instead of throwing", () => {
    const { episode, revisedTurns } = applyRevisions(EPISODE, [
      { turn: 99, text: "nowhere" },
      { turn: -1, text: "nowhere" },
    ]);
    expect(revisedTurns).toEqual([]);
    expect(episode.turns).toEqual(EPISODE.turns);
  });

  it("leaves the input episode untouched", () => {
    applyRevisions(EPISODE, [{ turn: 1, text: "changed" }]);
    expect(EPISODE.turns[1]!.text).toBe("They cut write traffic by 912 percent.");
  });
});

describe("reviseEpisode", () => {
  it("passes the paper as cacheable context and judges at temperature 0", async () => {
    const provider = new StubProvider([
      { turn: 1, text: "They cut write traffic by 7.7 times." },
    ]);
    const result = await reviseEpisode(EPISODE, PAPER, [note(1)], { provider });

    expect(provider.last?.cacheableContext).toContain("The network is the bottleneck.");
    expect(provider.last?.temperature).toBe(0);
    expect(provider.last?.schemaName).toBe("revisions");
    expect(result.revisedTurns).toEqual([1]);
    expect(result.episode.turns[1]!.text).toBe("They cut write traffic by 7.7 times.");
    expect(result.usage.outputTokens).toBe(40);
  });

  it("forbids inventing a replacement fact in the system prompt", async () => {
    const provider = new StubProvider([{ turn: 1, text: "fixed" }]);
    await reviseEpisode(EPISODE, PAPER, [note(1)], { provider });
    expect(provider.last?.system.toLowerCase()).toContain("do not introduce new claims");
  });

  it("makes no call at all when there is nothing to fix", async () => {
    const provider = new StubProvider([]);
    const result = await reviseEpisode(EPISODE, PAPER, [], { provider });
    expect(provider.last).toBeUndefined();
    expect(result.episode).toBe(EPISODE);
    expect(result.revisedTurns).toEqual([]);
  });
});

describe("RevisionSchema", () => {
  it("requires both the turn index and its text", () => {
    expect(RevisionSchema.safeParse({ revisions: [{ turn: 1 }] }).success).toBe(false);
    expect(RevisionSchema.safeParse({ revisions: [{ text: "t" }] }).success).toBe(false);
    expect(
      RevisionSchema.safeParse({ revisions: [{ turn: 1, text: "t" }] }).success,
    ).toBe(true);
  });
});
