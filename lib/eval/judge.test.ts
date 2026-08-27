import { describe, it, expect } from "vitest";
import { renderDialogue, scoreFaithfulness } from "./judge";
import type { ClaimVerdict } from "./types";
import type { Episode } from "../llm/schema";

const v = (
  verdict: ClaimVerdict["verdict"],
  specific: boolean,
  claim = "c",
  turn = 0,
): ClaimVerdict => ({ turn, claim, verdict, specific });

describe("scoreFaithfulness", () => {
  it("scores an all-supported episode at 1 with no hallucination", () => {
    const r = scoreFaithfulness([v("supported", true), v("supported", false)]);
    expect(r.faithfulness).toBe(1);
    expect(r.hallucinationRate).toBe(0);
    expect(r.totalClaims).toBe(2);
  });

  it("counts a contradicted claim as a hallucination", () => {
    const r = scoreFaithfulness([v("supported", true), v("contradicted", true)]);
    expect(r.faithfulness).toBe(0.5);
    expect(r.hallucinationRate).toBe(0.5);
    expect(r.contradicted).toBe(1);
  });

  it("counts a specific unsupported claim as a hallucination", () => {
    // "Throughput rose 912%" when the paper never says so.
    const r = scoreFaithfulness([v("supported", true), v("unsupported", true)]);
    expect(r.hallucinationRate).toBe(0.5);
  });

  it("does not count vague unsupported framing as a hallucination", () => {
    // "This is an important area of research" — unsupported but harmless.
    const r = scoreFaithfulness([v("supported", true), v("unsupported", false)]);
    expect(r.faithfulness).toBe(0.5);
    expect(r.hallucinationRate).toBe(0);
  });

  it("scores a wholly fabricated episode at zero faithfulness", () => {
    // The MapReduce case: nothing traces back to the paper.
    const r = scoreFaithfulness([
      v("unsupported", true),
      v("unsupported", true),
      v("contradicted", true),
    ]);
    expect(r.faithfulness).toBe(0);
    expect(r.hallucinationRate).toBe(1);
  });

  it("returns zeroes rather than NaN for an empty verdict list", () => {
    const r = scoreFaithfulness([]);
    expect(r.faithfulness).toBe(0);
    expect(r.hallucinationRate).toBe(0);
    expect(Number.isNaN(r.faithfulness)).toBe(false);
  });
});

describe("renderDialogue", () => {
  it("numbers turns so verdicts can cite their source", () => {
    const ep: Episode = {
      summary: "s",
      keyPoints: ["k"],
      turns: [
        { speaker: "host", text: "Welcome." },
        { speaker: "guest", text: "Thanks." },
      ],
    };
    const out = renderDialogue(ep);
    expect(out).toContain("[0] HOST: Welcome.");
    expect(out).toContain("[1] GUEST: Thanks.");
  });
});
