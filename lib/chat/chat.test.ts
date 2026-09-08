/**
 * The thing worth testing here is not that an answer comes back. It is that a
 * quote the paper does not contain never becomes a citation, and that "the
 * paper does not say" survives all the way to the caller instead of being
 * smoothed into an answer.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { askPaper } from "./index";
import { parsePaperStructure, type PaperStructure } from "../pdf/extract";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";

const RAW = [
  "Amazon Aurora",
  "",
  "Abstract",
  "Aurora pushes redo processing to a multi-tenant scale-out storage service.",
  "",
  "2.1 Replication",
  "Each segment is replicated six ways across three availability zones using a write quorum.",
].join("\n");

const paper: PaperStructure = {
  ...parsePaperStructure(RAW),
  source: { text: RAW, pages: [{ page: 1, start: 0, end: RAW.length }] },
};

/** Answers with whatever it is told to, so the grounding can be tested alone. */
class StubProvider implements LLMProvider {
  readonly name = "open" as const;
  readonly model = "stub";
  last?: StructuredRequest<unknown>;

  constructor(private readonly reply: z.infer<z.ZodTypeAny>) {}

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    return {
      data: this.reply as T,
      usage: { inputTokens: 1, outputTokens: 1 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

describe("askPaper", () => {
  it("turns a real quote into a section and page", async () => {
    const provider = new StubProvider({
      answer: "Six ways, across three zones.",
      quotes: ["Each segment is replicated six ways across three availability zones"],
      kind: "from-paper" as const,
    });
    const reply = await askPaper(paper, "How many copies?", { provider });
    expect(reply.citations).toHaveLength(1);
    expect(reply.citations[0]!.page).toBe(1);
    expect(reply.citations[0]!.heading).toMatch(/replication/i);
  });

  it("drops a quote the paper does not contain", async () => {
    // The failure this exists to prevent: a fabricated citation is far more
    // convincing than a fabricated sentence, so it must degrade to nothing.
    const provider = new StubProvider({
      answer: "It trains on ImageNet for eighty epochs.",
      quotes: [
        "We train the model on ImageNet for eighty epochs with a batch size of 256",
      ],
      kind: "from-paper" as const,
    });
    const reply = await askPaper(paper, "How was it trained?", { provider });
    expect(reply.citations).toEqual([]);
    // The answer is still returned; it is the *evidence* that is withheld.
    expect(reply.answer).toContain("ImageNet");
  });

  it("marks an answer with no locatable support as ungrounded", async () => {
    // Seen on a real run: asked about a learning rate, a small model answered
    // that the paper "states the model was trained using a neural network
    // architecture" — about a paper on database storage — and claimed it had
    // answered. The quotes all failed to resolve, so nothing was shown, but the
    // prose still read as authoritative.
    const provider = new StubProvider({
      answer:
        "The paper states the model was trained with a neural network architecture.",
      quotes: ["We trained the model with a neural network architecture"],
      kind: "from-paper" as const,
    });
    const reply = await askPaper(paper, "What learning rate?", { provider });
    expect(reply.kind).toBe("from-paper");
    expect(reply.citations).toEqual([]);
    expect(reply.grounded).toBe(false);
  });

  it("counts an answer with a real passage behind it as grounded", async () => {
    const provider = new StubProvider({
      answer: "Six ways.",
      quotes: ["Each segment is replicated six ways across three availability zones"],
      kind: "from-paper" as const,
    });
    expect((await askPaper(paper, "How many?", { provider })).grounded).toBe(true);
  });

  it("carries a refusal through untouched", async () => {
    const provider = new StubProvider({
      answer: "The paper does not discuss neural networks.",
      quotes: [],
      kind: "not-addressed" as const,
    });
    const reply = await askPaper(paper, "What about neural networks?", { provider });
    expect(reply.kind).toBe("not-addressed");
    expect(reply.citations).toEqual([]);
    // A refusal is not an ungrounded claim; it is the paper saying nothing.
    expect(reply.grounded).toBe(false);
  });

  it("answers a background question without pretending the paper said it", async () => {
    // "What is an RNN" on a paper that replaces RNNs is a fair question from
    // someone trying to follow the argument, and refusing it is pedantry. But
    // the answer must be labelled, and must never carry a citation — quoting
    // the paper for general knowledge is the failure being avoided.
    const provider = new StubProvider({
      kind: "background" as const,
      answer:
        "A recurrent network processes a sequence one step at a time, carrying state forward.",
      quotes: ["Each segment is replicated six ways across three availability zones"],
    });
    const reply = await askPaper(paper, "What is an RNN?", { provider });
    expect(reply.kind).toBe("background");
    // A real quote, deliberately discarded: it supports nothing that was said.
    expect(reply.citations).toEqual([]);
    expect(reply.grounded).toBe(false);
    expect(reply.answer).toContain("recurrent network");
  });

  it("does not offer the same passage twice", async () => {
    const provider = new StubProvider({
      answer: "Six ways.",
      quotes: [
        "Each segment is replicated six ways across three availability zones",
        "replicated six ways across three availability zones using a write quorum",
      ],
      kind: "from-paper" as const,
    });
    const reply = await askPaper(paper, "How many copies?", { provider });
    // Two overlapping quotes resolve to one passage, and showing it twice would
    // read as two independent pieces of evidence.
    expect(reply.citations).toHaveLength(1);
  });

  it("sends the paper as cacheable context, so a conversation pays for it once", async () => {
    const provider = new StubProvider({ answer: "x", quotes: [], answered: true });
    await askPaper(paper, "anything?", { provider });
    expect(provider.last?.cacheableContext).toContain("Aurora pushes redo processing");
    expect(provider.last?.user).not.toContain("Aurora pushes redo processing");
  });

  it("replays recent history so a follow-up question makes sense", async () => {
    const provider = new StubProvider({ answer: "x", quotes: [], answered: true });
    await askPaper(paper, "And that one?", {
      provider,
      history: [
        { role: "user", content: "How many copies?" },
        { role: "assistant", content: "Six." },
      ],
    });
    expect(provider.last?.user).toContain("How many copies?");
    expect(provider.last?.user).toContain("And that one?");
  });

  it("cannot cite at all when the paper has no PDF behind it", async () => {
    const provider = new StubProvider({
      answer: "Six ways.",
      quotes: ["Each segment is replicated six ways across three availability zones"],
      kind: "from-paper" as const,
    });
    const reply = await askPaper(parsePaperStructure(RAW), "How many copies?", {
      provider,
    });
    expect(reply.citations).toEqual([]);
  });
});
