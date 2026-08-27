import { describe, it, expect } from "vitest";
import { extractJson, looksLikeSchemaEcho, correctionFor } from "./openCompatible";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    const s = 'Here you go:\n```json\n{"a":1,"b":"two"}\n```';
    expect(extractJson(s)).toEqual({ a: 1, b: "two" });
  });

  it("strips plain ``` fences", () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("slices JSON out of surrounding prose", () => {
    const s = 'Sure! The result is {"x":[1,2,3]} — hope that helps.';
    expect(extractJson(s)).toEqual({ x: [1, 2, 3] });
  });

  it("throws on genuinely non-JSON content", () => {
    expect(() => extractJson("I cannot do that.")).toThrow();
  });
});

describe("looksLikeSchemaEcho", () => {
  it("recognizes the model returning the schema instead of data", () => {
    // The real failure: qwen2:7b replies with the schema embedded in its own
    // prompt. It parses as JSON and has no data key, so Zod reports the top
    // level field as missing and the cause is invisible.
    const echo = JSON.stringify({
      type: "object",
      properties: { claims: { type: "array" } },
      required: ["claims"],
      additionalProperties: false,
    });
    expect(looksLikeSchemaEcho(echo)).toBe(true);
  });

  it("does not mistake real data for a schema", () => {
    expect(
      looksLikeSchemaEcho(JSON.stringify({ claims: [{ turn: 0, text: "x" }] })),
    ).toBe(false);
  });

  it("does not flag data that merely has a type field", () => {
    // "type" alone is an ordinary field name; only the schema shape counts.
    expect(looksLikeSchemaEcho(JSON.stringify({ type: "object", claims: [] }))).toBe(
      false,
    );
  });

  it("says no rather than throwing on unparseable output", () => {
    expect(looksLikeSchemaEcho("I'm sorry, I cannot help with that.")).toBe(false);
  });
});

describe("correctionFor", () => {
  const echo = JSON.stringify({ type: "object", properties: {}, required: [] });

  it("names the mistake when the model echoed the schema", () => {
    // Telling a model that returned the schema to "conform to the schema" reads
    // as agreement, which is why every retry repeated the same output.
    const msg = correctionFor(new Error("claims: Required"), echo);
    expect(msg).toContain("JSON Schema itself");
    expect(msg).toContain("not the answer");
    expect(msg).toContain("properties");
  });

  it("falls back to the validation error for any other failure", () => {
    const msg = correctionFor(
      new Error("turns.0.speaker: Invalid enum value"),
      '{"turns":[]}',
    );
    expect(msg).toContain("turns.0.speaker");
    expect(msg).not.toContain("JSON Schema itself");
    // Still distinguishes data from definition, which the old wording did not.
    expect(msg).toContain("not the schema definition");
  });
});
