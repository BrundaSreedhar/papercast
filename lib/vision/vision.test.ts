/**
 * Vision support adds a second way for the pipeline to be wrong: a figure
 * description is model-generated, so it is evidence but second-hand evidence.
 * These tests pin the parts that keep that distinction visible, and the
 * prompt discipline that keeps descriptions descriptive.
 */
import { describe, it, expect } from "vitest";
import { figuresToText } from "./describe";
import { VISION_SYSTEM, visionUserPrompt } from "./prompt";
import { paperToText, type PaperStructure } from "../pdf/extract";
import type { FigureDescription } from "./types";

const FIG: FigureDescription = {
  page: 4,
  captions: ["Table 1:", "Figure 3:"],
  description:
    "Table 1 lists two configurations. Mirrored MySQL: 780,000 transactions, 7.4 IOs/transaction. Aurora with Replicas: 27,378,000 transactions, 0.95 IOs/transaction.",
};

const PAPER: PaperStructure = {
  title: "Amazon Aurora",
  abstract: "A relational database service.",
  sections: [{ heading: "Introduction", content: "The network is the bottleneck." }],
  wordCount: 10,
};

describe("figuresToText", () => {
  it("labels descriptions as model-generated rather than quoted", () => {
    // The judge verifies claims against this text and has to be able to tell
    // what the paper says from what a model reported seeing.
    const out = figuresToText([FIG]);
    expect(out).toMatch(/produced by a vision model/i);
    expect(out).toMatch(/not text quoted from the paper/i);
  });

  it("keeps the captions and the page number with the description", () => {
    const out = figuresToText([FIG]);
    expect(out).toContain("Table 1:");
    expect(out).toContain("page 4");
    expect(out).toContain("27,378,000");
  });

  it("produces nothing when there are no figures", () => {
    expect(figuresToText([])).toBe("");
  });
});

describe("paperToText with figures", () => {
  it("omits the figures section entirely when none were described", () => {
    const text = paperToText(PAPER);
    expect(text).not.toMatch(/figures and tables/i);
    expect(text).toContain("The network is the bottleneck.");
  });

  it("appends described figures after the paper's own sections", () => {
    const text = paperToText({ ...PAPER, figures: [FIG] });
    expect(text.indexOf("Introduction")).toBeLessThan(text.indexOf("Figures and tables"));
    expect(text).toContain("0.95");
  });

  it("still marks them as derived once inside the full source text", () => {
    // Regression guard: the caveat must survive assembly, since this string is
    // exactly what the writer and the judge both read.
    expect(paperToText({ ...PAPER, figures: [FIG] })).toMatch(/vision model/i);
  });
});

describe("the vision prompt", () => {
  it("demands transcription rather than interpretation", () => {
    expect(VISION_SYSTEM).toMatch(/transcribe/i);
    expect(VISION_SYSTEM).toMatch(/never estimate a value that is not printed/i);
    expect(VISION_SYSTEM).toMatch(/description only/i);
  });

  it("gives an explicit way to report an empty page", () => {
    // Without this a model narrates the body prose, padding the source with
    // text that is already present.
    expect(VISION_SYSTEM).toContain("NONE");
  });

  it("passes the captions through so each figure is addressed", () => {
    expect(visionUserPrompt(["Figure 3:", "Table 1:"])).toContain("Figure 3:");
    expect(visionUserPrompt([])).toMatch(/any figure, table, or diagram/i);
  });
});
