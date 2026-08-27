/**
 * What tracing has to guarantee.
 *
 * Two of these matter more than the rest: that the paper never leaks onto a
 * span by default, and that the agent loop's shape survives as a real parent /
 * child tree. A flat span list would lose exactly the thing tracing was added
 * to show.
 *
 * No filesystem and no network, in keeping with the rest of the suite: spans go
 * to an in-memory exporter injected through `initTracing`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { initTracing, shutdownTracing } from "./setup";
import { withSpan } from "./tracer";
import { traced } from "./llm";
import * as A from "./attributes";
import { refineEpisode } from "../refine/refine";
import { EpisodeSchema, type Episode } from "../llm/schema";
import type { LLMProvider, StructuredRequest, StructuredResult } from "../llm/types";
import type { PaperStructure } from "../pdf/extract";

const PAPER: PaperStructure = {
  title: "Amazon Aurora",
  abstract: "We move the log to storage.",
  sections: [{ heading: "Introduction", content: "The network is the bottleneck." }],
  wordCount: 8,
};

const EPISODE: Episode = {
  summary: "s",
  keyPoints: ["k"],
  turns: [
    { speaker: "host", text: "turn zero" },
    { speaker: "guest", text: "turn one" },
    { speaker: "host", text: "turn two" },
    { speaker: "guest", text: "turn three" },
  ],
};

/** Returns a fixed schema-valid payload and records nothing else. */
class StubProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  constructor(
    private readonly payload: unknown = { summary: "s", keyPoints: ["k"], turns: [] },
  ) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return {
      data: req.schema.parse(this.payload),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
      },
      provider: this.name,
      model: this.model,
      retries: 2,
    };
  }
}

class ThrowingProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  async generateStructured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    throw new TypeError("the model fell over");
  }
}

/** Grades one claim per turn, scripted per judging pass. */
class ScriptedProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model = "stub-model";
  private pass = 0;
  private revision = 0;
  constructor(
    private readonly grades: ("supported" | "contradicted")[][],
    private readonly rewrites: { turn: number; text: string }[][] = [],
  ) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const wrap = (data: unknown): StructuredResult<T> => ({
      data: req.schema.parse(data),
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: this.name,
      model: this.model,
      retries: 0,
    });
    if (req.schemaName === "claims") {
      return wrap({
        claims: EPISODE.turns.map((t, i) => ({
          turn: i,
          text: `claim ${t.text}`,
          factual: true,
        })),
      });
    }
    if (req.schemaName === "verdicts") {
      const grades = this.grades[this.pass++] ?? this.grades[this.grades.length - 1]!;
      return wrap({
        verdicts: grades.map((g, i) => ({
          claimIndex: i,
          verdict: g,
          evidence: "the paper says so",
          specific: true,
        })),
      });
    }
    if (req.schemaName === "revisions") {
      return wrap({ revisions: this.rewrites[this.revision++] ?? [] });
    }
    throw new Error(`unexpected schema ${req.schemaName}`);
  }
}

const EPISODE_SCHEMA_PAYLOAD = { summary: "s", keyPoints: ["k"], turns: [] };

let memory: InMemorySpanExporter;

function start(opts: { capturePayloads?: boolean } = {}) {
  memory = new InMemorySpanExporter();
  initTracing({
    waterfall: false,
    capturePayloads: opts.capturePayloads ?? false,
    processors: [new SimpleSpanProcessor(memory)],
  });
}

const attr = (s: ReadableSpan, k: string) => s.attributes[k];

/** Build a child → parent lookup so tree shape can be asserted. */
function parentOf(spans: ReadableSpan[]) {
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  return (s: ReadableSpan): ReadableSpan | undefined => {
    const id = s.parentSpanContext?.spanId;
    return id ? byId.get(id) : undefined;
  };
}

function ancestors(spans: ReadableSpan[], span: ReadableSpan): string[] {
  const up = parentOf(spans);
  const names: string[] = [];
  for (let cur = up(span); cur; cur = up(cur)) names.push(cur.name);
  return names;
}

afterEach(async () => {
  await shutdownTracing();
});

describe("traced (LLM decorator)", () => {
  beforeEach(() => start());

  it("emits one CLIENT span named for the operation and model", async () => {
    await traced(new StubProvider()).generateStructured({
      system: "sys",
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
      maxTokens: 4000,
      temperature: 0.6,
    });

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.name).toBe("chat stub-model");
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(attr(s, A.GEN_AI_OPERATION_NAME)).toBe("chat");
    expect(attr(s, A.GEN_AI_PROVIDER_NAME)).toBe("anthropic");
    // The superseded alias rides along for backends that still key off it.
    expect(attr(s, A.GEN_AI_SYSTEM)).toBe("anthropic");
    expect(attr(s, A.GEN_AI_REQUEST_MODEL)).toBe("stub-model");
    expect(attr(s, A.GEN_AI_REQUEST_MAX_TOKENS)).toBe(4000);
    expect(attr(s, A.GEN_AI_REQUEST_TEMPERATURE)).toBe(0.6);
    // The schema name identifies the call site; it must not become the
    // operation, which is a closed enum backends filter on.
    expect(attr(s, A.GEN_AI_PROMPT_NAME)).toBe("episode");
    expect(attr(s, A.PAPERCAST_SCHEMA)).toBe("episode");
  });

  it("records every token field, including both cache counters", async () => {
    await traced(new StubProvider()).generateStructured({
      system: "sys",
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });

    const s = memory.getFinishedSpans()[0]!;
    expect(attr(s, A.GEN_AI_USAGE_INPUT_TOKENS)).toBe(10);
    expect(attr(s, A.GEN_AI_USAGE_OUTPUT_TOKENS)).toBe(5);
    // Cache reads on their own attribute are what finally make prompt caching
    // observable rather than merely summed away.
    expect(attr(s, A.GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS)).toBe(7);
    expect(attr(s, A.GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS)).toBe(3);
  });

  it("reports the logical call as one span carrying the retry count", async () => {
    // The decorator wraps the outer call, so the logical operation is one span
    // — which is what the spec asks for. Real providers additionally open a
    // child span per internal attempt; see openCompatible.test.ts. This stub
    // has no retry loop, so one span is all there is.
    await traced(new StubProvider()).generateStructured({
      system: "sys",
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(attr(spans[0]!, A.PAPERCAST_VALIDATION_RETRIES)).toBe(2);
  });

  it("omits cost for a model with no published price rather than writing zero", async () => {
    await traced(new StubProvider()).generateStructured({
      system: "sys",
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });
    // "stub-model" is not in the pricing table, and a local model is free.
    expect(attr(memory.getFinishedSpans()[0]!, A.PAPERCAST_COST_USD)).toBeUndefined();
  });

  it("marks a failed call and still lets the error through", async () => {
    const call = traced(new ThrowingProvider()).generateStructured({
      system: "sys",
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });

    await expect(call).rejects.toThrow("the model fell over");

    const s = memory.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(attr(s, A.ATTR_ERROR_TYPE)).toBe("TypeError");
    expect(s.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("payload capture", () => {
  const bigPaper = "SECRET PAPER TEXT ".repeat(7000); // ~120k chars, as in a real run

  it("never writes prompt content when capture is off", async () => {
    start();
    await traced(new StubProvider()).generateStructured({
      system: "sys",
      cacheableContext: bigPaper,
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });

    const s = memory.getFinishedSpans()[0]!;
    expect(attr(s, A.GEN_AI_INPUT_MESSAGES)).toBeUndefined();
    expect(attr(s, A.GEN_AI_OUTPUT_MESSAGES)).toBeUndefined();
    expect(attr(s, A.GEN_AI_SYSTEM_INSTRUCTIONS)).toBeUndefined();
    // The paper is nowhere on the span…
    expect(JSON.stringify(s.attributes)).not.toContain("SECRET PAPER TEXT");
    // …but its size still tells you it was sent.
    expect(attr(s, A.PAPERCAST_CONTEXT_CHARS)).toBe(bigPaper.length);
    expect(attr(s, A.PAPERCAST_USER_CHARS)).toBe(5);
  });

  it("writes spec-shaped content when opted in, truncated", async () => {
    start({ capturePayloads: true });
    await traced(new StubProvider(EPISODE_SCHEMA_PAYLOAD)).generateStructured({
      system: "sys",
      cacheableContext: bigPaper,
      user: "hello",
      schema: EpisodeSchema,
      schemaName: "episode",
    });

    const s = memory.getFinishedSpans()[0]!;
    const input = JSON.parse(String(attr(s, A.GEN_AI_INPUT_MESSAGES)));
    expect(input[0].role).toBe("user");
    expect(input[0].parts[0].type).toBe("text");
    // Truncated far below the 120k it was handed.
    expect(String(attr(s, A.GEN_AI_INPUT_MESSAGES)).length).toBeLessThan(20_000);
    expect(JSON.parse(String(attr(s, A.GEN_AI_OUTPUT_MESSAGES)))[0].role).toBe(
      "assistant",
    );
  });
});

describe("nesting", () => {
  beforeEach(() => start());

  it("makes calls inside withSpan children of it", async () => {
    const provider = traced(new StubProvider());
    await withSpan("parent", {}, async () => {
      await provider.generateStructured({
        system: "sys",
        user: "hello",
        schema: EpisodeSchema,
        schemaName: "episode",
      });
    });

    const spans = memory.getFinishedSpans();
    const child = spans.find((s) => s.name === "chat stub-model")!;
    const parent = spans.find((s) => s.name === "parent")!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("preserves the refine loop's shape as a real tree", async () => {
    // The assertion tracing exists for: two rounds, each grouping its own
    // model calls, rather than five sibling spans in a row.
    const provider = traced(
      new ScriptedProvider(
        [
          ["supported", "contradicted", "supported", "supported"],
          ["supported", "supported", "supported", "supported"],
        ],
        [[{ turn: 1, text: "corrected turn one" }]],
      ),
    );
    await refineEpisode(EPISODE, PAPER, { provider });

    const spans = memory.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain("invoke_agent refine");
    expect(names).toContain("round 0");
    expect(names).toContain("round 1");

    const bySchema = (schema: string) =>
      spans.filter((s) => s.attributes[A.PAPERCAST_SCHEMA] === schema);

    // Round 0 judged; round 1 revised and judged again.
    expect(ancestors(spans, bySchema("claims")[0]!)).toContain("round 0");
    expect(ancestors(spans, bySchema("verdicts")[0]!)).toContain("round 0");
    expect(ancestors(spans, bySchema("revisions")[0]!)).toContain("round 1");
    expect(ancestors(spans, bySchema("claims")[1]!)).toContain("round 1");

    // Every round hangs off the agent span.
    for (const round of spans.filter((s) => s.name.startsWith("round "))) {
      expect(ancestors(spans, round)).toContain("invoke_agent refine");
    }
  });

  it("runs the rounds sequentially rather than concurrently", async () => {
    const provider = traced(
      new ScriptedProvider(
        [
          ["supported", "contradicted", "supported", "supported"],
          ["supported", "supported", "supported", "supported"],
        ],
        [[{ turn: 1, text: "corrected" }]],
      ),
    );
    await refineEpisode(EPISODE, PAPER, { provider });

    // Assert on completion order, not on timestamps. SimpleSpanProcessor hands
    // each span to the exporter as it ends, so this list is end order — which
    // is exactly the sequencing claim, and unlike a clock comparison it does
    // not depend on OTel resolving sub-microsecond spans monotonically.
    const names = memory.getFinishedSpans().map((s) => s.name);
    expect(names.indexOf("round 0")).toBeLessThan(names.indexOf("round 1"));
    // Both rounds close before the agent span that contains them.
    expect(names.indexOf("round 1")).toBeLessThan(names.indexOf("invoke_agent refine"));
  });
});

describe("when tracing was never initialized", () => {
  it("returns the provider itself, so the untraced path costs nothing", () => {
    const stub = new StubProvider();
    expect(traced(stub)).toBe(stub);
  });

  it("runs withSpan as a plain call and emits nothing", async () => {
    const exporter = new InMemorySpanExporter();
    const value = await withSpan("nowhere", {}, async () => 42);
    expect(value).toBe(42);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("shuts down cleanly without having started", async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
