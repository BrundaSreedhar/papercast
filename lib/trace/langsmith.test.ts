/**
 * LangSmith is reached over OTLP, so there is no client to test — what matters
 * is that a key turns the exporter on, that the older variable names still
 * work, and that its tag vocabulary comes out in the one shape its OTLP
 * mapping reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LANGSMITH_ENDPOINT,
  LANGSMITH_TAGS,
  langsmithConfig,
  langsmithExporterOptions,
  metadata,
  tags,
} from "./langsmith";

const KEYS = [
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_PROJECT",
  "LANGCHAIN_PROJECT",
  "LANGSMITH_ENDPOINT",
  "LANGCHAIN_ENDPOINT",
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING_V2",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("langsmithConfig", () => {
  it("stays off until a key exists, so nothing is exported by accident", () => {
    expect(langsmithConfig()).toBeUndefined();
  });

  it("turns on from a key alone, with a project anyone can find later", () => {
    process.env.LANGSMITH_API_KEY = "ls-abc";
    expect(langsmithConfig()).toEqual({
      apiKey: "ls-abc",
      project: "papercast",
      endpoint: LANGSMITH_ENDPOINT,
    });
  });

  it("accepts the older LANGCHAIN_ names, which existing .env files carry", () => {
    process.env.LANGCHAIN_API_KEY = "ls-old";
    process.env.LANGCHAIN_PROJECT = "legacy";
    expect(langsmithConfig()).toMatchObject({ apiKey: "ls-old", project: "legacy" });
  });

  it("can be switched off without removing the key", () => {
    // Someone who has a key set globally still needs a way to run without
    // shipping this particular run anywhere.
    process.env.LANGSMITH_API_KEY = "ls-abc";
    process.env.LANGSMITH_TRACING = "false";
    expect(langsmithConfig()).toBeUndefined();
    process.env.LANGSMITH_TRACING = "0";
    expect(langsmithConfig()).toBeUndefined();
  });

  it("honours a self-hosted endpoint", () => {
    process.env.LANGSMITH_API_KEY = "ls-abc";
    process.env.LANGSMITH_ENDPOINT = "https://langsmith.internal/otel";
    expect(langsmithConfig()?.endpoint).toBe("https://langsmith.internal/otel");
  });
});

describe("langsmithExporterOptions", () => {
  it("points at the traces path and carries the key and project as headers", () => {
    const got = langsmithExporterOptions({
      apiKey: "ls-abc",
      project: "papercast",
      endpoint: LANGSMITH_ENDPOINT,
    });
    expect(got.url).toBe("https://api.smith.langchain.com/otel/v1/traces");
    expect(got.headers["x-api-key"]).toBe("ls-abc");
    expect(got.headers["Langsmith-Project"]).toBe("papercast");
  });

  it("does not double the slash on an endpoint that ends with one", () => {
    const got = langsmithExporterOptions({
      apiKey: "k",
      project: "p",
      endpoint: "https://api.smith.langchain.com/otel/",
    });
    expect(got.url).toBe("https://api.smith.langchain.com/otel/v1/traces");
  });
});

describe("tags", () => {
  it("joins into the single comma-separated attribute the mapping reads", () => {
    expect(tags("episode", "solo", "open")).toEqual({
      [LANGSMITH_TAGS]: "episode,solo,open",
    });
  });

  it("drops the blanks, so a caller can pass an optional flag inline", () => {
    // Written for `input.revise && "revise"`, which is false on most runs.
    expect(tags("episode", undefined, false, "", "audio")).toEqual({
      [LANGSMITH_TAGS]: "episode,audio",
    });
  });

  it("sets nothing at all rather than an empty attribute", () => {
    expect(tags(undefined, false)).toEqual({});
  });
});

describe("metadata", () => {
  it("prefixes each key the way LangSmith expects", () => {
    expect(metadata({ job_id: "j1", minutes: 4 })).toEqual({
      "langsmith.metadata.job_id": "j1",
      "langsmith.metadata.minutes": 4,
    });
  });

  it("omits what it does not know, rather than writing an empty value", () => {
    expect(metadata({ paper_id: undefined, note: "" })).toEqual({});
  });
});
