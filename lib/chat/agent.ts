/**
 * Answering a question about a paper by investigating it: agentic retrieval.
 *
 * The one-shot path retrieves once and answers from whatever came back. When
 * the retrieval missed — the reader asked in their own words and the paper
 * answers in its own, or the number lives in a section whose heading says
 * nothing about it — the answer is stuck with the miss, and the usual symptom
 * is "the paper does not address this" about something it does address.
 *
 * Here the model drives. It starts from the paper's outline and works one
 * action at a time — search the sections, find an exact phrase, read a section,
 * or answer — seeing the result of each before choosing the next. A search
 * that misses is followed by a rephrased one; a snippet that looks promising
 * is followed by reading the section; a long section is read in parts.
 *
 * The loop runs over structured output, not a provider's native tool calling.
 * Every provider this project supports can already be held to a schema, and
 * tool-calling APIs differ across all four; one action per step, as one JSON
 * object, works everywhere the rest of the app does, local models included.
 *
 * The discipline of the one-shot path is kept, and tightened in two places:
 *
 * - An answer "from the paper" is refused, once, if nothing has been read yet:
 *   an outline and search snippets are not the paper.
 * - Its quotes are looked up before it is accepted. Any that cannot be found are
 *   handed back, once, with the instruction to copy the wording exactly — so a
 *   paraphrased citation gets a chance to become a real one rather than being
 *   silently dropped.
 *
 * The step budget is small and firm. On the last step the model may only
 * answer, from what it has gathered, so a question always ends in an answer.
 */
import { z } from "zod";
import type { LLMProvider, Usage } from "../llm/types";
import { addUsage } from "../llm/usage";
import type { PaperStructure } from "../pdf/extract";
import { PaperLocator } from "../pdf/locate";
import { rankSections } from "./retrieve";
import type { DenseScorer } from "../embed/faiss";
import { withSpan } from "../trace/index";
import { tags } from "../trace/langsmith";
import * as TA from "../trace/attributes";
import {
  ANSWER_SYSTEM,
  AnswerKindSchema,
  locateQuotes,
  PaperAnswerSchema,
  type ChatTurn,
  type PaperReply,
} from "./answer";

/** Steps allowed, the answer included. Enough to search, read two things, answer. */
export const MAX_STEPS = 6;
/** Sections a search returns. */
const SEARCH_RESULTS = 4;
/** Exact-phrase hits a find returns. */
const FIND_RESULTS = 6;
/** Characters of a section returned by one read; a longer one continues. */
const READ_CHARS = 5_000;
/**
 * Characters of earlier observations kept in full. Older reads beyond this are
 * cut to their opening, so a long investigation cannot outgrow a small model.
 */
const OBSERVATION_BUDGET = 18_000;
const SNIPPET_CHARS = 220;

export const AgentStepSchema = z.object({
  thought: z
    .string()
    .describe("One short sentence: what you know so far, and why this action is next."),
  action: z
    .enum(["search", "find", "read", "answer"])
    .describe(
      "search: rank the sections against a description. find: locate an exact word, phrase or number. read: read a section by its heading. answer: give the final answer.",
    ),
  query: z
    .string()
    .describe(
      'For search, what to look for. For find, the exact text to find verbatim. Empty ("") for the other actions.',
    ),
  section: z
    .string()
    .describe(
      'For read, a section heading exactly as the outline lists it. Otherwise "".',
    ),
  kind: AnswerKindSchema.describe(
    'For answer, which kind of answer this is. For the other actions it is ignored; use "not-addressed".',
  ),
  answer: z
    .string()
    .describe('For answer, the answer in plain spoken prose. Otherwise "".'),
  quotes: z
    .array(z.string())
    .describe(
      'For a "from-paper" answer, passages copied VERBATIM from sections you have read, at most three. Otherwise empty.',
    ),
});

export type AgentStep = z.infer<typeof AgentStepSchema>;

/** One step of the investigation, as a reader is shown it. */
export interface AgentTrace {
  action: AgentStep["action"];
  /** The query searched or found, or the section read. */
  detail: string;
  /** What came of it, in a few words. */
  note: string;
}

export const AGENT_SYSTEM = `${ANSWER_SYSTEM}

HOW YOU WORK — you answer by investigating the paper, one action per step.
You can see the paper's outline: its title, abstract and section headings. The text itself you must search and read.
- search: ranks the sections against what you describe and shows a snippet of each. Use the reader's words first; if that misses, try the words the paper would use.
- find: finds an exact word, phrase, name or number wherever it appears, with the sentence around it. Use it for specifics: a metric, a value, a named component.
- read: reads one section by its heading, exactly as the outline lists it. A long section continues if you read it again.
- answer: gives the final answer. Only answer "from-paper" after reading the passages you quote — never from the outline or a search snippet alone. Quote only text you have read, copied exactly.
A background question can be answered without reading. If you have searched properly and the paper does not cover the question, answer "not-addressed".
Do not repeat an action you have already taken. Keep each thought to one short sentence.`;

/** The paper as the agent first sees it: enough to plan, none of the text. */
export function paperOutline(paper: PaperStructure): string {
  const lines = [`TITLE: ${paper.title}`];
  if (paper.abstract) lines.push(`ABSTRACT: ${paper.abstract}`);
  lines.push("SECTIONS:");
  for (const s of paper.sections) {
    lines.push(`- ${s.heading} (${s.content.length.toLocaleString("en-US")} characters)`);
  }
  if (paper.figures?.length) {
    lines.push(
      `FIGURES: ${paper.figures.length} figure and table descriptions, searchable like sections.`,
    );
  }
  return lines.join("\n");
}

/* ── tools ─────────────────────────────────────────────────────────────── */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*(\d+(\.\d+)*\.?|[ivx]+\.)\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The sections as the tools see them: the paper's, plus figure descriptions. */
function readable(paper: PaperStructure): { heading: string; content: string }[] {
  const figures = (paper.figures ?? []).map((f) => ({
    heading: `Figure on page ${f.page}${f.captions.length ? ` (${f.captions.join(" ")})` : ""}`,
    content: `[Described by a vision model, not quoted from the paper]\n${f.description}`,
  }));
  return [
    ...(paper.abstract ? [{ heading: "Abstract", content: paper.abstract }] : []),
    ...paper.sections,
    ...figures,
  ];
}

/** The sentence of a section that shares the most words with a query. */
function snippet(content: string, query: string): string {
  const wanted = new Set(
    norm(query)
      .split(" ")
      .filter((w) => w.length > 2),
  );
  const sentences = content.split(/(?<=[.!?])\s+/);
  let best = sentences[0] ?? "";
  let bestScore = -1;
  for (const s of sentences) {
    const score = norm(s)
      .split(" ")
      .filter((w) => wanted.has(w)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  const t = best.trim().replace(/\s+/g, " ");
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS - 1)}…` : t;
}

export interface Tools {
  search(query: string): Promise<{ observation: string; note: string }>;
  find(phrase: string): { observation: string; note: string };
  read(heading: string): { observation: string; note: string; heading?: string };
}

/** The agent's tools over one paper. Deterministic and local: no model calls. */
export function paperTools(
  paper: PaperStructure,
  opts: { dense?: DenseScorer | null } = {},
): Tools {
  const sections = readable(paper);
  // How far into each section the agent has read, so a second read continues.
  const offsets = new Map<string, number>();

  const resolve = (heading: string) => {
    const wanted = norm(heading);
    if (!wanted) return undefined;
    return (
      sections.find((s) => s.heading === heading) ??
      sections.find((s) => norm(s.heading) === wanted) ??
      sections.find((s) => norm(s.heading).startsWith(wanted)) ??
      sections.find((s) => norm(s.heading).includes(wanted))
    );
  };

  return {
    async search(query) {
      // The paper's own sections, ranked exactly as one-shot retrieval ranks
      // them; without the lexical veto, since a dense-only result is still a
      // lead worth a look — and is labelled as one.
      const ranked = await rankSections(
        { ...paper, sections: sections.filter((s) => s.heading !== "Abstract") },
        query,
        { dense: opts.dense, requireLexical: false },
      );
      const pool = sections.filter((s) => s.heading !== "Abstract");
      const top = ranked.order.slice(0, SEARCH_RESULTS).map((i) => pool[i]!);
      if (top.length === 0) {
        return {
          observation: `No section matches "${query}". Try the words the paper would use, or find an exact term.`,
          note: "no match",
        };
      }
      const weak = ranked.lexicalMatch
        ? ""
        : " (no section uses these words; ranked by meaning alone, so treat as leads)";
      return {
        observation:
          `Sections for "${query}"${weak}:\n` +
          top
            .map(
              (s, i) =>
                `${i + 1}. "${s.heading}" (${s.content.length.toLocaleString("en-US")} chars): ${snippet(s.content, query)}`,
            )
            .join("\n"),
        note: `${top.length} section${top.length === 1 ? "" : "s"}`,
      };
    },

    find(phrase) {
      const needle = phrase.trim().toLowerCase();
      if (needle.length < 2)
        return { observation: "Give a word or phrase to find.", note: "empty" };
      const hits: string[] = [];
      for (const s of sections) {
        for (const sentence of s.content.split(/(?<=[.!?])\s+/)) {
          if (!sentence.toLowerCase().includes(needle)) continue;
          const t = sentence.trim().replace(/\s+/g, " ");
          hits.push(`- in "${s.heading}": ${t.length > 300 ? `${t.slice(0, 299)}…` : t}`);
          if (hits.length >= FIND_RESULTS) break;
        }
        if (hits.length >= FIND_RESULTS) break;
      }
      return hits.length
        ? {
            observation: `"${phrase}" appears:\n${hits.join("\n")}`,
            note: `${hits.length} place${hits.length === 1 ? "" : "s"}`,
          }
        : {
            observation: `"${phrase}" does not appear in the paper.`,
            note: "not in the paper",
          };
    },

    read(heading) {
      const s = resolve(heading);
      if (!s) {
        return {
          observation: `There is no section called "${heading}". The sections are: ${sections.map((x) => `"${x.heading}"`).join(", ")}.`,
          note: "no such section",
        };
      }
      const from = offsets.get(s.heading) ?? 0;
      if (from >= s.content.length) {
        return {
          observation: `You have already read all of "${s.heading}".`,
          note: "already read",
          heading: s.heading,
        };
      }
      const part = s.content.slice(from, from + READ_CHARS);
      const to = from + part.length;
      offsets.set(s.heading, to);
      const rest = s.content.length - to;
      return {
        observation:
          `"${s.heading}"${from > 0 ? " (continued)" : ""}:\n${part}` +
          (rest > 0
            ? `\n[…${rest.toLocaleString("en-US")} more characters; read "${s.heading}" again to continue]`
            : ""),
        note: from > 0 ? "continued" : rest > 0 ? "first part" : "whole section",
        heading: s.heading,
      };
    },
  };
}

/* ── the loop ─────────────────────────────────────────────────────────── */

interface Taken {
  step: AgentStep;
  observation: string;
}

/** The investigation so far, as the next step sees it. */
function transcript(taken: Taken[]): string {
  let budget = OBSERVATION_BUDGET;
  // Newest first for the budget, so the most recent reads stay whole.
  const rendered = [...taken].reverse().map((t, fromEnd) => {
    const n = taken.length - fromEnd;
    const what =
      t.step.action === "read"
        ? `read "${t.step.section}"`
        : t.step.action === "answer"
          ? "answer (sent back)"
          : `${t.step.action} "${t.step.query}"`;
    let obs = t.observation;
    if (obs.length > budget)
      obs = `${obs.slice(0, Math.max(400, budget))}\n[…cut for length]`;
    budget = Math.max(0, budget - obs.length);
    return `STEP ${n} — ${what}\n${obs}`;
  });
  return rendered.reverse().join("\n\n");
}

export interface AgentOptions {
  provider: LLMProvider;
  history?: ChatTurn[];
  onText?: (soFar: string) => void;
  /** Each step as it completes, for showing the investigation live. */
  onStep?: (step: AgentTrace) => void;
  maxSteps?: number;
  /** Injectable for tests; defaults to the FAISS-backed scorer. */
  dense?: DenseScorer | null;
}

/** Answer a question about a paper by investigating it. */
export async function investigate(
  paper: PaperStructure,
  question: string,
  opts: AgentOptions,
): Promise<PaperReply & { steps: AgentTrace[] }> {
  const maxSteps = Math.max(2, opts.maxSteps ?? MAX_STEPS);
  const tools = paperTools(paper, { dense: opts.dense });
  const outline = paperOutline(paper);
  const conversation = (opts.history ?? [])
    .slice(-6)
    .map((t) => `${t.role === "user" ? "READER" : "YOU"}: ${t.content}`)
    .join("\n");

  const taken: Taken[] = [];
  const steps: AgentTrace[] = [];
  const read: string[] = [];
  let usage: Usage = {};
  let pushedBackUnread = false;
  let pushedBackQuotes = false;

  const record = (trace: AgentTrace) => {
    steps.push(trace);
    opts.onStep?.(trace);
  };

  for (let n = 1; n <= maxSteps; n++) {
    const last = n === maxSteps;
    const user = [
      conversation ? `Earlier in this conversation:\n${conversation}\n` : "",
      `The reader asks: ${question}`,
      taken.length ? `\nWHAT YOU HAVE DONE SO FAR:\n\n${transcript(taken)}` : "",
      last
        ? "\nThis is your last step. You must answer now, from what you have read."
        : `\nYou have ${maxSteps - n + 1} steps left, this one included. Choose the next action.`,
    ].join("\n");

    const result = await withSpan(
      `agent step ${n}`,
      { [TA.GEN_AI_AGENT_NAME]: "ask-paper", ...tags("agent", last && "final") },
      () =>
        last
          ? // The last step can only answer: a schema with no other action.
            opts.provider
              .generateStructured({
                system: AGENT_SYSTEM,
                cacheableContext: `PAPER OUTLINE\n\n${outline}`,
                user,
                schema: PaperAnswerSchema,
                schemaName: "answer",
                schemaDescription: "The final answer, from what has been read.",
                maxTokens: 2_000,
                temperature: 0.2,
                ...(opts.onText
                  ? { stream: { field: "answer", onText: opts.onText } }
                  : {}),
              })
              .then((r) => ({
                ...r,
                data: {
                  thought: "",
                  action: "answer" as const,
                  query: "",
                  section: "",
                  ...r.data,
                },
              }))
          : opts.provider.generateStructured({
              system: AGENT_SYSTEM,
              cacheableContext: `PAPER OUTLINE\n\n${outline}`,
              user,
              schema: AgentStepSchema,
              schemaName: "step",
              schemaDescription: "The next action in answering the reader's question.",
              maxTokens: 2_000,
              temperature: 0.2,
              ...(opts.onText
                ? {
                    stream: {
                      field: "answer",
                      // Other actions leave the answer empty; only real prose shows.
                      onText: (t: string) => {
                        if (t.trim()) opts.onText!(t);
                      },
                    },
                  }
                : {}),
            }),
    );
    usage = addUsage(usage, result.usage);
    const step = result.data;

    if (step.action === "answer") {
      // Refused once: an answer "from the paper" before reading any of it.
      if (step.kind === "from-paper" && read.length === 0 && !pushedBackUnread && !last) {
        pushedBackUnread = true;
        taken.push({
          step,
          observation:
            "Not accepted: you have not read any of the paper yet. Read the section that supports this before answering from the paper.",
        });
        record({ action: "answer", detail: "", note: "sent back: nothing read yet" });
        continue;
      }

      const quotes = step.kind === "from-paper" ? step.quotes : [];
      const citations = locateQuotes(paper, quotes);
      // Handed back once: quotes that are not in the paper as written.
      const locator = new PaperLocator(paper);
      const missing = locator.canCite ? quotes.filter((q) => !locator.find(q)) : [];
      if (missing.length && !pushedBackQuotes && !last) {
        pushedBackQuotes = true;
        taken.push({
          step,
          observation:
            `Not accepted yet: ${missing.length} quote${missing.length === 1 ? " is" : "s are"} not in the paper as written:\n` +
            missing.map((q) => `- "${q}"`).join("\n") +
            "\nCopy the exact wording from a section you have read, reading it again if you need to, or leave the quote out.",
        });
        record({ action: "answer", detail: "", note: "sent back: quotes not found" });
        continue;
      }

      record({ action: "answer", detail: "", note: step.kind });
      return {
        answer: step.answer,
        kind: step.kind,
        citations,
        consulted: read,
        grounded: step.kind === "from-paper" && citations.length > 0,
        usage,
        steps,
      };
    }

    // A tool step.
    if (step.action === "search") {
      const out = await tools.search(step.query);
      taken.push({ step, observation: out.observation });
      record({ action: "search", detail: step.query, note: out.note });
    } else if (step.action === "find") {
      const out = tools.find(step.query);
      taken.push({ step, observation: out.observation });
      record({ action: "find", detail: step.query, note: out.note });
    } else {
      const out = tools.read(step.section);
      taken.push({ step, observation: out.observation });
      if (out.heading && !read.includes(out.heading)) read.push(out.heading);
      record({ action: "read", detail: out.heading ?? step.section, note: out.note });
    }
  }

  // Unreachable: the last step's schema only allows an answer.
  throw new Error("The investigation ended without an answer.");
}
