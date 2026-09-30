/**
 * Title pages flatten differently depending on layout. Each fixture here is a
 * real one, as pdf-parse delivered it, reduced to its author block.
 */
import { describe, it, expect } from "vitest";
import { frontMatter } from "./frontMatter";
import type { PaperStructure } from "./extract";

const paper = (title: string, titlePage: string): PaperStructure => ({
  title,
  abstract: "",
  sections: [],
  wordCount: 0,
  source: {
    text: `${titlePage}\nAbstract\nThe body of the paper starts here.`,
    pages: [{ page: 1, start: 0, end: titlePage.length + 40 }],
  },
});

describe("frontMatter", () => {
  it("reads one author per line, each with an affiliation and an email", () => {
    const fm = frontMatter(
      paper(
        "Attention Is All You Need",
        [
          "Provided proper attribution is provided, Google hereby grants permission to",
          "reproduce the tables and figures in this paper solely for use in journalistic or",
          "Attention Is All You Need",
          "Ashish Vaswani",
          "∗",
          "Google Brain",
          "avaswani@google.com",
          "Aidan N. Gomez",
          "∗ †",
          "University of Toronto",
          "aidan@cs.toronto.edu",
          "Łukasz Kaiser",
          "∗",
          "Google Brain",
        ].join("\n"),
      ),
    );
    expect(fm.authors).toEqual(["Ashish Vaswani", "Aidan N. Gomez", "Łukasz Kaiser"]);
    // The permission notice mentions Google, and is not a place of work.
    expect(fm.affiliations).toEqual(["Google Brain", "University of Toronto"]);
  });

  it("reads names with footnote markers between them, and numbered affiliations", () => {
    const fm = frontMatter(
      paper(
        "Rethinking Verification for LLM Code Generation: From Generation to Testing",
        [
          "Rethinking Verification for LLM Code Generation:",
          "From Generation to Testing",
          "Zihan Ma",
          "1,2,3,∗",
          ", Taolin Zhang",
          "1,∗",
          ", Kai Chen",
          "1,†",
          "1",
          "Shanghai AI Laboratory",
          "2",
          "School of Computer Science and Technology, Xi’an Jiaotong University, China",
          "{mazihan880}@stu.xjtu.edu.cn",
        ].join("\n"),
      ),
    );
    expect(fm.authors).toEqual(["Zihan Ma", "Taolin Zhang", "Kai Chen"]);
    expect(fm.affiliations).toEqual([
      "Shanghai AI Laboratory",
      "School of Computer Science and Technology, Xi’an Jiaotong University, China",
    ]);
  });

  it("splits names laid out side by side, spaced or run together", () => {
    const spaced = frontMatter(
      paper(
        "PurpCode",
        [
          "PurpCode",
          "Haoyu Zhai  Xiaona Zhou  Kiet A. Nguyen",
          "University of Illinois Urbana-Champaign",
        ].join("\n"),
      ),
    );
    expect(spaced.authors).toEqual(["Haoyu Zhai", "Xiaona Zhou", "Kiet A. Nguyen"]);
    expect(spaced.affiliations).toEqual(["University of Illinois Urbana-Champaign"]);

    const glued = frontMatter(
      paper(
        "Deep Residual Learning for Image Recognition",
        [
          "Deep Residual Learning for Image Recognition",
          "Kaiming HeXiangyu ZhangShaoqing RenJian Sun",
          "Microsoft Research",
        ].join("\n"),
      ),
    );
    expect(glued.authors).toEqual([
      "Kaiming He",
      "Xiangyu Zhang",
      "Shaoqing Ren",
      "Jian Sun",
    ]);
  });

  it("does not take the title, a wrapped title, or an award for people or places", () => {
    const fm = frontMatter(
      paper(
        "Small Models, Big Support: A Local LLM Framework for Educator-Centric Content Creation and Assessment with RAG and CAG",
        [
          "Small Models, Big Support: A Local LLM Framework for Educator-Centric",
          "Content Creation and Assessment with RAG and CAG",
          "Zarreen Reza",
          "1",
          ", Robin Ray-Chaudhuri",
          "2",
          "John Abbott College",
          "Winner Defender Team at Amazon Nova AI Challenge 2025",
        ].join("\n"),
      ),
    );
    expect(fm.authors).toEqual(["Zarreen Reza", "Robin Ray-Chaudhuri"]);
    expect(fm.affiliations).toEqual(["John Abbott College"]);
  });

  it("finds nothing rather than guessing when there is no title page", () => {
    const fm = frontMatter({ title: "T", abstract: "", sections: [], wordCount: 0 });
    expect(fm).toEqual({ authors: [], affiliations: [] });
  });
});
