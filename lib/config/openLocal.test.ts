/**
 * `LLM_PROVIDER=open` used to imply a model on localhost, and two behaviours
 * were built on that: warming the model on every page view, and retrieving
 * sections instead of sending the whole paper. Pointed at a hosted endpoint
 * the first one spends real money on readers who never ask anything, so what
 * decides is the endpoint rather than the provider's name. These tests are
 * that distinction.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openModelIsLocal } from "./env";

const ORIGINAL = process.env.OPEN_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPEN_BASE_URL;
  else process.env.OPEN_BASE_URL = ORIGINAL;
});

const at = (url: string | undefined) => {
  if (url === undefined) delete process.env.OPEN_BASE_URL;
  else process.env.OPEN_BASE_URL = url;
  return openModelIsLocal();
};

describe("openModelIsLocal", () => {
  it("is true for the Ollama default, which is what the setting used to mean", () => {
    expect(at(undefined)).toBe(true);
    expect(at("http://localhost:11434/v1")).toBe(true);
  });

  it("is true for the other ways of naming this machine", () => {
    expect(at("http://127.0.0.1:11434/v1")).toBe(true);
    expect(at("http://[::1]:11434/v1")).toBe(true);
    expect(at("http://ollama.localhost:11434/v1")).toBe(true);
    expect(at("http://box.local:1234/v1")).toBe(true);
  });

  it("is false for the hosted endpoints someone might point it at", () => {
    // Each of these bills per token, so warming on every page view is money.
    expect(at("https://router.huggingface.co/v1")).toBe(false);
    expect(at("https://api.groq.com/openai/v1")).toBe(false);
    expect(at("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("refuses to guess when the URL does not parse", () => {
    // Spending is the cost of being wrong here, so an unreadable setting is
    // treated as remote rather than assumed to be safe.
    expect(at("not a url")).toBe(false);
    expect(at("")).toBe(true); // empty falls back to the localhost default
  });

  it("is not fooled by a hostname that merely mentions localhost", () => {
    expect(at("https://localhost.attacker.example/v1")).toBe(false);
    expect(at("https://notlocalhost/v1")).toBe(false);
  });
});
