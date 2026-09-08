/**
 * The round-trip metric, tested against transcripts a recognizer plausibly
 * produces: near-perfect, imperfect but faithful, and one where a turn's words
 * are simply absent. The last is the case the whole thing exists for.
 */
import { describe, it, expect } from "vitest";
import {
  fidelityCheck,
  normalizeWords,
  scoreTranscriptFidelity,
  wordRecall,
} from "./transcriptFidelity";
import type { Episode } from "../llm/schema";

const TURNS = [
  "Welcome to PaperCast. Today the paper is Amazon Aurora, and the authors argue the network is the real constraint on throughput.",
  "The authors replicate data six ways across three Availability Zones, which lets a whole zone fail without losing durability or availability at all.",
  "So the storage tier materializes pages from redo records, and the database never writes full pages across the network to disk.",
];

const EPISODE: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: TURNS.map((text, i) => ({
    speaker: (i % 2 === 0 ? "host" : "guest") as "host" | "guest",
    text,
  })),
};

describe("normalizeWords", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeWords("Welcome to PaperCast!")).toEqual([
      "welcome",
      "to",
      "papercast",
    ]);
  });

  it("keeps numbers and hyphenated words intact", () => {
    expect(normalizeWords("a 4/6 write-quorum of 10GB")).toEqual([
      "a",
      "4",
      "6",
      "write-quorum",
      "of",
      "10gb",
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(normalizeWords("   ...  ")).toEqual([]);
  });
});

describe("wordRecall", () => {
  it("is 1 for an exact match", () => {
    expect(wordRecall("hello there world", "hello there world")).toBe(1);
  });

  it("ignores case and punctuation, as a recognizer's output would differ", () => {
    expect(wordRecall("Welcome to PaperCast.", "welcome to papercast")).toBe(1);
  });

  it("is 0 when nothing was said", () => {
    expect(wordRecall("hello there world", "")).toBe(0);
  });

  it("counts multiplicity, so a repeated word must be heard twice", () => {
    expect(wordRecall("the network the disk", "the network disk")).toBeCloseTo(0.75, 5);
  });

  it("is unaffected by extra words in the transcript", () => {
    expect(wordRecall("hello world", "well hello there world indeed")).toBe(1);
  });

  it("treats empty expected text as fully recalled", () => {
    expect(wordRecall("", "anything at all")).toBe(1);
  });
});

describe("scoreTranscriptFidelity", () => {
  it("passes a faithful transcript with recognizer-level noise", () => {
    // A plausible recognition: casing lost, one word misheard.
    const transcript = TURNS.join(" ").replace("materializes", "materialises");
    const r = scoreTranscriptFidelity(EPISODE, transcript);
    expect(r.episodeRecall).toBeGreaterThan(0.95);
    expect(r.suspect).toEqual([]);
    expect(fidelityCheck(r).passed).toBe(true);
  });

  it("identifies exactly which turn went missing", () => {
    // The failure this exists for: synthesis dropped one turn entirely, and the
    // file still plays perfectly.
    const transcript = [TURNS[0], TURNS[2]].join(" ");
    const r = scoreTranscriptFidelity(EPISODE, transcript);
    expect(r.suspect.map((t) => t.turnIndex)).toEqual([1]);
    const check = fidelityCheck(r);
    expect(check.passed).toBe(false);
    expect(check.severity).toBe("error");
    expect(check.detail).toContain("turn 1");
  });

  it("reports which words are missing, for inspection", () => {
    const transcript = [TURNS[0], TURNS[2]].join(" ");
    const r = scoreTranscriptFidelity(EPISODE, transcript);
    expect(r.turns[1]!.missing.length).toBeGreaterThan(0);
    expect(r.turns[1]!.missing.join(" ")).toMatch(/replicate|zones|durability/);
  });

  it("catches a turn truncated halfway through", () => {
    const half = TURNS[1]!.split(" ").slice(0, 6).join(" ");
    const r = scoreTranscriptFidelity(EPISODE, [TURNS[0], half, TURNS[2]].join(" "));
    expect(r.suspect.map((t) => t.turnIndex)).toContain(1);
  });

  it("warns rather than errors when the whole episode recalls poorly", () => {
    // Widespread mis-recognition rather than one turn vanishing.
    const garbled = TURNS.join(" ")
      .split(" ")
      .map((w, i) => (i % 3 === 0 ? "mumble" : w))
      .join(" ");
    const r = scoreTranscriptFidelity(EPISODE, garbled);
    const check = fidelityCheck(r);
    if (r.suspect.length === 0) {
      expect(check.severity).toBe("warning");
    }
    expect(r.episodeRecall).toBeLessThan(0.9);
  });

  it("does not flag short turns, which score unreliably", () => {
    const shortEpisode: Episode = {
      summary: "s",
      keyPoints: ["k"],
      turns: [{ speaker: "host", text: "Right, exactly." }],
    };
    const r = scoreTranscriptFidelity(shortEpisode, "totally different words here");
    expect(r.suspect).toEqual([]);
  });

  it("reports word counts for both sides", () => {
    const r = scoreTranscriptFidelity(EPISODE, TURNS.join(" "));
    expect(r.scriptWords).toBeGreaterThan(50);
    expect(r.transcriptWords).toBe(r.scriptWords);
  });
});
