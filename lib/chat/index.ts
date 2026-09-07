/**
 * Asking the paper a question.
 *
 * The same standard as the episode: answer only from the paper, and say so
 * when it does not address the question. That is the harder half. A model asked
 * about a paper will answer from what it knows about the field, fluently and
 * plausibly, and the reader has no way to tell which sentence came from the
 * document in front of them.
 *
 * So the model is asked for the passages it relied on, and each one is resolved
 * back to a section and page by the same locator the transcript uses. A quote
 * that cannot be found in the paper is dropped rather than shown, which means a
 * fabricated citation degrades into a missing one instead of a convincing one.
 *
 * The paper travels as cacheable context, so a conversation of ten questions
 * pays for the document once rather than ten times.
 */
import { z } from "zod";
import { FAITHFULNESS } from "../llm/generateEpisode";
import type { LLMProvider, Usage } from "../llm/types";
import { paperToText, type PaperStructure } from "../pdf/extract";
import { PaperLocator, type Citation } from "../pdf/locate";

export const PaperAnswerSchema = z.object({
  answer: z
    .string()
    .describe(
      "The answer in plain prose, two to six sentences. Spoken register, no markdown, no bullet points.",
    ),
  quotes: z
    .array(z.string())
    .describe(
      "Passages copied VERBATIM from the paper that support the answer, longest first, at most three. Copy the wording exactly — do not paraphrase, summarize, or join separate sentences. Empty when the paper does not address the question.",
    ),
  answered: z
    .boolean()
    .describe(
      "False when the paper does not address the question, whatever else you say.",
    ),
});

export type PaperAnswer = z.infer<typeof PaperAnswerSchema>;

/** One exchange, as the client replays it back. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PaperReply {
  answer: string;
  /** Where each supporting passage sits in the paper. */
  citations: Citation[];
  /** False when the paper does not address the question. */
  answered: boolean;
  /**
   * True when the answer claims the paper says something *and* at least one
   * supporting passage was found in it.
   *
   * The gap this closes is not theoretical. Asked about a learning rate, a
   * small model answered "the paper does not specify the learning rate, but it
   * states the model was trained using a neural network architecture" — about
   * a paper on database storage — and set `answered` to true. Every quote it
   * offered failed to resolve, so no citation was shown, but the prose still
   * read as authoritative. An answer asserting something about the paper with
   * nothing found to support it is exactly the failure this project exists to
   * catch, and the caller has to be able to see it without reading closely.
   */
  grounded: boolean;
  usage: Usage;
}

const SYSTEM = `You answer questions about one academic paper, for a reader who has just listened to an episode about it.

${FAITHFULNESS}

ANSWERING:
- The paper is the only authority. Your own knowledge of the field is irrelevant and must not appear in the answer, however confident you are and however well known the fact.
- If the paper does not address the question, say plainly that it does not, set "answered" to false, and stop. Do not offer what the answer probably is. A reader who wanted a guess would not have asked about this paper.
- Quote to support what you say. Copy the supporting passages VERBATIM into "quotes" — exact wording, no paraphrase, no stitching separate sentences together. They are looked up in the paper afterwards, and one that cannot be found is discarded.
- Answer conversationally, as if speaking. No markdown, no headings, no bullet points.
- Keep it to two to six sentences unless the question genuinely needs more.
- Do not describe the episode, the show, or yourself. You are answering about the paper.`;

/** How much of the conversation is replayed. Enough for "what about that?" */
const HISTORY_TURNS = 6;

/** Ask a question about a paper, and get an answer with the pages behind it. */
export async function askPaper(
  paper: PaperStructure,
  question: string,
  opts: { provider: LLMProvider; history?: ChatTurn[] },
): Promise<PaperReply> {
  const history = (opts.history ?? []).slice(-HISTORY_TURNS);
  const conversation = history
    .map((t) => `${t.role === "user" ? "READER" : "YOU"}: ${t.content}`)
    .join("\n");

  const result = await opts.provider.generateStructured({
    system: SYSTEM,
    cacheableContext: `SOURCE PAPER\n\n${paperToText(paper)}`,
    user: conversation
      ? `Earlier in this conversation:\n${conversation}\n\nThe reader now asks: ${question}`
      : `The reader asks: ${question}`,
    schema: PaperAnswerSchema,
    schemaName: "answer",
    schemaDescription:
      "An answer drawn strictly from the provided paper, with supporting quotes.",
    maxTokens: 2_000,
    // Answering a question about a document is a lookup, not a performance.
    temperature: 0.2,
  });

  const citations = locate(paper, result.data.quotes);
  return {
    answer: result.data.answer,
    answered: result.data.answered,
    citations,
    grounded: result.data.answered && citations.length > 0,
    usage: result.usage,
  };
}

/**
 * Resolve the quoted passages, keeping only the ones that are really there.
 *
 * Duplicates are dropped by position rather than by text, because two quotes
 * that overlap resolve to the same passage and showing it twice reads as two
 * separate pieces of evidence.
 */
function locate(paper: PaperStructure, quotes: string[]): Citation[] {
  const locator = new PaperLocator(paper);
  if (!locator.canCite) return [];

  const found: Citation[] = [];
  for (const quote of quotes.slice(0, 3)) {
    const hit = locator.find(quote);
    if (!hit) continue;
    // Overlap rather than an identical start: a model asked for supporting
    // passages often returns two quotes that are the same sentence seen from
    // different ends, and offering both reads as two separate pieces of
    // evidence for one claim.
    const overlaps = found.some((c) => hit.start < c.end && c.start < hit.end);
    if (!overlaps) found.push(hit);
  }
  return found;
}

export type { Citation } from "../pdf/locate";
