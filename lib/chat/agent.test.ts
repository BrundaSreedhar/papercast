/**
 * The agent is only worth having if it behaves like a careful reader: it looks
 * before it answers, it cannot cite what it has not read, it fixes a quote it
 * got wrong, and it always ends with an answer. These script the model's
 * choices and check what the loop does with them.
 */
import { describe, it, expect } from "vitest";
import { askPaper, investigate, MAX_STEPS, paperOutline, paperTools } from "./index";
import type { AgentStep, AgentTrace } from "./index";
import { parsePaperStructure, type PaperStructure } from "../pdf/extract";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";

const RAW = [
  "Amazon Aurora",
  "",
  "Abstract",
  "Aurora pushes redo processing to a multi-tenant scale-out storage service.",
  "",
  "2.1 Replication",
  "Each segment is replicated six ways across three availability zones using a write quorum of four.",
  "",
  "3 Crash Recovery",
  "Recovery completes in under ten seconds because redo is applied by storage in the background.",
].join("\n");

const paper: PaperStructure = {
  ...parsePaperStructure(RAW),
  source: { text: RAW, pages: [{ page: 1, start: 0, end: RAW.length }] },
};

const step = (over: Partial<AgentStep>): AgentStep => ({
  thought: "",
  action: "search",
  query: "",
  section: "",
  kind: "not-addressed",
  answer: "",
  quotes: [],
  ...over,
});

/** Plays back a script of steps, recording each request it was sent. */
class ScriptedProvider implements LLMProvider {
  readonly name = "open" as const;
  readonly model = "scripted";
  requests: StructuredRequest<unknown>[] = [];
  constructor(private script: AgentStep[]) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const next = this.script.shift();
    if (!next) throw new Error("script ran out");
    // The final step is held to the answer-only schema; give it only those fields.
    const data =
      req.schemaName === "answer"
        ? { kind: next.kind, answer: next.answer, quotes: next.quotes }
        : next;
    return {
      data: req.schema.parse(data),
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: this.name,
      model: this.model,
      retries: 0,
    };
  }
}

const QUOTE = "Each segment is replicated six ways across three availability zones";

describe("investigate", () => {
  it("searches, reads, then answers with a located citation", async () => {
    const provider = new ScriptedProvider([
      step({ action: "search", query: "how many copies replicated" }),
      step({ action: "read", section: "Replication" }),
      step({
        action: "answer",
        kind: "from-paper",
        answer: "Six copies.",
        quotes: [QUOTE],
      }),
    ]);
    const reply = await investigate(paper, "How many copies?", { provider, dense: null });

    expect(reply.answer).toBe("Six copies.");
    expect(reply.grounded).toBe(true);
    expect(reply.citations[0]!.heading).toMatch(/replication/i);
    expect(reply.consulted).toEqual(["2.1 Replication"]);
    expect(reply.steps.map((s) => s.action)).toEqual(["search", "read", "answer"]);
    expect(reply.usage.inputTokens).toBe(30);
  });

  it("shows each step the result of the one before", async () => {
    const provider = new ScriptedProvider([
      step({ action: "search", query: "replicated" }),
      step({ action: "read", section: "2.1 Replication" }),
      step({ action: "answer", kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
    ]);
    await investigate(paper, "How many copies?", { provider, dense: null });
    // The read sees the search's results; the answer sees the section's text.
    expect(provider.requests[1]!.user).toContain('Sections for "replicated"');
    expect(provider.requests[2]!.user).toContain("write quorum of four");
    // The outline travels as the cacheable prefix, identical every step.
    expect(new Set(provider.requests.map((r) => r.cacheableContext)).size).toBe(1);
  });

  it("sends back an answer from the paper given before reading any of it", async () => {
    const provider = new ScriptedProvider([
      step({ action: "answer", kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
      step({ action: "read", section: "Replication" }),
      step({ action: "answer", kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
    ]);
    const reply = await investigate(paper, "How many copies?", { provider, dense: null });
    expect(reply.steps[0]!.note).toBe("sent back: nothing read yet");
    expect(provider.requests[1]!.user).toContain(
      "you have not read any of the paper yet",
    );
    expect(reply.grounded).toBe(true);
  });

  it("hands back a quote that is not in the paper, and accepts the fixed one", async () => {
    const provider = new ScriptedProvider([
      step({ action: "read", section: "Replication" }),
      step({
        action: "answer",
        kind: "from-paper",
        answer: "Six.",
        quotes: ["Every segment is copied six times over three zones for durability"],
      }),
      step({ action: "answer", kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
    ]);
    const reply = await investigate(paper, "How many copies?", { provider, dense: null });
    expect(reply.steps.map((s) => s.note)).toContain("sent back: quotes not found");
    expect(provider.requests[2]!.user).toContain("not in the paper as written");
    expect(reply.citations).toHaveLength(1);
  });

  it("answers background without reading", async () => {
    const provider = new ScriptedProvider([
      step({ action: "answer", kind: "background", answer: "A quorum is a majority." }),
    ]);
    const reply = await investigate(paper, "What is a quorum?", {
      provider,
      dense: null,
    });
    expect(reply.kind).toBe("background");
    expect(reply.citations).toEqual([]);
    expect(reply.steps).toHaveLength(1);
  });

  it("allows only an answer on the last step, so it always ends", async () => {
    const provider = new ScriptedProvider([
      step({ action: "search", query: "recovery" }),
      step({ kind: "from-paper", answer: "Under ten seconds.", quotes: [] }),
    ]);
    const reply = await investigate(paper, "How fast is recovery?", {
      provider,
      dense: null,
      maxSteps: 2,
    });
    expect(provider.requests.map((r) => r.schemaName)).toEqual(["step", "answer"]);
    expect(provider.requests[1]!.user).toContain("This is your last step");
    expect(reply.answer).toBe("Under ten seconds.");
  });

  it("reports every step as it happens", async () => {
    const seen: AgentTrace[] = [];
    const provider = new ScriptedProvider([
      step({ action: "find", query: "ten seconds" }),
      step({ action: "read", section: "crash recovery" }),
      step({
        action: "answer",
        kind: "from-paper",
        answer: "Under ten seconds.",
        quotes: ["Recovery completes in under ten seconds"],
      }),
    ]);
    await investigate(paper, "How fast?", {
      provider,
      dense: null,
      onStep: (s) => seen.push(s),
    });
    expect(seen.map((s) => `${s.action}:${s.detail}`)).toEqual([
      "find:ten seconds",
      "read:3 Crash Recovery",
      "answer:",
    ]);
  });

  it("has a budget small enough to be firm", () => {
    expect(MAX_STEPS).toBeLessThanOrEqual(8);
  });
});

describe("askPaper", () => {
  it("investigates by default", async () => {
    const provider = new ScriptedProvider([
      step({ action: "read", section: "Replication" }),
      step({ action: "answer", kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
    ]);
    const reply = await askPaper(paper, "How many copies?", { provider });
    expect(reply.mode).toBe("agent");
    expect(reply.steps).toHaveLength(2);
  });

  it("falls back to one pass when the provider cannot hold the step schema", async () => {
    const provider: LLMProvider = {
      name: "open",
      model: "small",
      async generateStructured<T>(
        req: StructuredRequest<T>,
      ): Promise<StructuredResult<T>> {
        if (req.schemaName === "step") throw new Error("could not produce valid JSON");
        return {
          data: req.schema.parse({ kind: "from-paper", answer: "Six.", quotes: [QUOTE] }),
          usage: {},
          provider: "open",
          model: "small",
          retries: 0,
        };
      },
    };
    const reply = await askPaper(paper, "How many copies?", { provider });
    expect(reply.mode).toBe("single-pass");
    expect(reply.answer).toBe("Six.");
    expect(reply.steps).toEqual([]);
  });
});

describe("the agent's tools", () => {
  const tools = paperTools(paper, { dense: null });

  it("searches sections and shows the sentence that matched", async () => {
    const out = await tools.search("replicated availability zones");
    expect(out.observation).toContain('"2.1 Replication"');
    expect(out.observation).toContain("six ways");
  });

  it("says so when a search matches nothing", async () => {
    const out = await tools.search("photosynthesis chlorophyll");
    expect(out.note).toBe("no match");
  });

  it("finds an exact phrase with the sentence around it", () => {
    const out = tools.find("quorum of four");
    expect(out.observation).toContain('in "2.1 Replication"');
    expect(tools.find("quorum of five").note).toBe("not in the paper");
  });

  it("reads a section named loosely, without its numbering or case", () => {
    expect(tools.read("replication").heading).toBe("2.1 Replication");
    expect(tools.read("3 CRASH RECOVERY").heading).toBe("3 Crash Recovery");
  });

  it("lists the real sections when asked for one that does not exist", () => {
    const out = tools.read("Evaluation");
    expect(out.note).toBe("no such section");
    expect(out.observation).toContain('"2.1 Replication"');
  });

  it("continues a long section on the next read", () => {
    const long: PaperStructure = {
      ...paper,
      sections: [{ heading: "Design", content: "word ".repeat(3000) }],
    };
    const t = paperTools(long, { dense: null });
    const first = t.read("Design");
    expect(first.note).toBe("first part");
    expect(first.observation).toContain('read "Design" again to continue');
    expect(t.read("Design").note).toBe("continued");
  });

  it("gives the agent the outline, not the text", () => {
    const outline = paperOutline(paper);
    expect(outline).toContain("- 2.1 Replication");
    expect(outline).not.toContain("write quorum of four");
  });
});
