/**
 * The line a developer reads beside a running server. It has to say which model
 * was called and what it cost without becoming a second copy of the span.
 */
import { describe, it, expect } from "vitest";
import { formatSpan } from "./log";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";

const span = (over: Partial<ReadableSpan> = {}): ReadableSpan =>
  ({
    name: "chat qwen2:7b",
    duration: [1, 500_000_000],
    attributes: {},
    status: { code: 0 },
    instrumentationScope: { name: "paper-to-podcast" },
    ...over,
  }) as unknown as ReadableSpan;

describe("formatSpan", () => {
  it("says what was called and how long it took", () => {
    const line = formatSpan(span());
    expect(line).toContain("chat qwen2:7b");
    expect(line).toContain("1.5s");
  });

  it("reports tokens in and out", () => {
    const line = formatSpan(
      span({
        attributes: {
          "gen_ai.response.model": "claude-sonnet-5",
          "gen_ai.usage.input_tokens": 14882,
          "gen_ai.usage.output_tokens": 980,
        },
      }),
    );
    expect(line).toContain("14882 in → 980 out");
  });

  it("names the cached share, which is the number that pays for caching", () => {
    const line = formatSpan(
      span({
        attributes: {
          "gen_ai.usage.input_tokens": 14882,
          "gen_ai.usage.output_tokens": 980,
          "gen_ai.usage.cache_read.input_tokens": 14208,
        },
      }),
    );
    expect(line).toContain("14208 cached");
  });

  it("does not print the model twice when the span name already has it", () => {
    const line = formatSpan(
      span({ name: "chat qwen2:7b", attributes: { "gen_ai.request.model": "qwen2:7b" } }),
    );
    expect(line.match(/qwen2:7b/g)).toHaveLength(1);
  });

  it("prints the model when the span name does not carry it", () => {
    const line = formatSpan(
      span({
        name: "transcribe",
        attributes: { "gen_ai.request.model": "ggml-small.en.bin" },
      }),
    );
    expect(line).toContain("ggml-small.en.bin");
  });

  it("shows milliseconds for something quick", () => {
    expect(formatSpan(span({ duration: [0, 2_000_000] }))).toContain("2ms");
  });

  it("marks a failure, so a red line is not just a slow one", () => {
    const line = formatSpan(
      span({ status: { code: 2, message: "429 rate limit" } } as Partial<ReadableSpan>),
    );
    expect(line).toContain("FAILED");
    expect(line).toContain("429 rate limit");
  });
});
