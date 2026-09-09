import { z } from "zod";

/**
 * The episode schema is the single source of truth for the model's output.
 * Every provider — Claude (tool-use), OpenAI (json_schema), and open models
 * (coerced JSON) — is held to exactly this shape and validated against it.
 */

export const DialogueTurnSchema = z.object({
  speaker: z
    .enum(["host", "guest", "narrator"])
    .describe(
      "Who is speaking. In a two-voice episode: 'host' guides the conversation and 'guest' explains the paper. In a solo episode every turn is 'narrator'. Never mix 'narrator' with the other two. No speaker has a name.",
    ),
  text: z
    .string()
    .describe("What this speaker says, in natural spoken language. No markdown."),
});

export const EpisodeSchema = z.object({
  summary: z
    .string()
    .describe(
      "A tight prose summary of the paper — problem, approach, key results, limitations — in at most 150 words.",
    ),
  keyPoints: z
    .array(z.string())
    .describe(
      "Five to eight of the paper's most important takeaways. Each is ONE sentence of at most 25 words, not a paragraph.",
    ),
  turns: z
    .array(DialogueTurnSchema)
    .describe(
      "The episode, split into turns. Two-voice episodes alternate host and guest; solo episodes are consecutive 'narrator' beats read back to back as one continuous talk.",
    ),
});

export type DialogueTurn = z.infer<typeof DialogueTurnSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;

export const EPISODE_SCHEMA_NAME = "episode";
export const EPISODE_SCHEMA_DESCRIPTION =
  "A podcast episode derived strictly from the provided paper: a summary, key points, and a two-host dialogue.";
export const EPISODE_SCHEMA_DESCRIPTION_ELI5 =
  "A podcast episode derived strictly from the provided paper: a plain summary, plain key points, and a single-voice story for a young child delivered as consecutive 'narrator' turns.";
export const EPISODE_SCHEMA_DESCRIPTION_SOLO =
  "A podcast episode derived strictly from the provided paper: a summary, key points, and a single-voice monologue delivered as consecutive 'narrator' turns.";
