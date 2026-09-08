import { describe, it, expect } from "vitest";
import { chunkForSynthesis, splitSentences } from "./chunk";

describe("splitSentences", () => {
  it("keeps terminal punctuation with its sentence", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("handles text with no terminal punctuation", () => {
    expect(splitSentences("no punctuation here")).toEqual(["no punctuation here"]);
  });

  it("does not split on a decimal point", () => {
    const out = splitSentences("Latency was 5.38 milliseconds in their tests.");
    expect(out).toHaveLength(1);
  });
});

describe("chunkForSynthesis", () => {
  it("returns a single chunk when the text already fits", () => {
    expect(chunkForSynthesis("short text", 100)).toEqual(["short text"]);
  });

  it("returns nothing for empty input", () => {
    expect(chunkForSynthesis("   ", 100)).toEqual([]);
  });

  it("keeps every chunk within the limit", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} here.`).join(
      " ",
    );
    const chunks = chunkForSynthesis(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("breaks at sentence boundaries rather than mid-sentence", () => {
    const text = "First sentence here. Second sentence here. Third sentence here.";
    const chunks = chunkForSynthesis(text, 45);
    // Every chunk should end with terminal punctuation when boundaries allow.
    for (const c of chunks) expect(c).toMatch(/[.!?]$/);
  });

  it("preserves all the words across chunks", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i} is here.`).join(" ");
    const chunks = chunkForSynthesis(text, 120);
    const rejoined = chunks.join(" ").replace(/\s+/g, " ");
    for (let i = 0; i < 40; i++) expect(rejoined).toContain(`word${i}`);
  });

  it("splits a single sentence that exceeds the limit on its own", () => {
    const long = `This one sentence just keeps going ${"and on ".repeat(80)}forever.`;
    const chunks = chunkForSynthesis(long, 100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("does not cut mid-word when splitting an oversized sentence", () => {
    const long = `alpha bravo charlie delta echo foxtrot golf hotel india juliet ${"kilo ".repeat(40)}zulu`;
    const chunks = chunkForSynthesis(long, 80);
    // A mid-word cut would leave a fragment that is not a real token.
    for (const c of chunks) {
      expect(c.startsWith(" ")).toBe(false);
      expect(c.endsWith(" ")).toBe(false);
    }
    expect(chunks.join(" ")).toContain("foxtrot");
  });

  it("handles a single unbroken token longer than the limit", () => {
    const chunks = chunkForSynthesis("x".repeat(250), 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("rejects a non-positive limit rather than looping forever", () => {
    expect(() => chunkForSynthesis("some text", 0)).toThrow(/positive/);
  });

  it("fits a realistic long turn inside the OpenAI 4096-character limit", () => {
    // The original failure: a full script sent in one call, silently rejected.
    const turn = "The authors describe the storage tier in detail. ".repeat(200);
    const chunks = chunkForSynthesis(turn, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });
});
