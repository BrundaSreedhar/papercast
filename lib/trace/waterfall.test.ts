/**
 * The renderer is pure — spans in, string out — so it is tested against real
 * spans captured from an in-memory exporter rather than hand-built objects.
 * That way the [seconds, nanoseconds] timestamps, the parent links, and the
 * attribute shapes are the ones OTel actually produces.
 */
import { describe, it, expect, afterEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { initTracing, shutdownTracing } from "./setup";
import { withSpan } from "./tracer";
import { renderWaterfall } from "./waterfall";
import {
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  PAPERCAST_COST_USD,
  PAPERCAST_SCHEMA,
} from "./attributes";

afterEach(async () => {
  await shutdownTracing();
});

/** Run `build` under tracing and hand back the spans it produced. */
async function capture(build: () => Promise<void>): Promise<ReadableSpan[]> {
  const memory = new InMemorySpanExporter();
  initTracing({ waterfall: false, processors: [new SimpleSpanProcessor(memory)] });
  await build();
  return memory.getFinishedSpans();
}

/** A leaf that looks like a model call. */
function leaf(schema: string, cost: number, cacheRead = 0) {
  return withSpan(
    "chat test-model",
    {
      [PAPERCAST_SCHEMA]: schema,
      [GEN_AI_USAGE_INPUT_TOKENS]: 1000,
      [GEN_AI_USAGE_OUTPUT_TOKENS]: 100,
      [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: cacheRead,
      [PAPERCAST_COST_USD]: cost,
    },
    async () => {},
  );
}

describe("renderWaterfall", () => {
  it("returns nothing for an empty trace", () => {
    expect(renderWaterfall([])).toBe("");
  });

  it("draws the tree with box characters and indents by depth", async () => {
    const spans = await capture(async () => {
      await withSpan("root", {}, async () => {
        await withSpan("branch", {}, async () => {
          await leaf("claims", 0.02);
          await leaf("verdicts", 0.03);
        });
      });
    });

    const out = renderWaterfall(spans);
    expect(out).toContain("root");
    expect(out).toContain("└─ branch");
    // The two leaves sit one level deeper than the branch.
    expect(out).toMatch(/ {3}├─ chat test-model {2}claims/);
    expect(out).toMatch(/ {3}└─ chat test-model {2}verdicts/);
  });

  it("sums tokens and cost over each subtree", async () => {
    const spans = await capture(async () => {
      await withSpan("root", {}, async () => {
        await withSpan("branch", {}, async () => {
          await leaf("claims", 0.02);
          await leaf("verdicts", 0.03);
        });
      });
    });

    const line = (name: string) =>
      renderWaterfall(spans)
        .split("\n")
        .find((l) => l.includes(name))!;

    // Each leaf reports its own; the branch and root report the total beneath.
    expect(line("claims")).toContain("$0.020");
    expect(line("branch")).toContain("$0.050");
    expect(line("root")).toContain("$0.050");
    expect(line("branch")).toContain("2,000 in → 200 out");
  });

  it("shows cache reads, which is how caching becomes visible at all", async () => {
    const spans = await capture(async () => {
      await withSpan("root", {}, () => leaf("verdicts", 0.04, 14_208));
    });
    expect(renderWaterfall(spans)).toContain("14,208 cached");
  });

  it("omits the money column for a model with no price", async () => {
    const spans = await capture(async () => {
      await withSpan("root", {}, () => leaf("claims", 0));
    });
    // A local model is free; a "$0.000" column would imply it was measured.
    expect(renderWaterfall(spans)).not.toContain("$");
  });

  it("marks a failed span with its error type", async () => {
    const spans = await capture(async () => {
      await withSpan("root", {}, async () => {
        await expect(
          withSpan("doomed", {}, async () => {
            throw new TypeError("nope");
          }),
        ).rejects.toThrow("nope");
      });
    });

    const out = renderWaterfall(spans);
    expect(out).toContain("✗ TypeError");
  });

  it("renders a span whose parent is absent as its own root", async () => {
    // Happens for real: the web app starts a job without awaiting it, so the
    // request span that fathered it can be gone by the time we render.
    const spans = await capture(async () => {
      await withSpan("parent", {}, () => leaf("claims", 0.01));
    });
    const orphan = spans.filter((s) => s.name === "chat test-model");

    const out = renderWaterfall(orphan);
    expect(out).toContain("chat test-model");
    // Rendered flush left rather than dangling off a branch that is not there.
    expect(out).not.toContain("└─");
  });

  it("never contains prompt text, because spans never carried it", async () => {
    const spans = await capture(async () => {
      await withSpan("root", { [PAPERCAST_SCHEMA]: "verdicts" }, () =>
        leaf("verdicts", 0.01),
      );
    });
    expect(renderWaterfall(spans)).not.toMatch(/SECRET|paper text/i);
  });
});
