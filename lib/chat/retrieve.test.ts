/**
 * Retrieval is only worth having if it never loses the answer. Most of these
 * check that it declines — a short paper, a question matching nothing, a
 * selection that would not be smaller — because in each case retrieving is cost
 * without benefit and the whole paper is the safer thing to send.
 */
import { describe, it, expect } from "vitest";
import { retrieveForQuestion } from "./retrieve";
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

describe("retrieveForQuestion", () => {
  it("finds the section holding the answer", () => {
    const got = retrieveForQuestion(paper, "How long does crash recovery take?");
    expect(got.whole).toBe(false);
    expect(got.sections).toContain("4.3 Recovery");
    expect(got.text).toContain("under ten seconds");
  });

  it("leaves out sections the question has nothing to do with", () => {
    const got = retrieveForQuestion(paper, "How long does crash recovery take?");
    expect(got.sections).not.toContain("5 Related Work");
  });

  it("gives relevance the budget before framing takes it", () => {
    // Regression: the abstract and introduction were added first, and on a long
    // paper they consumed the budget before the section that answered the
    // question could be considered. "How large is a segment" came back citing
    // the introduction and never mentioning ten gigabytes.
    const got = retrieveForQuestion(paper, "How large is a storage segment?", 3_000);
    expect(got.sections[0]).toBe("2.2 Segmented Storage");
    expect(got.text).toContain("10GB");
  });

  it("sends the whole paper when it is short enough not to matter", () => {
    const small: PaperStructure = {
      ...paper,
      sections: [{ heading: "1 Introduction", content: "A short paper about storage." }],
    };
    expect(retrieveForQuestion(small, "What about storage?").whole).toBe(true);
  });

  it("sends the whole paper rather than guessing when nothing matches", () => {
    const got = retrieveForQuestion(paper, "photosynthesis chlorophyll wavelengths");
    expect(got.whole).toBe(true);
  });

  it("sends the whole paper when a question is only stopwords", () => {
    expect(retrieveForQuestion(paper, "what is that for?").whole).toBe(true);
  });

  it("keeps the selection in document order rather than by rank", () => {
    // A paper read out of order is harder to follow, for a model as for anyone.
    const got = retrieveForQuestion(
      paper,
      "recovery and segmented storage sizing",
      40_000,
    );
    const order = got.sections.map((h) =>
      paper.sections.findIndex((s) => s.heading === h),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("always carries the title and abstract, whatever was selected", () => {
    const got = retrieveForQuestion(paper, "How long does crash recovery take?");
    expect(got.text).toContain("Amazon Aurora");
    expect(got.text).toContain("redo processing");
  });
});
