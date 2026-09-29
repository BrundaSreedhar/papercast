/**
 * Asking the paper a question.
 *
 * The same standard as the episode: answer only from the paper, and say so
 * when it does not address the question. A model asked about a paper will
 * answer from what it knows about the field, fluently and plausibly, and the
 * reader has no way to tell which sentence came from the document in front of
 * them — so every answer is labelled by kind and every quote is looked up.
 *
 * By default the question is answered by an agent that investigates the paper
 * (`./agent`): it searches, reads, and checks its own quotes before answering,
 * instead of retrieving once and hoping. The single-pass answer (`./answer`)
 * remains for warming a local model, and as the fallback when a provider
 * cannot hold the agent's step schema — the reader still gets an answer, and
 * `mode` says which path produced it.
 */
import { answerOnce, type ChatTurn, type PaperReply } from "./answer";
import { investigate, type AgentTrace } from "./agent";
import type { LLMProvider } from "../llm/types";
import type { PaperStructure } from "../pdf/extract";

export * from "./answer";
export { investigate, paperTools, paperOutline, MAX_STEPS } from "./agent";
export type { AgentTrace, AgentStep } from "./agent";

export interface AskOptions {
  provider: LLMProvider;
  history?: ChatTurn[];
  /** The answer's prose as it arrives, on providers that stream. */
  onText?: (soFar: string) => void;
  /** Each step of the investigation as it completes. */
  onStep?: (step: AgentTrace) => void;
  /**
   * "agent" investigates; "single-pass" retrieves once, or sends the whole
   * paper, and answers. Defaults to the agent.
   */
  mode?: "agent" | "single-pass";
  /** Single-pass only: send retrieved sections rather than the whole paper. */
  retrieve?: boolean;
}

export type AskReply = PaperReply & {
  /** Which path produced the answer. */
  mode: "agent" | "single-pass";
  /** The investigation, step by step. Empty for a single-pass answer. */
  steps: AgentTrace[];
};

/** Ask a question about a paper, and get an answer with the pages behind it. */
export async function askPaper(
  paper: PaperStructure,
  question: string,
  opts: AskOptions,
): Promise<AskReply> {
  if (opts.mode !== "single-pass") {
    try {
      const reply = await investigate(paper, question, opts);
      return { ...reply, mode: "agent" };
    } catch (err) {
      // A provider that cannot hold the step schema — a small local model,
      // usually — still owes the reader an answer. Say so in the log, answer
      // the old way, and report which way it was.
      console.warn("[ask] the investigation failed; answering in one pass:", err);
    }
  }
  const reply = await answerOnce(paper, question, opts);
  return { ...reply, mode: "single-pass", steps: [] };
}
