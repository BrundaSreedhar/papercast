/**
 * The detailed log. What matters is that a line is parseable JSON carrying the
 * attributes intact, that a failure is legible without knowing OTel's status
 * codes, and that a sink which throws cannot take down the run it describes.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { DetailProcessor, formatDetail } from "./detail";

function span(over: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "speak turn 0",
    startTime: [1_760_000_000, 0],
    duration: [0, 12_500_000],
    attributes: {
      "papercast.tts.turn": 0,
      "papercast.tts.text": "Welcome to PaperCast.",
      "langsmith.span.tags": "tts,gemini,host",
    },
    status: { code: 1 },
    events: [],
    spanContext: () => ({
      traceId: "t".repeat(32),
      spanId: "s".repeat(16),
      traceFlags: 1,
    }),
    parentSpanContext: { spanId: "p".repeat(16) },
    ...over,
  } as unknown as ReadableSpan;
}

describe("formatDetail", () => {
  it("writes one parseable JSON object with the attributes intact", () => {
    const got = JSON.parse(formatDetail(span()));
    expect(got.name).toBe("speak turn 0");
    expect(got.durationMs).toBe(12.5);
    expect(got.attributes["papercast.tts.text"]).toBe("Welcome to PaperCast.");
    // The whole point of JSONL: one line, so `jq` can stream it.
    expect(formatDetail(span())).not.toContain("\n");
  });

  it("keeps the ids that let a run be reassembled", () => {
    const got = JSON.parse(formatDetail(span()));
    expect(got.traceId).toHaveLength(32);
    expect(got.spanId).toHaveLength(16);
    expect(got.parentSpanId).toHaveLength(16);
  });

  it("says 'error' rather than making a reader know that 2 means error", () => {
    const got = JSON.parse(
      formatDetail(span({ status: { code: 2, message: "high demand" } })),
    );
    expect(got.status).toBe("error");
    expect(got.error).toBe("high demand");
  });

  it("leaves events out when there are none, instead of an empty array", () => {
    expect(JSON.parse(formatDetail(span()))).not.toHaveProperty("events");
  });
});

describe("DetailProcessor", () => {
  it("writes a line per finished span", () => {
    const lines: string[] = [];
    new DetailProcessor((l) => lines.push(l)).onEnd(span());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).name).toBe("speak turn 0");
  });

  it("survives a sink that throws", () => {
    // A log that cannot be written is a lost record, not a failed episode.
    const bad = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(() => new DetailProcessor(bad).onEnd(span())).not.toThrow();
    expect(bad).toHaveBeenCalled();
  });

  it("records every span, leaving the filtering to whoever reads it", () => {
    const lines: string[] = [];
    const p = new DetailProcessor((l) => lines.push(l));
    p.onEnd(span({ name: "chat claude-sonnet-5" }));
    p.onEnd(span({ name: "GET /api/jobs" }));
    expect(lines).toHaveLength(2);
  });
});
