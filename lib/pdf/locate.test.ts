/**
 * What a citation must never do is point somewhere wrong. These tests are
 * mostly about the cases where the answer is "I don't know" — a fabricated
 * quote, a quote too short to place, and above all a quote that only appears in
 * the part of the paper extraction threw away.
 */
import { describe, it, expect } from "vitest";
import { parsePaperStructure, type PaperStructure } from "./extract";
import { PaperLocator, locateQuote } from "./locate";

/** Parse text, then attach it as the source with the given page breaks. */
function paperFrom(raw: string, breakAt?: number): PaperStructure {
  const parsed = parsePaperStructure(raw);
  const pages =
    breakAt === undefined
      ? [{ page: 1, start: 0, end: raw.length }]
      : [
          { page: 1, start: 0, end: breakAt },
          { page: 2, start: breakAt, end: raw.length },
        ];
  return { ...parsed, source: { text: raw, pages } };
}

const DOC = [
  "Amazon Aurora Design Considerations",
  "",
  "Abstract",
  "Aurora pushes redo processing to a multi-tenant scale-out storage service.",
  "",
  "1 Introduction",
  "The bottleneck moves from compute and storage to the network layer.",
  "Each segment is replicated six ways across three availability zones.",
  "",
  "References",
  "Anderson and Blackwell. A survey of quorum systems in distributed storage.",
].join("\n");

describe("PaperLocator", () => {
  it("finds a verbatim quote and names its page and section", () => {
    const c = locateQuote(
      paperFrom(DOC),
      "the bottleneck moves from compute and storage",
    );
    expect(c).toBeDefined();
    expect(c!.match).toBe("exact");
    expect(c!.score).toBe(1);
    expect(c!.page).toBe(1);
    expect(c!.heading).toMatch(/introduction/i);
  });

  it("ignores whitespace and line wrapping in the quote", () => {
    const c = locateQuote(paperFrom(DOC), "  The Bottleneck   Moves\n  From Compute  ");
    expect(c?.match).toBe("exact");
  });

  it("rejoins a word the PDF hyphenated across a line break", () => {
    const wrapped = DOC.replace("availability", "availa-\nbility");
    const c = locateQuote(
      paperFrom(wrapped),
      "replicated six ways across three availability zones",
    );
    expect(c?.match).toBe("exact");
  });

  it("locates a quote that dropped a few words, and says it was approximate", () => {
    const c = locateQuote(
      paperFrom(DOC),
      "each segment is replicated six across availability zones",
    );
    expect(c).toBeDefined();
    expect(c!.match).toBe("approximate");
    // Scoring counts content words, so dropping filler does not lower it: the
    // quote is not verbatim, but everything it is *about* is there.
    expect(c!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("never cites text that extraction stripped from the paper", () => {
    // The single most important property here. The reference list is in the
    // source text but not in what any model was shown, so a quote from it must
    // be unplaceable rather than produce a confident page number.
    const c = locateQuote(
      paperFrom(DOC),
      "A survey of quorum systems in distributed storage",
    );
    expect(c).toBeUndefined();
  });

  it("returns nothing for a quote the paper does not contain", () => {
    const c = locateQuote(
      paperFrom(DOC),
      "the authors trained a transformer on ImageNet for eighty epochs",
    );
    expect(c).toBeUndefined();
  });

  it("refuses a quote too short to place confidently", () => {
    expect(locateQuote(paperFrom(DOC), "the network")).toBeUndefined();
  });

  it("reports the page a passage ends on when it crosses a break", () => {
    const breakAt = DOC.indexOf("Each segment");
    const c = locateQuote(
      paperFrom(DOC, breakAt),
      "the network layer. Each segment is replicated six ways",
    );
    expect(c?.page).toBe(1);
    expect(c?.pageEnd).toBe(2);
  });

  it("omits pageEnd when the passage sits on one page", () => {
    const c = locateQuote(
      paperFrom(DOC),
      "the bottleneck moves from compute and storage",
    );
    expect(c?.pageEnd).toBeUndefined();
  });

  it("cannot cite a paper parsed from text with no PDF behind it", () => {
    // Structures built in tests and fixtures have no source, and asking for a
    // citation must be answerable with "no" rather than an exception.
    const loc = new PaperLocator(parsePaperStructure(DOC));
    expect(loc.canCite).toBe(false);
    expect(loc.find("the bottleneck moves from compute and storage")).toBeUndefined();
  });

  it("does not cite a figure description as though the paper wrote it", () => {
    const paper: PaperStructure = {
      ...paperFrom(DOC),
      figures: [
        {
          page: 2,
          captions: ["Figure 1:"],
          description:
            "A diagram showing six storage nodes arranged in a ring formation.",
        },
      ],
    };
    // The description is rendered into the text a model sees, but it is a
    // vision model's words, so it carries no provenance and cannot be cited.
    expect(
      locateQuote(paper, "six storage nodes arranged in a ring formation"),
    ).toBeUndefined();
  });
});
