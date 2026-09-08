/**
 * Reading a field out of half-arrived JSON. The cases that matter are the ones
 * where the buffer stops somewhere awkward — mid-escape, mid-key, before the
 * field exists — because every one of those happens several times per answer.
 */
import { describe, it, expect } from "vitest";
import { partialString } from "./partial";

describe("partialString", () => {
  it("reads a value that is still arriving", () => {
    expect(partialString('{"kind":"from-paper","answer":"The paper pro', "answer")).toBe(
      "The paper pro",
    );
  });

  it("reads a value that has finished", () => {
    expect(partialString('{"answer":"Six ways.","quotes":[]}', "answer")).toBe(
      "Six ways.",
    );
  });

  it("returns nothing before the field has appeared", () => {
    expect(partialString('{"kind":"from-p', "answer")).toBeUndefined();
    expect(partialString("{", "answer")).toBeUndefined();
    expect(partialString("", "answer")).toBeUndefined();
  });

  it("returns nothing when the key is there but the value has not started", () => {
    expect(partialString('{"answer"', "answer")).toBeUndefined();
    expect(partialString('{"answer":', "answer")).toBeUndefined();
    expect(partialString('{"answer": ', "answer")).toBeUndefined();
  });

  it("resolves escapes rather than showing them", () => {
    expect(partialString('{"answer":"a \\"quote\\" and a\\nbreak', "answer")).toBe(
      'a "quote" and a\nbreak',
    );
  });

  it("holds back an escape that is still arriving", () => {
    // Emitting the backslash would put a stray character on screen that then
    // vanishes when the next chunk lands.
    expect(partialString('{"answer":"nearly\\', "answer")).toBe("nearly");
    expect(partialString('{"answer":"nearly\\u00e', "answer")).toBe("nearly");
  });

  it("decodes a completed unicode escape", () => {
    expect(partialString('{"answer":"caf\\u00e9', "answer")).toBe("café");
  });

  it("stops at the end of its own field, not the object", () => {
    expect(partialString('{"answer":"done","quotes":["more text"]}', "answer")).toBe(
      "done",
    );
  });

  it("tolerates whitespace the model puts around the colon", () => {
    expect(partialString('{ "answer" : "spaced', "answer")).toBe("spaced");
  });
});
