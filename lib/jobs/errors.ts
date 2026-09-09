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
