/**
 * The measure the writer and the grader share.
 *
 * The case that matters is the one that reached a listener twice: a four-minute
 * request answered with roughly two minutes of audio. The first time the cause
 * was a model that stopped early. The second time the model was within its word
 * target and the *target* was wrong — an ELI5 episode speaks about 200 words a
 * minute where a solo episode speaks 150, so 600 words is four minutes of one
 * and two of the other.
 */
import { describe, it, expect } from "vitest";
import {
  CHARS_PER_MINUTE,
  charTargetFor,
  describeShortfall,
  measureLength,
  spokenCharCount,
  targetTurnCount,
  wordTargetFor,
  wordsPerMinuteFor,
} from "./length";

/** A turn of roughly `chars` characters, in words of a plausible length. */
const text = (chars: number) => {
  let out = "";
  let i = 0;
  while (out.length < chars)
    out += `${["research", "attention", "models", "trained"][i++ % 4]} `;
  return out.slice(0, chars).trim();
};

const episodeOf = (perTurn: number[]) => ({
  turns: perTurn.map((n) => ({ speaker: "narrator" as const, text: text(n) })),
});

describe("the budget", () => {
  it("is set in characters, because words per minute is not stable", () => {
    // Measured across six finished episodes: words per minute ranged 149–204,
    // characters per minute 1,070–1,140.
    expect(charTargetFor(4)).toBe(4_400);
    expect(charTargetFor(1)).toBe(CHARS_PER_MINUTE);
  });

  it("asks an ELI5 episode for more words than a solo one, for the same minutes", () => {
    // The bug this fixes. Four minutes of ELI5 is more words than four minutes
    // of solo, because the words are shorter.
    const eli5 = wordTargetFor(4, "eli5");
    const solo = wordTargetFor(4, "solo");
    expect(eli5).toBeGreaterThan(solo);
    expect(eli5).toBeGreaterThan(750);
    expect(solo).toBeGreaterThan(600);
  });

  it("reports the speaking rate each format actually runs at", () => {
    expect(wordsPerMinuteFor("eli5")).toBeGreaterThan(wordsPerMinuteFor("solo"));
    expect(wordsPerMinuteFor("eli5")).toBeGreaterThan(190);
    expect(wordsPerMinuteFor("solo")).toBeLessThan(165);
  });
});

describe("measureLength", () => {
  it("counts only what is spoken", () => {
    expect(spokenCharCount(episodeOf([100, 100]))).toBe(201);
  });

  it("calls the ELI5 run short, which the word-based measure waved through", () => {
    // The real run: 424 words, 2,372 characters, against four minutes. The old
    // measure put it at 424/600 = 0.707 — just over the line, so nothing fired.
    const got = measureLength(episodeOf([2_372]), 4, "eli5");
    expect(got.chars).toBeCloseTo(2_372, -1);
    expect(got.estimatedMinutes).toBeCloseTo(2.16, 1);
    expect(got.ratio).toBeLessThan(0.6);
    expect(got.short).toBe(true);
  });

  it("calls a 2.9-minute answer to a 4-minute request short", () => {
    // 3,150 characters. Acceptable under the old 0.7 line, which is exactly the
    // leniency that let a four-minute request deliver under three.
    const got = measureLength(episodeOf([3_150]), 4, "solo");
    expect(got.estimatedMinutes).toBeCloseTo(2.86, 1);
    expect(got.short).toBe(true);
  });

  it("leaves an on-target episode alone", () => {
    const got = measureLength(episodeOf([4_935]), 4, "solo");
    expect(got.estimatedMinutes).toBeGreaterThan(4);
    expect(got.short).toBe(false);
    expect(got.collapsed).toBe(false);
  });

  it("does not spend a call on a near miss", () => {
    // Within a sixth of the target: a second call to add twenty seconds costs
    // more than the gap is worth.
    const got = measureLength(episodeOf([4_000]), 4, "solo");
    expect(got.ratio).toBeGreaterThan(0.85);
    expect(got.short).toBe(false);
  });

  it("separates 'worth continuing' from 'collapsed'", () => {
    // Two different judgements: the harness fails an episode at 0.7, the writer
    // reaches for another call at 0.85. Between them it is short but not broken.
    const between = measureLength(episodeOf([3_400]), 4, "solo");
    expect(between.short).toBe(true);
    expect(between.collapsed).toBe(false);

    const broken = measureLength(episodeOf([2_000]), 4, "solo");
    expect(broken.short).toBe(true);
    expect(broken.collapsed).toBe(true);
  });

  it("does not call a long episode short for using few turns", () => {
    // A model that writes the whole target in three long beats has delivered
    // the audio that was asked for. Splitting it further is taste, not a fix.
    const got = measureLength(episodeOf([1_700, 1_700, 1_700]), 4, "solo");
    expect(got.turns).toBeLessThan(got.turnTarget);
    expect(got.short).toBe(false);
  });

  it("describes a shortfall in minutes, and stays quiet otherwise", () => {
    expect(describeShortfall(measureLength(episodeOf([1_100]), 4, "solo"))).toMatch(
      /~1\.0 min/,
    );
    expect(
      describeShortfall(measureLength(episodeOf([4_800]), 4, "solo")),
    ).toBeUndefined();
  });

  it("keeps the writer and the grader on one turn floor", () => {
    expect(targetTurnCount(4)).toBe(14);
    expect(targetTurnCount(4, "solo")).toBe(8);
  });
});
