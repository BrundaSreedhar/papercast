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

/**
 * What kind of answer this is.
 *
 * The distinction is the feature. "What does this paper claim about X" and
 * "what is an RNN" are both fair questions from someone trying to understand a
 * paper, but only the first can be answered from it. Refusing the second is
 * pedantry — the paper talks about recurrent networks and never defines them,
 * and a reader who does not know what one is cannot follow the argument.
 *
 * Letting background in unlabelled would be worse than refusing, though, since
 * the whole point of this project is that you can tell what came from the paper.
 * So the model must say which it is doing, and the interface shows it.
 */
export const AnswerKindSchema = z.enum(["from-paper", "background", "not-addressed"]);
export type AnswerKind = z.infer<typeof AnswerKindSchema>;

export const PaperAnswerSchema = z.object({
  kind: AnswerKindSchema.describe(
    '"from-paper" when the paper itself answers the question. "background" when the question is about a concept, method or term the paper refers to but does not explain, and you are answering from general knowledge to help the reader follow it. "not-addressed" when the paper does not address it and it is not background needed to understand the paper.',
  ),
  answer: z
    .string()
    .describe(
      "The answer in plain prose, two to six sentences. Spoken register, no markdown, no bullet points.",
    ),
  quotes: z
    .array(z.string())
    .describe(
      'Passages copied VERBATIM from the paper that support the answer, longest first, at most three. Copy the wording exactly — do not paraphrase, summarize, or join separate sentences. Empty unless kind is "from-paper".',
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
  /** Which of the three kinds of answer this is. */
  kind: AnswerKind;
  /** Where each supporting passage sits in the paper. Empty for background. */
  citations: Citation[];
  /**
   * True when the answer claims the paper says something *and* at least one
   * supporting passage was found in it.
   *
   * The gap this closes is not theoretical. Asked about a learning rate, a
   * small model answered that the paper "states the model was trained using a
   * neural network architecture" — about a paper on database storage — and
   * claimed to have answered from it. Every quote it offered failed to resolve,
   * so no citation appeared, but the prose still read as authoritative. Only a
   * "from-paper" answer with a located passage counts.
   *
   * Background is never grounded and is not meant to be: it is labelled as not
   * coming from the paper, which is a different promise, not a weaker one.
   */
  grounded: boolean;
  usage: Usage;
}

const SYSTEM = `You answer questions about one academic paper, for a reader who has just listened to an episode about it and is trying to understand it.

${FAITHFULNESS}

WHICH KIND OF ANSWER THIS IS — decide first, then answer:
- "from-paper": the paper itself answers the question. Everything you say must come from it, and you must quote the passages you relied on.
- "background": the question is about a concept, method, dataset or term that the paper refers to but does not explain — recurrent networks in a paper that replaces them, a metric it reports without defining. Answer from general knowledge, because a reader who does not know it cannot follow the paper. Say nothing about what this paper does with it beyond what the paper states, keep it to the general idea, and leave "quotes" empty.
- "not-addressed": the paper does not address it and it is not background needed to follow the paper. Say plainly that the paper does not cover it and stop. Do not offer what the answer probably is.

Never blur the first two. Explaining a general idea is helpful; attributing it to this paper when the paper did not say it is the failure this whole project exists to prevent. If a question has both parts — "what is an RNN and why did they drop it" — answer the paper's part as "from-paper" with quotes, and keep the general explanation to a sentence inside it.

ANSWERING:
- For a "from-paper" answer the paper is the only authority, and your own knowledge of the field must not appear in it however confident you are.
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
  opts: {
    provider: LLMProvider;
    history?: ChatTurn[];
    /**
     * Called with the answer's prose as it arrives, on providers that stream.
     *
     * Only the prose: the kind and the quotes are decided by the same response
     * but showing them mid-flight would mean labelling an answer "from the
     * paper" before it is, and offering citations that may still be discarded.
     */
    onText?: (soFar: string) => void;
  },
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
    ...(opts.onText ? { stream: { field: "answer", onText: opts.onText } } : {}),
  });

  const kind = result.data.kind;
  // Quotes are only meaningful for a claim about the paper. A background answer
  // that offered one would be citing the paper for something it never said.
  const citations = kind === "from-paper" ? locate(paper, result.data.quotes) : [];
  return {
    answer: result.data.answer,
    kind,
    citations,
    grounded: kind === "from-paper" && citations.length > 0,
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
