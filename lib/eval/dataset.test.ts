import { describe, it, expect } from "vitest";
import { checkExpectation } from "./dataset";

/**
 * `checkExpectation` decides whether judge validation passes. A bug here means
 * "validation passed" prints while the judge is broken, and every number
 * downstream inherits that. It is the gate on the gate, so it is tested first.
 */
describe("checkExpectation", () => {
  it("reports no violations when everything is within bounds", () => {
    const out = checkExpectation(
      { minFaithfulness: 0.8, maxDeterministicErrors: 0 },
      { faithfulness: 0.93, deterministicErrors: 0 },
    );
    expect(out).toEqual([]);
  });

  it("catches a judge that failed to detect known-bad content", () => {
    // The critical case: the MapReduce fixture is capped at 0.3 faithfulness.
    // Scoring it higher means the judge missed a total fabrication.
    const out = checkExpectation(
      { maxFaithfulness: 0.3 },
      { faithfulness: 0.91, deterministicErrors: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("failed to detect known-bad");
  });

  it("catches a judge that condemned a clean episode", () => {
    const out = checkExpectation(
      { minFaithfulness: 0.8 },
      { faithfulness: 0.42, deterministicErrors: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("below expected minimum");
  });

  it("catches too few deterministic errors on a known-bad fixture", () => {
    const out = checkExpectation(
      { minDeterministicErrors: 2 },
      { faithfulness: 0.9, deterministicErrors: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("expected at least 2");
  });

  it("catches unexpected deterministic errors on a clean fixture", () => {
    const out = checkExpectation(
      { maxDeterministicErrors: 0 },
      { faithfulness: 0.9, deterministicErrors: 3 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("expected at most 0");
  });

  it("accumulates every violation rather than stopping at the first", () => {
    const out = checkExpectation(
      { minFaithfulness: 0.8, maxDeterministicErrors: 0 },
      { faithfulness: 0.2, deterministicErrors: 4 },
    );
    expect(out).toHaveLength(2);
  });

  it("skips faithfulness bounds when the judge did not run", () => {
    // An unmeasured score must not be read as zero, which would fail every
    // minimum and report a broken judge that was simply never invoked.
    const out = checkExpectation(
      { minFaithfulness: 0.8 },
      { faithfulness: undefined, deterministicErrors: 0 },
    );
    expect(out).toEqual([]);
  });

  it("treats an empty expectation as always satisfied", () => {
    expect(checkExpectation({}, { faithfulness: 0, deterministicErrors: 99 })).toEqual(
      [],
    );
  });

  it("accepts a score exactly on the boundary", () => {
    expect(
      checkExpectation(
        { minFaithfulness: 0.8 },
        { faithfulness: 0.8, deterministicErrors: 0 },
      ),
    ).toEqual([]);
    expect(
      checkExpectation(
        { maxFaithfulness: 0.3 },
        { faithfulness: 0.3, deterministicErrors: 0 },
      ),
    ).toEqual([]);
  });
});
