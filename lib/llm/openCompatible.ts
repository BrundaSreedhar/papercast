import OpenAI from "openai";
import { ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { openConfig, type ProviderName } from "../config/env";
import { assertNoSilentTruncation } from "./contextGuard";
import { partialString } from "./partial";
import { joinCacheableContext } from "./promptParts";
import type { LLMProvider, StructuredRequest, StructuredResult, Usage } from "./types";
import { capturePayloads, truncate, withSpanFor } from "../trace/tracer";
import {
  PAPERCAST_ATTEMPT,
  PAPERCAST_RAW_RESPONSE,
  PAPERCAST_VALIDATION_ERROR,
} from "../trace/attributes";

const MAX_RETRIES = 3;

/** Result of one pass through the retry loop. */
type Attempt<T> = { ok: true; data: T } | { ok: false; error: unknown; content: string };

/**
 * Adapter for any OpenAI-compatible endpoint — a hosted OSS tier (Together,
 * Groq, OpenRouter) or a local runtime (Ollama). This is where the provider
 * abstraction earns its keep: open models frequently lack reliable tool-use or
 * strict json_schema, so we (1) ask for JSON mode when available, (2) embed the
 * schema in the prompt, and (3) validate against Zod, re-asking with the error
 * on failure. That coercion + validation-retry loop is what makes an open model
 * a first-class citizen next to Claude and GPT.
 */
/** Everything this adapter needs to talk to an endpoint. */
export interface OpenCompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export class OpenCompatibleProvider implements LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  private client: OpenAI;

  /**
   * Defaults to the self-hosted `open` endpoint. Anything else that speaks the
   * OpenAI protocol — Gemini's compatibility layer, Together, Groq — passes its
   * own name and config and reuses every line below it.
   */
  constructor(name: ProviderName = "open", cfg: OpenCompatibleConfig = openConfig()) {
    this.name = name;
    // The SDK retries 429s and 5xx on its own; the default of two attempts is
    // thin for endpoints that fail under load. A job here is minutes of work
    // and a real bill, so losing it to one bad minute at the provider is a
    // worse trade than waiting a few more seconds.
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 4 });
    this.model = cfg.model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const jsonSchema = zodToJsonSchema(req.schema, { $refStrategy: "none" }) as Record<
      string,
      unknown
    >;
    delete jsonSchema.$schema;

    const system = `${req.system}

Respond with a SINGLE JSON object and nothing else — no commentary, no markdown code fences. It must conform exactly to this JSON Schema:
${JSON.stringify(jsonSchema)}`;

    const userContent = joinCacheableContext(req.cacheableContext, req.user);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Each attempt is its own span. A count alone tells you a call retried;
      // it cannot tell you *why*, and "why" here is usually visible only in
      // what the model actually sent back.
      const outcome = await withSpanFor(
        `attempt ${attempt + 1}`,
        { [PAPERCAST_ATTEMPT]: attempt + 1 },
        async (span): Promise<Attempt<T>> => {
          const completion = await this.chat(messages, req);
          const content = completion.choices[0]?.message?.content ?? "";

          // Verify the server actually ingested the prompt before trusting
          // anything it says. Checked on the first attempt, when `messages` is
          // exactly what we composed; retries append correction turns and only
          // grow from here.
          if (attempt === 0) {
            assertNoSilentTruncation({
              sentText: system + userContent,
              processedTokens: completion.usage?.prompt_tokens,
              model: this.model,
            });
          }

          usage.inputTokens =
            (usage.inputTokens ?? 0) + (completion.usage?.prompt_tokens ?? 0);
          usage.outputTokens =
            (usage.outputTokens ?? 0) + (completion.usage?.completion_tokens ?? 0);

          try {
            const data = req.schema.parse(extractJson(content));
            return { ok: true, data };
          } catch (err) {
            // The error summary is short and carries no content, so it is
            // always recorded. The response itself is model output, so it
            // follows the payload flag like every other prompt or completion.
            span.setAttribute(PAPERCAST_VALIDATION_ERROR, describeError(err));
            if (capturePayloads()) {
              span.setAttribute(PAPERCAST_RAW_RESPONSE, truncate(content));
            }
            return { ok: false, error: err, content };
          }
        },
      );

      if (outcome.ok) {
        return {
          data: outcome.data,
          usage,
          provider: this.name,
          model: this.model,
          retries: attempt,
        };
      }

      lastError = outcome.error;
      // Feed the failure back so the model can self-correct.
      messages.push({ role: "assistant", content: outcome.content });
      messages.push({
        role: "user",
        content: correctionFor(outcome.error, outcome.content),
      });
    }

    throw new Error(
      `Open model produced no valid structured output after ${MAX_RETRIES + 1} attempts. Last error: ${describeError(lastError)}`,
    );
  }

  /** Request JSON mode; fall back to a plain call if the endpoint rejects it. */
  private async chat<T>(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    req: StructuredRequest<T>,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.4,
    };
    if (req.stream) return this.streamed(body, req.stream);
    try {
      return await this.client.chat.completions.create({
        ...body,
        response_format: { type: "json_object" },
      });
    } catch {
      // Some endpoints/models don't support response_format — degrade gracefully.
      return await this.client.chat.completions.create(body);
    }
  }

  /**
   * The same call, read as it arrives, reporting one field's prose as it grows.
   *
   * The result is assembled into the shape a non-streaming call returns, so
   * everything downstream — validation, the retry that feeds a parse error
   * back, usage accounting — is the code that already existed. Streaming
   * changes when the caller hears about the text, not what is finally checked.
   */
  private async streamed(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    stream: NonNullable<StructuredRequest<unknown>["stream"]>,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const completion = await this.client.chat.completions.create({
      ...body,
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true },
    });

    let content = "";
    let shown = "";
    let usage: OpenAI.CompletionUsage | undefined;
    let finish: string | null = null;

    for await (const chunk of completion) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (!delta) continue;
      content += delta;

      // Only report when the visible text actually grew: most chunks land
      // inside the JSON scaffolding around the field and change nothing.
      const soFar = partialString(content, stream.field);
      if (soFar !== undefined && soFar !== shown) {
        shown = soFar;
        stream.onText(soFar);
      }
    }

    return {
      id: "streamed",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, refusal: null },
          finish_reason: (finish ?? "stop") as "stop",
          logprobs: null,
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }
}

/** Pull a JSON object out of a model response that may wrap it in prose/fences. */
export function extractJson(text: string): unknown {
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    t = fence[1].trim();
  } else if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
  }

  return JSON.parse(t);
}

/**
 * Does this response look like the JSON Schema rather than data matching it?
 *
 * A real failure mode, not a hypothetical: the schema is embedded in the prompt,
 * and smaller models copy the nearest structured thing instead of instantiating
 * it. Observed reproducibly with qwen2:7b on claim extraction, where every
 * retry repeated the same echo because the generic "conform to the schema"
 * correction reads as agreement to a model that thinks it already did.
 */
export function looksLikeSchemaEcho(content: string): boolean {
  try {
    const parsed = extractJson(content);
    if (typeof parsed !== "object" || parsed === null) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return (
      (parsed as Record<string, unknown>).type === "object" &&
      (keys.includes("properties") || keys.includes("required"))
    );
  } catch {
    return false;
  }
}

/** The correction sent back after a failed attempt. */
export function correctionFor(err: unknown, content: string): string {
  if (looksLikeSchemaEcho(content)) {
    // Naming the mistake is the whole point. Telling a model that echoed the
    // schema to "conform to the schema" is heard as confirmation.
    return (
      `You replied with the JSON Schema itself. The schema describes the shape of the answer; it is not the answer.\n\n` +
      `Do not output "type", "properties", "required", or "additionalProperties". ` +
      `Output a JSON object whose keys are the property names the schema defines, filled in with real values taken from the text above.\n\n` +
      `Reply with ONLY that object.`
    );
  }
  return `That response was not valid: ${describeError(err)}. Reply again with ONLY a JSON object of DATA conforming to the schema — the filled-in values, not the schema definition, and no other text.`;
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  if (err instanceof SyntaxError) return `invalid JSON (${err.message})`;
  return err instanceof Error ? err.message : String(err);
}
