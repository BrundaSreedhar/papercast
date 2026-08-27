/**
 * Span attribute names, in one place.
 *
 * The GenAI semantic conventions moved out of the main semconv repo into
 * `open-telemetry/semantic-conventions-genai`, and no npm constants package has
 * been published for the new home yet. The consequence is awkward but worth
 * understanding rather than working around blindly:
 *
 *   - Every `ATTR_GEN_AI_*` constant in `@opentelemetry/semantic-conventions`
 *     is marked `@deprecated` — not because the attribute is wrong, but because
 *     it moved repositories with no replacement published.
 *   - One of them is now stale against the spec: the package still exports
 *     `gen_ai.usage.cache_creation.input_tokens`, which the spec renamed to
 *     `gen_ai.usage.cache_write.input_tokens`. That is one of the four fields
 *     `Usage` actually carries, so the difference is not academic.
 *
 * So the `gen_ai.*` names are local string constants here, and a future rename
 * is a one-file edit. The genuinely *stable* attributes — the ones a backend
 * needs to render a usable trace at all — are still imported from the package,
 * because those are not going to move.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * Everything `gen_ai.*` is Development status and may yet be renamed.
 */
export {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_ERROR_TYPE,
} from "@opentelemetry/semantic-conventions";

/* ── GenAI: required ───────────────────────────────────────────────────── */

/** Closed enum: chat · invoke_agent · invoke_workflow · execute_tool · … */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
/**
 * Superseded by `gen_ai.provider.name`, emitted alongside it anyway. Several
 * LLM-native backends still key their views off the old name, and a duplicated
 * string costs nothing next to being unreadable in the tool you happen to use.
 */
export const GEN_AI_SYSTEM = "gen_ai.system";

/* ── GenAI: request ────────────────────────────────────────────────────── */

export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const GEN_AI_OUTPUT_TYPE = "gen_ai.output.type";
/** "The name of the prompt that uniquely identifies it" — our schema name. */
export const GEN_AI_PROMPT_NAME = "gen_ai.prompt.name";

/* ── GenAI: response and usage ─────────────────────────────────────────── */

export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";
/** Spec name. The npm package still exports the older `cache_creation` form. */
export const GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS =
  "gen_ai.usage.cache_write.input_tokens";

/* ── GenAI: agent and workflow ─────────────────────────────────────────── */

export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_WORKFLOW_NAME = "gen_ai.workflow.name";

/* ── GenAI: content, captured only when opted in ───────────────────────── */

export const GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions";
export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";

/* ── Ours ──────────────────────────────────────────────────────────────── */

/**
 * Anything the spec does not cover lives under `papercast.*`, so a custom
 * attribute is never mistaken for a standard one.
 */
export const PAPERCAST_SCHEMA = "papercast.schema";
export const PAPERCAST_TASK = "papercast.task";
export const PAPERCAST_COST_USD = "papercast.cost.usd";
/** Provider-internal schema-validation retries, on the logical call span. */
export const PAPERCAST_VALIDATION_RETRIES = "papercast.validation_retries";
/** 1-based index of one attempt within a provider's retry loop. */
export const PAPERCAST_ATTEMPT = "papercast.attempt";
/**
 * Why an attempt was rejected — a short Zod or parse summary, never content, so
 * it is recorded unconditionally. This is the field that says *what was wrong*
 * rather than merely that something was.
 */
export const PAPERCAST_VALIDATION_ERROR = "papercast.validation_error";
/**
 * What the model actually sent back on a failed attempt, truncated.
 *
 * Payload-gated, because it is model output. It is also the single most useful
 * thing to have when a small model fails structured output: a schema echoed
 * back, prose where JSON was asked for, a half-finished object.
 */
export const PAPERCAST_RAW_RESPONSE = "papercast.raw_response";
/**
 * Size of the reusable prefix, recorded always. This is how you tell the paper
 * is being resent on every judge call without writing the paper onto a span —
 * and, next to the cache-read token count, how you tell caching is working.
 */
export const PAPERCAST_CONTEXT_CHARS = "papercast.context_chars";
export const PAPERCAST_USER_CHARS = "papercast.user_chars";
export const PAPERCAST_JOB_ID = "papercast.job_id";
export const PAPERCAST_ROUND = "papercast.round";
export const PAPERCAST_FAILURES_IN = "papercast.failures_in";
export const PAPERCAST_MINUTES = "papercast.minutes";
export const PAPERCAST_REVISE = "papercast.revise";
export const PAPERCAST_VERIFY = "papercast.verify";
export const PAPERCAST_MAX_ROUNDS = "papercast.max_rounds";
export const PAPERCAST_IMAGE_BYTES = "papercast.image_bytes";
export const PAPERCAST_CAPTION_COUNT = "papercast.caption_count";

/**
 * Map a provider name onto the spec's `gen_ai.provider.name` enum.
 *
 * Our "open" provider is any OpenAI-compatible endpoint — Ollama, Together,
 * Groq, OpenRouter. The enum has no member for "some OpenAI-compatible server",
 * and `openai` is the closest honest answer: it describes the wire protocol,
 * which is what the attribute is actually for. The real model is on
 * `gen_ai.request.model`, and `papercast.schema` distinguishes our call sites.
 */
export function providerName(name: string): string {
  return name === "open" ? "openai" : name;
}
