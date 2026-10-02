/**
 * The writer is told not to name the paper's authors, and told where they
 * work so it has something true to say instead. The eval checks the output
 * (`lib/eval/authorNames`); this checks the instruction is there at all, in
 * every format and in the shared rules continuations use.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserContent } from "./generateEpisode";
import { FAITHFULNESS } from "./promptShared";

describe("author names in the prompts", () => {
  it("forbids them in the rules every writer shares", () => {
    expect(FAITHFULNESS).toMatch(/Never say the names of the paper's authors/);
  });

  it("no longer asks the welcome to say who wrote the paper, in any format", () => {
    for (const format of ["dialogue", "solo", "eli5"] as const) {
      const prompt = buildSystemPrompt({
        minutes: 5,
        wordTarget: 700,
        showName: "PaperCast",
        hasFigures: false,
        format,
      });
      expect(prompt, format).not.toMatch(/who wrote it/i);
      expect(prompt, format).toMatch(/Never say the names of the paper's authors/);
    }
  });

  it("hands the writer where the authors work, when the title page says", () => {
    const user = buildUserContent("PAPER TEXT", false, [
      "Google Brain",
      "University of Toronto",
    ]);
    expect(user).toContain("WHERE THE AUTHORS WORK");
    expect(user).toContain("Google Brain; University of Toronto");
    expect(buildUserContent("PAPER TEXT", false)).not.toContain("WHERE THE AUTHORS WORK");
  });
});
