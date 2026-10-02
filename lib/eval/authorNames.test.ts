/**
 * The check exists because every episode's welcome read out a byline — all
 * fourteen names on PurpCode. It has to catch that, and it has to leave alone
 * the thing the writer is told to say instead: where the authors work.
 */
import { describe, it, expect } from "vitest";
import { checkNoAuthorNames } from "./authorNames";
import type { PaperStructure } from "../pdf/extract";
import type { Episode } from "../llm/schema";

const TITLE_PAGE = [
  "Attention Is All You Need",
  "Ashish Vaswani",
  "Google Brain",
  "Noam Shazeer",
  "Google Brain",
  "Llion Jones",
  "Google Research",
  "Abstract",
].join("\n");

const PAPER: PaperStructure = {
  title: "Attention Is All You Need",
  abstract: "We propose the Transformer, based solely on attention.",
  sections: [
    {
      heading: "1 Introduction",
      content:
        "Recurrent models compute along symbol positions. Attention has a long reach.",
    },
  ],
  wordCount: 20,
  source: { text: TITLE_PAGE, pages: [{ page: 1, start: 0, end: TITLE_PAGE.length }] },
};

const said = (...lines: string[]): Episode => ({
  summary: "s",
  keyPoints: [],
  turns: lines.map((text) => ({ speaker: "narrator" as const, text })),
});

const run = (episode: Episode, paper: PaperStructure = PAPER) =>
  checkNoAuthorNames({ episode, paper, minutes: 4, showName: "PaperCast" });

describe("checkNoAuthorNames", () => {
  it("fails a welcome that reads out the byline", () => {
    const r = run(
      said("Welcome. Today's paper is by Ashish Vaswani, Noam Shazeer and others."),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("Ashish Vaswani");
    expect(r.detail).toContain("Noam Shazeer");
  });

  it("fails a surname on its own", () => {
    expect(
      run(said("Intro.", "Vaswani showed that attention alone is enough.")).passed,
    ).toBe(false);
  });

  it("passes where the authors work, which is what it should say instead", () => {
    expect(
      run(
        said(
          "Welcome. Today's paper comes from researchers at Google Brain and Google Research.",
        ),
      ).passed,
    ).toBe(true);
    expect(run(said("The paper was written by Google Brain researchers.")).passed).toBe(
      true,
    );
  });

  it("passes 'the authors'", () => {
    expect(run(said("The authors argue that attention is all you need.")).passed).toBe(
      true,
    );
  });

  it("ignores a surname the paper uses as an ordinary word", () => {
    // Llion Jones's surname is fine; but an author named Long or Reach must not
    // fail every episode that says "long". Here "reach" is in the body.
    const paper: PaperStructure = {
      ...PAPER,
      source: {
        text: "Attention Is All You Need\nAmy Reach\nGoogle Brain\nAbstract",
        pages: [{ page: 1, start: 0, end: 60 }],
      },
    };
    expect(
      run(said("Reach matters: attention connects distant words."), paper).passed,
    ).toBe(true);
    expect(run(said("Amy Reach wrote it."), paper).passed).toBe(false);
  });

  it("catches anyone introduced as an author, even when the title page did not parse", () => {
    const bare: PaperStructure = { ...PAPER, source: undefined };
    for (const line of [
      "The paper was written by Alexandre Verbitski.",
      "Verbitski and his colleagues designed it.",
      "As Gupta et al. describe, the log is the database.",
    ]) {
      expect(run(said(line), bare).passed, line).toBe(false);
    }
  });
});
