import { z } from "zod";

/**
 * Schemas for the three judge passes.
 *
 * Every field is required rather than optional: OpenAI's strict json_schema
 * mode demands that all properties appear in `required`, so absence is encoded
 * as an empty string instead. Keeping the schemas strict-compatible means the
 * same judge can run on any provider.
 */

export const ClaimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        turn: z.number().int().describe("Index of the dialogue turn, starting at 0."),
        text: z
          .string()
          .describe(
            "One atomic assertion, restated so it stands alone without surrounding context.",
          ),
        factual: z
          .boolean()
          .describe(
            "True if this asserts something checkable about the paper. False for conversational filler such as greetings or 'that's fascinating'.",
          ),
      }),
    )
    .describe("Every distinct assertion made in the dialogue, in order."),
});

export const VerificationSchema = z.object({
  verdicts: z
    .array(
      z.object({
        claimIndex: z.number().int().describe("Index of the claim being judged."),
        verdict: z
          .enum(["supported", "unsupported", "contradicted"])
          .describe(
            "'supported' if the paper states or directly implies it; 'contradicted' if the paper says otherwise; 'unsupported' if the paper is simply silent.",
          ),
        evidence: z
          .string()
          .describe(
            "A short quote from the paper that supports or contradicts the claim. Empty string when the paper is silent.",
          ),
        specific: z
          .boolean()
          .describe(
            "True if the claim asserts a concrete detail — a number, name, dataset, or result. False for vague or general statements.",
          ),
      }),
    )
    .describe("One verdict per claim, in the same order as the claims given."),
});

export const CoverageSchema = z.object({
  results: z
    .array(
      z.object({
        contribution: z
          .string()
          .describe("The expected contribution, repeated verbatim."),
        mentioned: z
          .boolean()
          .describe("True if the episode conveys this idea, even in different words."),
        evidence: z
          .string()
          .describe("Short quote from the episode conveying it, or empty string."),
      }),
    )
    .describe("One result per expected contribution, in the order given."),
});

export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
