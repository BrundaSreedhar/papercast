import { describe, it, expect } from "vitest";
import {
  joinTextItems,
  pageAt,
  parsePaperStructure,
  paperToText,
  type PaperSource,
} from "./extract";

// A realistic flattened-PDF fixture: title, authors, abstract, numbered
// sections, figure/table noise, references, acknowledgments, appendix.
const FIXTURE = `Attention Is Some of What You Need
Jane Researcher, John Scholar
University of Somewhere

Abstract
We present a method for turning papers into podcasts. Our approach
improves faithfulness over prior work by 12 points.

1 Introduction
Academic papers are dense. Deep learning has changed summarization.
Figure 1: An overview of the pipeline.

2 Methods
We use a two-stage pipeline with section-aware extraction.
Table 2: Hyperparameters used in training.
The second stage generates a dialogue.

3 Results
Our system achieves a faithfulness score of 0.91.

4 Conclusion
Section-aware extraction matters.

Acknowledgments
We thank our reviewers and our funding agency.

References
[1] Vaswani et al. Attention Is All You Need. 2017.
[2] Someone. Another Paper. 2020.

Appendix A: Extra Derivations
Here are twenty more equations nobody asked for.
`;

describe("parsePaperStructure", () => {
  const paper = parsePaperStructure(FIXTURE);

  it("extracts the title", () => {
    expect(paper.title).toBe("Attention Is Some of What You Need");
  });

  it("captures the abstract separately", () => {
    expect(paper.abstract).toContain("turning papers into podcasts");
  });

  it("keeps core sections", () => {
    const headings = paper.sections.map((s) => s.heading.toLowerCase());
    expect(headings.some((h) => h.includes("introduction"))).toBe(true);
    expect(headings.some((h) => h.includes("methods"))).toBe(true);
    expect(headings.some((h) => h.includes("results"))).toBe(true);
  });

  it("strips references, acknowledgments, and appendix", () => {
    const joined = paperToText(paper).toLowerCase();
    expect(joined).not.toContain("vaswani");
    expect(joined).not.toContain("we thank our reviewers");
    expect(joined).not.toContain("twenty more equations");
  });

  it("removes figure and table caption lines", () => {
    const joined = paperToText(paper);
    expect(joined).not.toContain("Figure 1:");
    expect(joined).not.toContain("Table 2:");
    // but the surrounding prose survives
    expect(joined).toContain("two-stage pipeline");
  });

  it("reports a positive word count", () => {
    expect(paper.wordCount).toBeGreaterThan(30);
  });
});

describe("multi-line titles", () => {
  // Mirrors the real line layout of the Amazon Aurora paper, where the title
  // wraps across two lines and is terminated by a whitespace-only line.
  const WRAPPED = `



Amazon Aurora: Design Considerations for High
Throughput Cloud-Native Relational Databases

Alexandre Verbitski, Anurag Gupta, Debanjan Saha

Amazon Web Services
ABSTRACT
Amazon Aurora is a relational database service for OLTP workloads.

1 Introduction
Databases are hard.
`;

  it("joins wrapped title lines into one title", () => {
    const paper = parsePaperStructure(WRAPPED);
    expect(paper.title).toBe(
      "Amazon Aurora: Design Considerations for High Throughput Cloud-Native Relational Databases",
    );
  });

  it("still finds the abstract and sections after a wrapped title", () => {
    const paper = parsePaperStructure(WRAPPED);
    expect(paper.abstract).toContain("relational database service");
    expect(paper.sections.some((s) => s.heading.includes("Introduction"))).toBe(true);
  });

  it("stops at a heading rather than absorbing it", () => {
    const paper = parsePaperStructure("A Short Title\nABSTRACT\nBody text here.");
    expect(paper.title).toBe("A Short Title");
    expect(paper.abstract).toContain("Body text here");
  });

  it("does not run past the line bound on a title-less document", () => {
    const runOn = Array.from({ length: 10 }, (_, i) => `line number ${i} of prose`).join(
      "\n",
    );
    const paper = parsePaperStructure(runOn);
    expect(paper.title.length).toBeLessThanOrEqual(250);
    expect(paper.title.split(" of prose").length - 1).toBeLessThanOrEqual(3);
  });
});

describe("parsePaperStructure fallback", () => {
  it("handles text with no detectable headings and truncates references", () => {
    const raw =
      "Some Title Here\n\nThis is a blob of body text with no clear sections at all, " +
      "just running prose that describes an experiment and its findings in detail.\n\n" +
      "References\n[1] A citation that should be dropped.";
    const paper = parsePaperStructure(raw);
    const joined = paperToText(paper).toLowerCase();
    expect(joined).toContain("blob of body text");
    expect(joined).not.toContain("citation that should be dropped");
  });
});

describe("line provenance", () => {
  const DOC = [
    "A Paper About Things",
    "",
    "Abstract",
    "We describe a system.",
    "",
    "1 Introduction",
    "The network is the bottleneck.",
    "Figure 1: an architecture diagram",
    "7",
    "Segments are 10GB in size.",
  ].join("\n");

  it("records an offset that actually indexes the source text", () => {
    const paper = parsePaperStructure(DOC);
    const all = [
      ...(paper.abstractLines ?? []),
      ...paper.sections.flatMap((s) => s.lines ?? []),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) {
      expect(DOC.slice(line.at, line.at + line.text.length)).toBe(line.text);
    }
  });

  it("rebuilds content exactly from the lines it kept", () => {
    // If these ever disagree, a citation would point at text the model never
    // saw, which is worse than having no citation.
    for (const s of parsePaperStructure(DOC).sections) {
      expect((s.lines ?? []).map((l) => l.text).join("\n")).toBe(s.content);
    }
  });

  it("keeps offsets correct across the lines it drops", () => {
    const intro = parsePaperStructure(DOC).sections.find((s) =>
      /introduction/i.test(s.heading),
    );
    const last = intro!.lines!.at(-1)!;
    // The caption and the stray page number between the two sentences are gone,
    // so this line's offset must jump over them rather than shift by their size.
    expect(last.text).toBe("Segments are 10GB in size.");
    expect(DOC.slice(last.at, last.at + last.text.length)).toBe(last.text);
    expect(intro!.content).not.toContain("Figure 1");
  });
});

describe("pageAt", () => {
  const source: PaperSource = {
    text: "page one text\n\npage two text",
    pages: [
      { page: 1, start: 0, end: 15 },
      { page: 2, start: 15, end: 28 },
    ],
  };

  it("resolves an offset to the page it was printed on", () => {
    expect(pageAt(source, 0)).toBe(1);
    expect(pageAt(source, 14)).toBe(1);
    expect(pageAt(source, 15)).toBe(2);
  });

  it("returns undefined past the end rather than guessing the last page", () => {
    expect(pageAt(source, 999)).toBeUndefined();
  });
});

describe("the no-headings fallback", () => {
  it("keeps the body without leaking the title into it", () => {
    // Regression: the fallback sliced the text by a line index as though it
    // were a character offset, which chopped three characters off the front and
    // left the title sitting inside the body.
    const doc = [
      "Some Title That Is Long Enough",
      "",
      "The first real sentence of the body goes here and runs on.",
      "A second sentence of body text follows it.",
    ].join("\n");
    const paper = parsePaperStructure(doc);
    const body = paper.sections.map((s) => s.content).join("\n");
    expect(body).toContain("The first real sentence");
    expect(body).not.toContain("Some Title That Is Long Enough");
  });
});

describe("titles under a publisher's notice", () => {
  it("skips a permission notice and takes the real title", () => {
    // arXiv's copy of the transformer paper opens with three lines of Google
    // granting permission to reproduce its figures. That was becoming the
    // subject of the episode.
    const doc = [
      "Provided proper attribution is provided, Google hereby grants permission to",
      "reproduce the tables and figures in this paper solely for use in journalistic or",
      "scholarly works.",
      "Attention Is All You Need",
      "Ashish Vaswani",
      "",
      "Abstract",
      "The dominant sequence transduction models are based on recurrent networks.",
    ].join("\n");
    expect(parsePaperStructure(doc).title).toBe("Attention Is All You Need");
  });

  it("keeps the notice out of the body as well as out of the title", () => {
    const doc = [
      "This work is licensed under a Creative Commons Attribution 4.0 License.",
      "A Study of Something Real",
      "",
      "Abstract",
      "We study something real and report what we found.",
    ].join("\n");
    const paper = parsePaperStructure(doc);
    expect(paper.title).toBe("A Study of Something Real");
    expect(paperToText(paper)).not.toMatch(/creative commons/i);
  });

  it("does not mistake a paper's own words for a notice", () => {
    const doc = [
      "Rights Management in Distributed Systems",
      "",
      "Abstract",
      "We examine how permissions propagate.",
    ].join("\n");
    expect(parsePaperStructure(doc).title).toBe(
      "Rights Management in Distributed Systems",
    );
  });
});

describe("titles beside a byline", () => {
  it("stops before the authors rather than absorbing them", () => {
    const doc = [
      "Attention Is All You Need",
      "Ashish Vaswani",
      "",
      "Abstract",
      "x.",
    ].join("\n");
    expect(parsePaperStructure(doc).title).toBe("Attention Is All You Need");
  });

  it("stops before names a two-column layout ran together", () => {
    // "Kaiming HeXiangyu ZhangShaoqing RenJian Sun" is one line in the PDF.
    const doc = [
      "Deep Residual Learning for Image Recognition",
      "Kaiming HeXiangyu ZhangShaoqing RenJian Sun",
      "",
      "Abstract",
      "Deeper neural networks are more difficult to train.",
    ].join("\n");
    expect(parsePaperStructure(doc).title).toBe(
      "Deep Residual Learning for Image Recognition",
    );
  });

  it("still joins a title that wraps mid-phrase", () => {
    // The continuation is capitalized words and nothing else, which is exactly
    // what a byline looks like — but the line before it ends on "for".
    const doc = [
      "Retrieval-Augmented Generation for",
      "Knowledge-Intensive NLP Tasks",
      "",
      "Abstract",
      "Large pre-trained language models store factual knowledge.",
    ].join("\n");
    expect(parsePaperStructure(doc).title).toBe(
      "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    );
  });

  it("stops at a footnote marker hanging off a name", () => {
    const doc = ["Some Paper Title Here", "Jane Doe∗", "", "Abstract", "x."].join("\n");
    expect(parsePaperStructure(doc).title).toBe("Some Paper Title Here");
  });
});

/*
 * Every line below is a real one that extraction once mistook for a heading,
 * from the papers in the library. Each produced a fake section: a citation
 * labelled with a table header, a section split into sixteen pieces called
 * "model", or a bibliography leaking back in as paper.
 */
describe("what is not a heading", () => {
  const headings = (doc: string) =>
    parsePaperStructure(doc).sections.map((s) => s.heading);

  const NUMBERED = (middle: string[]) =>
    [
      "A Paper About Attention",
      "",
      "1 Introduction",
      "Recurrent models are slow because they compute one step after another.",
      "",
      "2 Model",
      "The model has an encoder and a decoder with attention between them.",
      ...middle,
      "It keeps going with more ordinary prose about the architecture here.",
      "",
      "3 Results",
      "The model reaches a new state of the art on two translation tasks.",
    ].join("\n");

  it("keeps a subscript on its own line inside its section", () => {
    // d_model, which pdf-parse splits into "d" and "model" on separate lines.
    const doc = NUMBERED([
      "Each layer has dimension d",
      "model",
      "= 512 in every sub-layer.",
    ]);
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("does not take a table header or a table row for a heading", () => {
    const doc = NUMBERED([
      "Model",
      "BLEUTraining Cost (FLOPs)",
      "EN-DEEN-FREN-DEEN-FR",
      "ByteNet [18]23.75",
      "10 GB 107,000 2,400",
    ]);
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("does not take a diagram label or an argument label for a heading", () => {
    const doc = NUMBERED(["ASYNC", "AZ 3", "PEER TO PEER GOSSIP", "AV2", "LOC"]);
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("does not take a numbered list item for a heading", () => {
    const doc = NUMBERED([
      "1. Each database-level transaction is broken up into",
      "multiple mini-transactions that are ordered.",
      "2. Exercise Generation: Produces customized teaching",
      "materials like lab exercises and quizzes.",
    ]);
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("does not take a year, a page number or a caption number for a section", () => {
    const doc = NUMBERED([
      "2015. We begin with a summary of results running industry",
      "34. Right: a bottleneck building block for ResNet-50",
    ]);
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("keeps a real heading with a colon in it", () => {
    const doc = NUMBERED([
      "",
      "2.1 Solution sketch: Asynchronous Processing",
      "We now describe it.",
    ]);
    expect(headings(doc)).toContain("2.1 Solution sketch: Asynchronous Processing");
  });

  it("drops everything after the bibliography starts, not just its first part", () => {
    const doc = [
      NUMBERED([]),
      "",
      "References",
      "[1] A. Author. A paper. 2023.",
      "2025. Accessed: 2025-05-09",
      "[2] B. Author. Another paper that runs on. 2024.",
      "",
      "A. Appendix Material",
      "Twenty more equations nobody asked for, in considerable detail here.",
    ].join("\n");
    expect(headings(doc)).toEqual(["1 Introduction", "2 Model", "3 Results"]);
  });

  it("reads a paper that titles its sections in words, and treats its numbers as lists", () => {
    const doc = [
      "A Framework for Educators",
      "",
      "Introduction",
      "Large language models have shown immense potential in many settings today.",
      "Our contributions are threefold.",
      "1. A Holistic, Teacher-Centric Workflow: While RAG is",
      "a common technique in student-facing tools, ours is for teachers.",
      "2. Architectural Adaptations for Small Model Efficacy",
      "We introduce two architectural components specifically for small models.",
      "",
      "Experimental Setup",
      "We evaluate the framework on three tasks with a panel of teachers here.",
      "Model",
      "Accuracy",
      "Clarity &",
      "Fluency",
      "",
      "Conclusion",
      "We introduced a framework for educator-centric content creation today.",
    ].join("\n");
    expect(headings(doc)).toEqual(["Introduction", "Experimental Setup", "Conclusion"]);
  });
});

describe("joinTextItems", () => {
  // A 10pt font: transform [10, 0, 0, 10, x, y]; width in the same units as x.
  const item = (str: string, x: number, width: number, y = 700) => ({
    str,
    transform: [10, 0, 0, 10, x, y],
    width,
  });

  it("puts back a word break pdf.js left out", () => {
    // "by more than" ends at x=160; "2.0 BLEU" starts 2.5pt later (0.25 em).
    expect(
      joinTextItems([item("by more than", 100, 60), item("2.0 BLEU", 162.5, 40)]),
    ).toBe("by more than 2.0 BLEU");
  });

  it("does not split a word whose fragments touch", () => {
    // Kerning leaves fragments of one word a hair apart (0.02 em).
    expect(joinTextItems([item("Trans", 100, 25), item("former", 125.2, 30)])).toBe(
      "Transformer",
    );
  });

  it("does not double a space that is already there", () => {
    expect(joinTextItems([item("by more ", 100, 40), item("than", 150, 20)])).toBe(
      "by more than",
    );
  });

  it("starts a new line when the baseline moves", () => {
    expect(
      joinTextItems([item("first line", 100, 50, 700), item("second", 100, 30, 688)]),
    ).toBe("first line\nsecond");
  });
});
