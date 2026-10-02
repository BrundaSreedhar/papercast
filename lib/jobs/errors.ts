/**
 * Turning internal failures into something a user can act on.
 *
 * A job's error reaches a browser, so it cannot be a stack trace or a raw
 * provider message — those leak internals, sometimes including request details,
 * and tell the reader nothing they can do. Each known failure is mapped to a
 * stable code, a plain description, and a remedy where one exists.
 */
import { ContextTruncationError } from "../llm/contextGuard";
import { OutputTruncationError } from "../llm/errors";
import type { JobError } from "./types";

export function toJobError(err: unknown): JobError {
  if (err instanceof ContextTruncationError) {
    return {
      code: "context_truncated",
      message:
        "The model received only part of the paper, so anything it produced would describe a document it never fully saw.",
      remedy:
        "Use a model with a larger context window, or raise the local server's limit.",
    };
  }

  if (err instanceof OutputTruncationError) {
    return {
      code: "output_truncated",
      message: "The model ran out of room while writing the episode.",
      remedy: "Request a shorter episode, or raise the output token budget.",
    };
  }

  const raw = err instanceof Error ? err.message : String(err);

  // An exhausted account is not an authentication failure and must not read as
  // one: the key is fine, the balance is not, and the fix is somewhere else
  // entirely. Found by deploying — the container's first real run failed here,
  // and "something went wrong" was all it said.
  if (/credit balance|insufficient[_ ]quota|billing|payment required|402/i.test(raw)) {
    return {
      code: "no_credit",
      message: "The account behind this provider has run out of credit.",
      remedy:
        "Top up the provider account, or run against a local model, which costs nothing.",
    };
  }

  // Credentials are the most common setup failure and the least useful raw.
  if (/api key|apikey|unauthorized|401|authentication/i.test(raw)) {
    return {
      code: "auth_failed",
      message: "The provider rejected the credentials.",
      remedy: "Check the API key for the selected provider in your environment.",
    };
  }
  if (/rate limit|429|quota/i.test(raw)) {
    return {
      code: "rate_limited",
      message: "The provider is rate limiting this account.",
      remedy: "Wait a moment and try again, or switch provider.",
    };
  }
  // A 5xx from a hosted provider is the provider having a bad minute, not a
  // fault in the request. Left unclassified it reads as "something went wrong",
  // which sends people hunting for a bug in their own pipeline. Seen constantly
  // against Gemini's endpoint, which 503s under load with an empty body.
  if (/\b50[0234]\b|service unavailable|overloaded|temporarily unavailable/i.test(raw)) {
    return {
      code: "provider_unavailable",
      message: "The model provider is temporarily unavailable.",
      remedy:
        "This is on their side, and the request was already retried. Wait a minute and try again, or switch to another provider.",
    };
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(raw)) {
    return {
      code: "provider_unreachable",
      message: "Could not reach the model provider.",
      remedy: "Check that the endpoint is running and reachable.",
    };
  }
  // Synthesis had no branch at all, so every voice failure — a missing Piper
  // binary, a voice model that was never downloaded, a backend that died
  // mid-chunk — arrived as "something went wrong" at the one stage where the
  // cause is almost always local setup and entirely fixable.
  if (/piper synthesis failed/i.test(raw)) {
    const missingVoice =
      /unable to find voice|no such file|cannot find|not found|ENOENT/i.test(raw);
    return {
      code: missingVoice ? "voice_missing" : "synthesis_failed",
      message: missingVoice
        ? "The speech synthesizer could not find its voice model."
        : "The speech synthesizer failed while recording a turn.",
      remedy: missingVoice
        ? "Check PIPER_BIN and the voice paths in PIPER_HOST_VOICE / PIPER_GUEST_VOICE, or unset TTS_PROVIDER to fall back to the built-in system voice."
        : "Try TTS_PROVIDER=say to use the built-in system voice, which needs no setup.",
    };
  }
  if (
    /different audio format|only uncompressed pcm|no audio to join|wave file has no|not a wave/i.test(
      raw,
    )
  ) {
    return {
      code: "audio_join_failed",
      message: "The recorded turns could not be joined into one episode.",
      remedy:
        "This happens when turns come back in different formats. Re-run with a single TTS provider set explicitly.",
    };
  }

  // Configuration that never arrived. On a hosted deployment this is the
  // first failure anyone hits — a variable not saved, named differently, or
  // saved after the container last started — and it reached the browser as
  // "something went wrong" because the variable's name has underscores and
  // the credential patterns above look for "api key". The name is not a
  // secret, and it is the one thing that makes this fixable.
  const missing = /Missing required environment variable: ([A-Z0-9_]+)/.exec(raw);
  if (missing) {
    return {
      code: "config_missing",
      message: `This deployment has no ${missing[1]} set, so it cannot reach a model.`,
      remedy:
        "Set it where the deployment keeps its configuration — on Hugging Face that is the Space's Settings, under Variables and secrets, with keys saved as secrets. The container restarts on its own once saved.",
    };
  }

  // The same class of failure, one step earlier: a provider name that is not
  // one of the four.
  const badProvider = /LLM_PROVIDER must be one of/.test(raw);
  if (badProvider) {
    return {
      code: "config_invalid",
      message: "This deployment's LLM_PROVIDER is not one of the providers it knows.",
      remedy: 'It must be exactly "anthropic", "openai", "gemini" or "open".',
    };
  }

  // A model that will not produce the JSON it was asked for is the open path's
  // most likely failure, and it had no branch: it arrived as "something went
  // wrong", with the detail in a server log that whoever deployed the thing
  // frequently cannot read. Reasoning models are the usual cause — they spend
  // the completion budget thinking and return nothing, or prose, where an
  // object was required.
  if (/produced no valid structured output/i.test(raw)) {
    return {
      code: "model_output_invalid",
      message: "The model did not return the episode in the shape that was asked for.",
      remedy:
        "Reasoning models often spend their whole output budget thinking and return nothing usable. Try a plain instruct model — on Groq, llama-3.3-70b-versatile rather than openai/gpt-oss-120b — or raise the output token budget.",
    };
  }

  // A mistyped model name reaches here as a 404 from the provider, which says
  // nothing about which of the several configured names was wrong.
  // A bare 404 belongs here too, and is the form this actually takes in the
  // wild: Google answers an unknown model with "404 status code (no body)",
  // which carries nothing to match on and so read as "something went wrong".
  // Model names are retired on the provider's schedule, not yours, so a
  // deployment that worked last month can start failing untouched.
  if (
    /model[_ ]?not[_ ]?found|does not exist|no such model|unknown model|\b404\b/i.test(
      raw,
    )
  ) {
    return {
      code: "model_unknown",
      message: "The provider has no model by that name.",
      remedy:
        "Check the model name against the provider's current list — ANTHROPIC_MODEL, OPENAI_MODEL, GEMINI_MODEL or OPEN_MODEL, depending on which is selected. Names are retired over time, so a name that worked before can stop. A 404 can also mean the base URL points at the wrong API.",
    };
  }

  if (/Could not extract text|no dialogue turns|not a riff|pdf/i.test(raw)) {
    return {
      code: "unreadable_input",
      message: "The uploaded file could not be read as a paper.",
      remedy: "Upload a text-based PDF rather than a scan or an image.",
    };
  }

  return {
    code: "internal",
    message: "Something went wrong while producing the episode.",
    // The detail stays in the server log rather than travelling to the client.
    // The caller attaches a reference so the two can be connected.
    remedy: "The server log holds the full error against this job's reference.",
  };
}
