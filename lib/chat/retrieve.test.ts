/**
 * Retrieval is only worth having if it never loses the answer. Most of these
 * check that it declines — a short paper, a question matching nothing, a
 * selection that would not be smaller — because in each case retrieving is cost
 * without benefit and the whole paper is the safer thing to send.
 *
 * Dense scoring is injected rather than reached over the network, so these run
 * with no endpoint and assert the fusion rather than the embedding model.
 */
import { describe, it, expect } from "vitest";
import { retrieveForQuestion, type DenseScorer } from "./retrieve";
import type { PaperStructure } from "../pdf/extract";

const filler = (topic: string, n = 120) =>
  Array.from(
    { length: n },
    (_, i) => `${topic} detail number ${i} explained at length.`,
  ).join(" ");

const paper: PaperStructure = {
  title: "Amazon Aurora",
  abstract: "Aurora pushes redo processing into the storage tier.",
  wordCount: 4000,
  sections: [
    { heading: "1 Introduction", content: filler("cloud database background") },
    {
      heading: "2.2 Segmented Storage",
      content: `Each segment is 10GB. ${filler("segment sizing")}`,
    },
    {
      heading: "4.3 Recovery",
      content: `Crash recovery takes under ten seconds. ${filler("recovery")}`,
    },
    { heading: "5 Related Work", content: filler("prior systems") },
  ],
};

/** Scores by heading, so a test can say which section a model would prefer. */
const prefers =
  (byHeading: Record<string, number>, fallback = 0.4): DenseScorer =>
  async (_question, passages) =>
    passages.map((p) => {
      const hit = Object.entries(byHeading).find(([h]) => p.startsWith(h));
      return hit ? hit[1] : fallback;
    });

/** Lexical only, which is what happens with no embedding endpoint anywhere. */
const lexicalOnly = { dense: null } as const;

describe("retrieveForQuestion", () => {
  it("finds the section holding the answer", async () => {
    const got = await retrieveForQuestion(
      paper,
      "How long does crash recovery take?",
      lexicalOnly,
    );
    expect(got.whole).toBe(false);
    expect(got.sections).toContain("4.3 Recovery");
    expect(got.text).toContain("under ten seconds");
  });

  it("leaves out sections the question has nothing to do with", async () => {
    const got = await retrieveForQuestion(
      paper,
      "How long does crash recovery take?",
      lexicalOnly,
    );
    expect(got.sections).not.toContain("5 Related Work");
  });

  it("gives relevance the budget before framing takes it", async () => {
    // Regression: the abstract and introduction were added first, and on a long
    // paper they consumed the budget before the section that answered the
    // question could be considered. "How large is a segment" came back citing
    // the introduction and never mentioning ten gigabytes.
    const got = await retrieveForQuestion(paper, "How large is a storage segment?", {
      budget: 3_000,
      dense: null,
    });
    expect(got.sections[0]).toBe("2.2 Segmented Storage");
    expect(got.text).toContain("10GB");
  });

  it("sends the whole paper when it is short enough not to matter", async () => {
    const small: PaperStructure = {
      ...paper,
      sections: [{ heading: "1 Introduction", content: "A short paper about storage." }],
    };
    const got = await retrieveForQuestion(small, "What about storage?", lexicalOnly);
    expect(got.whole).toBe(true);
  });

  it("sends the whole paper rather than guessing when nothing matches", async () => {
    const got = await retrieveForQuestion(
      paper,
      "photosynthesis chlorophyll wavelengths",
      lexicalOnly,
    );
    expect(got.whole).toBe(true);
  });

  it("sends the whole paper when a question is only stopwords", async () => {
    const got = await retrieveForQuestion(paper, "what is that for?", lexicalOnly);
    expect(got.whole).toBe(true);
  });

  it("keeps the selection in document order rather than by rank", async () => {
    // A paper read out of order is harder to follow, for a model as for anyone.
    const got = await retrieveForQuestion(
      paper,
      "recovery and segmented storage sizing",
      {
        budget: 40_000,
        dense: null,
      },
    );
    const order = got.sections.map((h) =>
      paper.sections.findIndex((s) => s.heading === h),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("always carries the title and abstract, whatever was selected", async () => {
    const got = await retrieveForQuestion(
      paper,
      "How long does crash recovery take?",
      lexicalOnly,
    );
    expect(got.text).toContain("Amazon Aurora");
    expect(got.text).toContain("redo processing");
  });
});

describe("retrieveForQuestion, with dense scoring", () => {
  it("finds the section a paraphrased question never names", async () => {
    // The case lexical matching cannot reach. "Stops abruptly" is what the
    // recovery section is about and none of those words are in it, so BM25
    // ranks the introduction — which merely says "database" — above it.
    const question = "What happens to the database when a machine stops abruptly?";
    const lexical = await retrieveForQuestion(paper, question, {
      budget: 16_000,
      dense: null,
    });
    expect(lexical.sections).not.toContain("4.3 Recovery");

    const hybrid = await retrieveForQuestion(paper, question, {
      budget: 16_000,
      dense: prefers({ "4.3 Recovery": 0.71 }),
    });
    expect(hybrid.method).toBe("hybrid");
    expect(hybrid.sections).toContain("4.3 Recovery");
  });

  it("still declines when the question has no lexical purchase at all", async () => {
    // Cosine ranks every section whether or not any of them is relevant, so a
    // confident-looking dense score must not be able to start a retrieval that
    // lexical scoring rejected. Measured: on one paper an off-topic probe
    // scored 0.497 where the best genuine answer scored 0.506.
    const got = await retrieveForQuestion(paper, "photosynthesis chlorophyll", {
      dense: prefers({ "5 Related Work": 0.97 }),
    });
    expect(got.whole).toBe(true);
  });

  it("falls back to lexical alone when embedding is unavailable", async () => {
    const unavailable: DenseScorer = async () => undefined;
    const got = await retrieveForQuestion(paper, "How long does crash recovery take?", {
      dense: unavailable,
    });
    expect(got.method).toBe("lexical");
    expect(got.sections).toContain("4.3 Recovery");
  });

  it("ranks the same as lexical alone when both rankers agree", async () => {
    const question = "How large is a storage segment?";
    const lexical = await retrieveForQuestion(paper, question, {
      budget: 3_000,
      dense: null,
    });
    const hybrid = await retrieveForQuestion(paper, question, {
      budget: 3_000,
      dense: prefers({ "2.2 Segmented Storage": 0.8 }),
    });
    expect(hybrid.sections).toEqual(lexical.sections);
  });

  it("does not let one dense opinion evict what lexical scoring found", async () => {
    // Fusion, not replacement. Related Work is the embedding model's favourite
    // and has no lexical purchase at all; Recovery is second on that ranking
    // and first on the other, and with room for one section it must win.
    const got = await retrieveForQuestion(paper, "How long does crash recovery take?", {
      budget: 3_000,
      dense: prefers({ "5 Related Work": 0.9, "4.3 Recovery": 0.6 }),
    });
    expect(got.sections).toEqual(["4.3 Recovery"]);
  });
});
