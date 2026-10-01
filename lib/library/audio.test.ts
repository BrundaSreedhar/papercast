/**
 * The deployment's first self-made episode could not be played at all: the
 * player pointed at public/, and Next decides what is in public/ when it
 * starts. The route that replaced it had better not introduce a subtler
 * version of the same thing — a player that cannot seek looks broken halfway
 * through a four-minute episode, and fails silently.
 */
import { describe, it, expect } from "vitest";
import { isSafeAudioId, parseRange } from "./audio";

const SIZE = 1000;

describe("parseRange", () => {
  it("returns nothing to do when no range was asked for", () => {
    expect(parseRange(null, SIZE)).toBeNull();
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it("reads an open-ended range, which is what a player sends first", () => {
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("reads a closed range", () => {
    expect(parseRange("bytes=100-200", SIZE)).toEqual({ start: 100, end: 200 });
  });

  it("reads a suffix range as the last N bytes, not the first", () => {
    // Reading "bytes=-500" as 0-500 would hand a seeking player the opening of
    // the episode, which looks like a seek that did nothing.
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("clamps an end past the file rather than failing", () => {
    expect(parseRange("bytes=900-99999", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("calls a range outside the file unsatisfiable", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=300-200", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("sends the whole file when the header is one it does not understand", () => {
    // Multipart ranges are legal and rare; answering with everything is
    // correct, where guessing would not be.
    expect(parseRange("bytes=0-99,200-299", SIZE)).toBeNull();
    expect(parseRange("furlongs=0-10", SIZE)).toBeNull();
  });
});

describe("isSafeAudioId", () => {
  it("accepts the ids episodes actually have", () => {
    expect(isSafeAudioId("4b529f37-baa1-42c0-a6a7-faad1f0e2b3c")).toBe(true);
    expect(isSafeAudioId("purpcode-reasoning-for-safer-code-generation-solo")).toBe(true);
  });

  it("refuses anything that could leave the audio directory", () => {
    // The id becomes a path, so this is the check that keeps it a filename.
    expect(isSafeAudioId("../../../etc/passwd")).toBe(false);
    expect(isSafeAudioId("foo/bar")).toBe(false);
    expect(isSafeAudioId("")).toBe(false);
  });
});
