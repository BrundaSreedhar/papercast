/**
 * The judge schemas are written with every field required, because OpenAI's
 * strict json_schema mode rejects a schema whose object properties are not all
 * listed in `required`. That was a deliberate constraint stated in a comment
 * and never checked — so it would have broken the first time the judge ran on
 * GPT rather than Claude. These tests hold the whole family to it.
 */
import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ClaimExtractionSchema, CoverageSchema, VerificationSchema } from "./judgeSchema";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

function toJson(schema: Parameters<typeof zodToJsonSchema>[0]): JsonSchema {
  const j = zodToJsonSchema(schema, { $refStrategy: "none" }) as JsonSchema & {
    $schema?: unknown;
  };
  delete j.$schema;
  return j;
}

/** Walk every object in the schema and report any with unrequired properties. */
function objectsMissingRequired(node: JsonSchema, path = "root"): string[] {
  const problems: string[] = [];
  if (node.type === "object" && node.properties) {
    const props = Object.keys(node.properties);
    const required = node.required ?? [];
    const optional = props.filter((p) => !required.includes(p));
    if (optional.length) problems.push(`${path}: ${optional.join(", ")}`);
    for (const [k, v] of Object.entries(node.properties)) {
      problems.push(...objectsMissingRequired(v, `${path}.${k}`));
    }
  }
  if (node.items) problems.push(...objectsMissingRequired(node.items, `${path}[]`));
  return problems;
}

const SCHEMAS = {
  ClaimExtractionSchema,
  VerificationSchema,
  CoverageSchema,
};

describe("judge schemas are strict-mode compatible", () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} marks every property required`, () => {
      expect(objectsMissingRequired(toJson(schema))).toEqual([]);
    });

    it(`${name} converts to a well-formed object schema`, () => {
      const j = toJson(schema);
      expect(j.type).toBe("object");
      expect(Object.keys(j.properties ?? {}).length).toBeGreaterThan(0);
    });
  }
});

describe("judge schemas validate the shapes the judge relies on", () => {
  it("accepts a verdict list and rejects an unknown verdict value", () => {
    expect(
      VerificationSchema.safeParse({
        verdicts: [
          { claimIndex: 0, verdict: "supported", evidence: "q", specific: true },
        ],
      }).success,
    ).toBe(true);
    expect(
      VerificationSchema.safeParse({
        verdicts: [{ claimIndex: 0, verdict: "probably", evidence: "", specific: true }],
      }).success,
    ).toBe(false);
  });

  it("requires evidence to be present, using an empty string for absence", () => {
    // Absence is encoded rather than omitted, so strict mode stays satisfied.
    expect(
      VerificationSchema.safeParse({
        verdicts: [{ claimIndex: 0, verdict: "unsupported", specific: false }],
      }).success,
    ).toBe(false);
    expect(
      VerificationSchema.safeParse({
        verdicts: [
          { claimIndex: 0, verdict: "unsupported", evidence: "", specific: false },
        ],
      }).success,
    ).toBe(true);
  });

  it("requires an integer turn index on extracted claims", () => {
    expect(
      ClaimExtractionSchema.safeParse({
        claims: [{ turn: 1.5, text: "x", factual: true }],
      }).success,
    ).toBe(false);
  });

  it("accepts a coverage result set", () => {
    expect(
      CoverageSchema.safeParse({
        results: [{ contribution: "a", mentioned: true, evidence: "q" }],
      }).success,
    ).toBe(true);
  });
});
