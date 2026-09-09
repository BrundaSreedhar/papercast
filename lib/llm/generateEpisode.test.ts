import { describe, it, expect } from "vitest";
import {
  generateEpisode,
  estimateOutputTokens,
  buildUserContent,
  targetTurnCount,
} from "./generateEpisode";
import type { LLMProvider, StructuredRequest, StructuredResult } from "./types";
import type { PaperStructure } from "../pdf/extract";

const PAPER: PaperStructure = {
  title: "A Test Paper",
  abstract: "We test things.",
  sections: [{ heading: "Introduction", content: "Testing is good." }],
  wordCount: 6,
};

const CANNED = {
  summary: "s",
  keyPoints: ["k"],
  turns: [{ speaker: "host" as const, text: "hi" }],
};

/** Records the last request and returns a fixed, schema-valid episode. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  last?: StructuredRequest<unknown>;
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    return {
      data: req.schema.parse(CANNED),
      usage: { inputTokens: 10, outputTokens: 20 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("generateEpisode", () => {
  it("passes the episode schema and returns the parsed episode", async () => {
    const provider = new StubProvider();
    const result = await generateEpisode(PAPER, { provider, minutes: 5 });

    expect(result.episode.turns[0]!.speaker).toBe("host");
    expect(result.model).toBe("stub-model");
    expect(result.truncatedInput).toBe(false);
    expect(provider.last?.schemaName).toBe("episode");
    // The paper text should reach the model.
    expect(provider.last?.user).toContain("A Test Paper");
    // Faithfulness guardrail must be present in the system prompt.
    expect(provider.last?.system.toLowerCase()).toContain("use only");
  });

  it("flags truncation when the paper exceeds the input cap", async () => {
    const provider = new StubProvider();
    const big: PaperStructure = {
      ...PAPER,
      sections: [{ heading: "Body", content: "x".repeat(500) }],
    };
    const result = await generateEpisode(big, { provider, maxInputChars: 100 });
    expect(result.truncatedInput).toBe(true);
    expect(provider.last?.user).toContain("truncated");
  });
});

describe("speaker and show-name guardrails", () => {
  it("pins the show name so the model cannot invent one", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    expect(provider.last?.system).toContain("PaperCast");
    expect(provider.last?.system).toMatch(/never invent a different show name/i);
  });

  it("accepts a custom show name", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, showName: "Lab Notes" });
    expect(provider.last?.system).toContain("Lab Notes");
    expect(provider.last?.system).not.toContain("PaperCast");
  });

  it("gives the speakers no names at all", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    const sys = provider.last!.system;
    // Earlier versions injected invented personas ("Alex", "Dr. Rivera").
    expect(sys).not.toMatch(/\bAlex\b/);
    expect(sys).not.toMatch(/\bDr\.\s/);
    expect(sys).toMatch(/speakers have no names/i);
    expect(sys).toMatch(/never let them address each other by name/i);
  });

  it("forbids fabricated credentials and author impersonation", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    const sys = provider.last!.system;
    expect(sys).toMatch(/neither speaker wrote the paper/i);
    expect(sys).toMatch(/no credentials|no credentials, degrees/i);
    expect(sys).toMatch(/never "we found"|never "we found", "our method"/i);
  });
});

describe("the solo format", () => {
  it("asks for one narrated voice and forbids the other two", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "solo" });
    const sys = provider.last!.system;
    expect(sys).toMatch(/EVERY turn has the speaker "narrator"/);
    expect(sys).toMatch(/no turn may use "host" or "guest"/i);
  });

  it("keeps every faithfulness rule the dialogue has", async () => {
    // The point of the solo format is a second voice, not a second standard.
    const dialogue = new StubProvider();
    const solo = new StubProvider();
    await generateEpisode(PAPER, { provider: dialogue });
    await generateEpisode(PAPER, { provider: solo, format: "solo" });
    const block = (s: string) =>
      s.slice(s.indexOf("FAITHFULNESS"), s.indexOf("\n\n", s.indexOf("FAITHFULNESS")));
    expect(block(solo.last!.system)).toBe(block(dialogue.last!.system));
  });

  it("carries the anti-fabrication rules over to a single speaker", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "solo" });
    const sys = provider.last!.system;
    expect(sys).toMatch(/the speaker has no name/i);
    expect(sys).toMatch(/the speaker did not write the paper/i);
    expect(sys).toMatch(/no credentials, degrees, honorifics/i);
    expect(sys).toMatch(/never describe yourself as an expert/i);
  });

  it("bans bracketed stage directions, which a synthesizer reads aloud", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "solo" });
    const sys = provider.last!.system;
    expect(sys).toMatch(/no \[pause\]/i);
    expect(sys).toMatch(/reads such marks aloud/i);
  });

  it("opens warmly before it opens technically", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "solo" });
    const sys = provider.last!.system;
    expect(sys).toContain("THE WELCOME");
    expect(sys).toMatch(/greet the listener warmly/i);
    expect(sys).toMatch(/speak to one person/i);
    // Warmth is not a licence to pad — the failure mode is three sentences of
    // enthusiasm before any content.
    expect(sys).toMatch(/no "buckle up"/i);
    // Calling a paper groundbreaking is a claim about the paper, and the whole
    // point is not to make claims the paper does not.
    expect(sys).toMatch(
      /groundbreaking, revolutionary, or a paradigm shift unless the paper says so/i,
    );
  });

  it("gives the talk a narrative arc the dialogue does not need", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "solo" });
    const sys = provider.last!.system;
    for (const beat of [
      "THE WELCOME",
      "THE HOOK",
      "THE CONTEXT",
      "THE CORE",
      "THE IMPACT",
    ]) {
      expect(sys).toContain(beat);
    }
    // The arc must not become a licence to speculate past the paper.
    expect(sys).toMatch(/if the paper does not claim an implication, do not supply one/i);
  });

  it("leaves the dialogue prompt untouched", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider });
    const sys = provider.last!.system;
    expect(sys).toContain("two-host dialogue");
    expect(sys).not.toContain("narrator");
    expect(sys).not.toContain("THE HOOK");
  });
});

describe("the explain-like-I'm-5 format", () => {
  it("keeps every faithfulness rule the dialogue has", async () => {
    const dialogue = new StubProvider();
    const eli5 = new StubProvider();
    await generateEpisode(PAPER, { provider: dialogue });
    await generateEpisode(PAPER, { provider: eli5, format: "eli5" });
    const block = (s: string) =>
      s.slice(s.indexOf("FAITHFULNESS"), s.indexOf("\n\n", s.indexOf("FAITHFULNESS")));
    expect(block(eli5.last!.system)).toBe(block(dialogue.last!.system));
  });

  it("requires analogies to be marked as analogies", async () => {
    // An analogy stated as fact is a claim the paper never made; stated as a
    // comparison it stays framing, which the judge excludes from hallucination.
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    const sys = provider.last!.system;
    expect(sys).toMatch(/always mark a comparison as a comparison/i);
    expect(sys).toMatch(
      /never state a comparison as though it were something the paper says/i,
    );
  });

  it("bans invented proper nouns, which the proper-noun check would fail", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    expect(provider.last!.system).toMatch(
      /no brand names, product names, company names/i,
    );
  });

  it("refuses to round a real number into a different one", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    expect(provider.last!.system).toMatch(
      /never round a real number into a different one/i,
    );
  });

  it("keeps the summary and key points plain rather than simplified", async () => {
    // They are what the eval and the interface read.
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    expect(provider.last!.system).toMatch(/these two stay plain, accurate and grown-up/i);
  });

  it("bans the bracketed cues the format invites", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    const sys = provider.last!.system;
    expect(sys).toMatch(/no \[smiles\]/i);
    expect(sys).toMatch(/reads such marks aloud/i);
  });

  it("uses the four story beats and narrates throughout", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, format: "eli5" });
    const sys = provider.last!.system;
    for (const beat of [
      "THE BIG WONDER",
      "THE PROBLEM",
      "THE SIMPLE SOLUTION",
      "WHY IT'S COOL",
    ]) {
      expect(sys).toContain(beat);
    }
    expect(sys).toMatch(/EVERY turn has the speaker "narrator"/);
  });
});

describe("targetTurnCount", () => {
  it("scales with length and enforces a conversational floor", () => {
    expect(targetTurnCount(4)).toBe(14);
    expect(targetTurnCount(1)).toBeGreaterThanOrEqual(6);
    expect(targetTurnCount(10)).toBeGreaterThan(targetTurnCount(4));
  });

  it("asks for fewer, longer beats in a monologue than turns in a dialogue", () => {
    // A monologue beat runs three to six sentences; asking for the dialogue
    // count would chop the talk into fragments.
    expect(targetTurnCount(4, "solo")).toBeLessThan(targetTurnCount(4));
    expect(targetTurnCount(4, "solo")).toBe(8);
  });

  it("states the turn floor and word target in the prompt", async () => {
    const provider = new StubProvider();
    await generateEpisode(PAPER, { provider, minutes: 4 });
    const sys = provider.last!.system;
    expect(sys).toContain("at least 14 turns");
    expect(sys).toContain("600 words");
  });
});

describe("estimateOutputTokens", () => {
  it("scales with minutes and stays within clamps", () => {
    expect(estimateOutputTokens(1)).toBeGreaterThanOrEqual(4000);
    expect(estimateOutputTokens(120)).toBeLessThanOrEqual(32000);
    expect(estimateOutputTokens(20)).toBeGreaterThan(estimateOutputTokens(5));
  });

  it("budgets enough for a 4-minute episode to complete", () => {
    // Regression: the previous formula returned 2500 here, and Claude ran out
    // of budget mid-keyPoints, truncating the tool call into invalid JSON.
    expect(estimateOutputTokens(4)).toBeGreaterThan(3500);
  });

  it("accounts for JSON scaffolding, not just spoken words", () => {
    // Budget must exceed a naive words-only estimate by a clear margin.
    const naiveWordsOnly = 10 * 150 * 1.4;
    expect(estimateOutputTokens(10)).toBeGreaterThan(naiveWordsOnly * 1.5);
  });
});

describe("buildUserContent", () => {
  it("adds a truncation note only when truncated", () => {
    expect(buildUserContent("abc", false)).not.toContain("truncated");
    expect(buildUserContent("abc", true)).toContain("truncated");
  });
});
