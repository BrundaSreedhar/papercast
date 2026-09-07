/**
 * Layer 1: deterministic checks.
 *
 * Every failure this session was found by a human reading output — a fabricated
 * show name, a guest handed a doctorate, hosts speaking as the paper's authors,
 * a dialogue that silently collapsed to a third of its target length. Most of
 * those are decidable without a model, so they run here: free, instant, and on
 * every commit. The LLM judge is reserved for what genuinely needs judgement.
 */
import { EpisodeSchema } from "../llm/schema";
import { targetTurnCount } from "../llm/generateEpisode";
import { paperToText } from "../pdf/extract";
import type { CheckContext, CheckResult, DeterministicReport } from "./types";

const WORDS_PER_MINUTE = 150;
/** Episodes shorter than this fraction of target are treated as collapsed. */
const MIN_LENGTH_RATIO = 0.7;

function ok(id: string, label: string, severity: CheckResult["severity"]): CheckResult {
  return { id, label, passed: true, severity };
}

function fail(
  id: string,
  label: string,
  severity: CheckResult["severity"],
  detail: string,
): CheckResult {
  return { id, label, passed: false, severity, detail };
}

function dialogueText(ctx: CheckContext): string {
  return ctx.episode.turns.map((t) => t.text).join(" ");
}

function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) ?? []).length;
}

/**
 * Word-level index of the paper. Substring matching is too loose here — "Al"
 * would be found inside "Availability" and a fabricated name would slip past.
 */
/**
 * Every word the paper contains, for checking that a name traces back to it.
 *
 * The wrap hyphen has to go first. A PDF breaking "Zero-Downtime" across a
 * column edge stores it as "Zero-\nDowntime", and a check that reads the text
 * literally then reports a correctly grounded proper noun as invented — the
 * worst kind of failure in a harness whose job is telling real fabrication from
 * imagined, since it teaches you to distrust the checks.
 */
function paperWords(ctx: CheckContext): Set<string> {
  const set = new Set<string>();
  const raw = paperToText(ctx.paper).toLowerCase();
  const WRAP = /-[ \t]*\r?\n[ \t]*/g;
  // A hyphen at a line end is ambiguous: it is either the PDF breaking a word
  // ("proc-\nessing" → processing) or a real hyphen that happened to land there
  // ("zero-\ndowntime" → zero-downtime). Both readings are legitimate, and
  // guessing wrong reports a grounded name as invented, so both are admitted.
  for (const text of [raw, raw.replace(WRAP, ""), raw.replace(WRAP, "-")]) {
    for (const m of text.matchAll(/[a-z0-9'’-]+/g)) {
      set.add(m[0]);
      for (const part of m[0].split("-")) if (part) set.add(part);
    }
  }
  return set;
}

/**
 * Find the title-case phrase following each occurrence of an introductory
 * phrase. Done in two steps because the lead-in must match case-insensitively
 * while the name itself must stay case-sensitive — a single `i` flag would
 * make `[A-Z]` meaningless and match any word.
 */
function namesAfter(text: string, leadIn: RegExp, maxWords = 3): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(leadIn)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const name = rest.match(
      new RegExp(`^([A-Z][\\w'’-]*(?:\\s+[A-Z][\\w'’-]*){0,${maxWords}})`),
    );
    if (name?.[1]) found.push(name[1].trim());
  }
  return found;
}

/* ── individual checks ─────────────────────────────────────────────────── */

export function checkSchema(ctx: CheckContext): CheckResult {
  const id = "schema";
  const label = "Episode matches the schema";
  const parsed = EpisodeSchema.safeParse(ctx.episode);
  return parsed.success
    ? ok(id, label, "error")
    : fail(id, label, "error", parsed.error.issues.map((i) => i.message).join("; "));
}

/**
 * Which format an episode is in, read from the turns themselves.
 *
 * The format is not recorded on the episode, and deliberately so: a check that
 * trusted a declared format would pass an episode that claimed to be solo and
 * wasn't. Reading it from the speakers means the checks grade what is actually
 * there.
 */
export function episodeFormat(episode: CheckContext["episode"]): "dialogue" | "solo" {
  const turns = episode.turns;
  return turns.length > 0 && turns.every((t) => t.speaker === "narrator")
    ? "solo"
    : "dialogue";
}

/**
 * Speaker structure, which means two different things depending on the format.
 *
 * A two-voice episode must strictly alternate: the failure this was written to
 * catch is a dialogue collapsing into consecutive turns by one speaker, which
 * reads as a monologue wearing a conversation's clothes. A solo episode is
 * consecutive `narrator` turns by construction, so alternation cannot apply —
 * but the two must never be mixed, because a stray `host` line in a monologue
 * is a second voice nobody will synthesize.
 *
 * Distinguishing them by the speaker name rather than a flag is what keeps the
 * original check intact: a collapsed dialogue still says "host", so it still
 * fails, and only a deliberately solo episode takes the other branch.
 */
export function checkAlternation(ctx: CheckContext): CheckResult {
  const id = "alternation";
  const label = "Speakers are structured for the format";
  const turns = ctx.episode.turns;

  const narrated = turns.filter((t) => t.speaker === "narrator").length;
  if (narrated > 0) {
    return narrated === turns.length
      ? ok(id, label, "error")
      : fail(
          id,
          label,
          "error",
          `Mixed formats: ${narrated} of ${turns.length} turns are narrated and the rest are not.`,
        );
  }

  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.speaker === turns[i - 1]!.speaker) {
      return fail(id, label, "error", `Turns ${i - 1} and ${i} share a speaker.`);
    }
  }
  return ok(id, label, "error");
}

export function checkTurnCount(ctx: CheckContext): CheckResult {
  const id = "turn-count";
  const label = "Meets the turn floor for the format";
  // A monologue needs fewer, longer beats than a dialogue needs turns, so
  // grading a solo episode against the dialogue floor fails it for being
  // correctly paced.
  const target = targetTurnCount(ctx.minutes, episodeFormat(ctx.episode));
  const actual = ctx.episode.turns.length;
  return actual >= target
    ? ok(id, label, "warning")
    : fail(id, label, "warning", `${actual} turns, target at least ${target}.`);
}

export function checkWordCount(ctx: CheckContext): CheckResult {
  const id = "word-count";
  const label = "Reaches the spoken-length target";
  const target = ctx.minutes * WORDS_PER_MINUTE;
  const actual = wordCount(dialogueText(ctx));
  return actual >= target * MIN_LENGTH_RATIO
    ? ok(id, label, "warning")
    : fail(
        id,
        label,
        "warning",
        `${actual} words against a ${target}-word target (${Math.round((actual / target) * 100)}%).`,
      );
}

export function checkShowName(ctx: CheckContext): CheckResult {
  const id = "show-name";
  const label = "Uses only the configured show name";
  const text = dialogueText(ctx);
  // "Welcome to X", "welcome back to this episode of X", "listening to X" …
  const leadIn =
    /\b(?:welcome(?:\s+back)?\s+to|listening\s+to|here\s+on|this\s+is)\s+(?:(?:this|another|our|the)\s+)?(?:episode\s+of\s+)?/gi;
  const wrong = namesAfter(text, leadIn).filter(
    (named) => !named.toLowerCase().startsWith(ctx.showName.toLowerCase()),
  );
  return wrong.length === 0
    ? ok(id, label, "error")
    : fail(
        id,
        label,
        "error",
        `Invented show name(s): ${[...new Set(wrong)].join(", ")}. Expected "${ctx.showName}".`,
      );
}

export function checkNoHonorifics(ctx: CheckContext): CheckResult {
  const id = "honorifics";
  const label = "No fabricated credentials for the speakers";
  const text = dialogueText(ctx);
  const hits = [...text.matchAll(/\b(Dr\.|Prof\.|Professor|PhD|Ph\.D\.)\s*[A-Z]?/g)].map(
    (m) => m[0].trim(),
  );
  // An honorific attached to a name from the paper (a cited author) is fine;
  // one introducing a speaker is not. Flag any that the paper does not contain.
  const paper = paperToText(ctx.paper).toLowerCase();
  const invented = hits.filter((h) => !paper.includes(h.toLowerCase()));
  return invented.length === 0
    ? ok(id, label, "error")
    : fail(
        id,
        label,
        "error",
        `Honorifics absent from the paper: ${invented.join(", ")}.`,
      );
}

export function checkNoClaimedExpertise(ctx: CheckContext): CheckResult {
  const id = "claimed-expertise";
  const label = "Speakers are not described as experts";
  const text = dialogueText(ctx);
  const re = /\b(?:expert|specialist|authority|researcher)\s+(?:in|on)\s+[a-z]/gi;
  const hits = [...text.matchAll(re)].map((m) => m[0]);
  return hits.length === 0
    ? ok(id, label, "error")
    : fail(id, label, "error", `Claimed expertise: ${[...new Set(hits)].join("; ")}.`);
}

export function checkNoAuthorImpersonation(ctx: CheckContext): CheckResult {
  const id = "author-impersonation";
  const label = "Work is attributed to the authors, not the speakers";
  const text = dialogueText(ctx);
  const patterns = [
    /\bwe\s+(?:found|showed|built|designed|propose[d]?|developed|implemented|evaluated|introduce[d]?)\b/gi,
    /\bour\s+(?:approach|method|methods|experiments|system|paper|architecture|design|results|work|model)\b/gi,
    /\bin our\s+\w+/gi,
  ];
  const hits = patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
  return hits.length === 0
    ? ok(id, label, "error")
    : fail(
        id,
        label,
        "error",
        `Speakers claim the work as their own: ${[...new Set(hits)].slice(0, 5).join("; ")}.`,
      );
}

export function checkNoDirectAddress(ctx: CheckContext): CheckResult {
  const id = "no-names";
  const label = "Speakers are never named";
  const text = dialogueText(ctx);
  // A comma-delimited vocative: "Thanks, Sam" / "So, Alex, ...".
  const leadIn = /\b(?:thanks|thank you|so|well|right|okay|ok|yes|and|but|now)\s*,\s*/gi;
  const words = paperWords(ctx);
  const hits = namesAfter(text, leadIn, 0).filter(
    (name) => !words.has(name.toLowerCase()),
  );
  return hits.length === 0
    ? ok(id, label, "error")
    : fail(
        id,
        label,
        "error",
        `Speakers addressed by invented name(s): ${[...new Set(hits)].join(", ")}.`,
      );
}

/**
 * Capitalized words that never appear in the paper. A cheap proxy for
 * hallucinated entities: a real discussion of a paper should not introduce
 * proper nouns the paper itself never mentions.
 */
export function checkProperNouns(ctx: CheckContext): CheckResult {
  const id = "proper-nouns";
  const label = "Proper nouns trace back to the paper";
  const words = paperWords(ctx);
  const unknown = new Set<string>();

  for (const turn of ctx.episode.turns) {
    // Split into sentences so sentence-initial capitals can be skipped.
    for (const sentence of turn.text.split(/(?<=[.!?])\s+/)) {
      const tokens = sentence.trim().split(/\s+/);
      tokens.forEach((tok, i) => {
        if (i === 0) return; // sentence-initial capital carries no signal
        const word = tok.replace(/^[^\w]+|[^\w]+$/g, "");
        if (!/^[A-Z][a-zA-Z'’-]{2,}$/.test(word)) return;
        const lower = word.toLowerCase();
        if (PROPER_NOUN_ALLOWLIST.has(lower)) return;
        if (lower === ctx.showName.toLowerCase()) return;
        // Allow possessives and plurals of paper terms ("Aurora's", "quorums").
        const stem = lower.replace(/['’]s$|s$/, "");
        if (!words.has(lower) && !words.has(stem)) unknown.add(word);
      });
    }
  }

  return unknown.size === 0
    ? ok(id, label, "warning")
    : fail(
        id,
        label,
        "warning",
        `Not found in the paper: ${[...unknown].slice(0, 10).join(", ")}.`,
      );
}

/**
 * Numbers spoken in the dialogue that do not occur in the paper. Fabricated
 * figures are the most damaging kind of hallucination and the easiest to miss
 * when reading, since a confident number reads as authoritative.
 */
export function checkNumbers(ctx: CheckContext): CheckResult {
  const id = "numbers";
  const label = "Numeric claims trace back to the paper";
  // Loose extraction on the paper side so figures welded to units ("10GB",
  // "35x") still register as present.
  const paperNums = [...paperToText(ctx.paper).matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  const paperSet = new Set(paperNums);
  const unknown = new Set<string>();

  for (const turn of ctx.episode.turns) {
    for (const m of turn.text.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
      const raw = m[0].replace(/,/g, "");
      const value = Number(raw);
      // Small integers are usually ordinal prose ("two things"), not data.
      if (!Number.isFinite(value) || value <= 3) continue;
      if (paperSet.has(value)) continue;
      // Spoken summaries round, and rounding is honest paraphrase rather than
      // fabrication: the paper's "5.38 milliseconds" becomes "about 5.4".
      // Accept any paper figure that rounds to the spoken one at its own
      // stated precision.
      const decimals = (raw.split(".")[1] ?? "").length;
      const factor = 10 ** decimals;
      if (paperNums.some((p) => Math.round(p * factor) / factor === value)) continue;
      unknown.add(m[0]);
    }
  }

  return unknown.size === 0
    ? ok(id, label, "warning")
    : fail(
        id,
        label,
        "warning",
        `Not found in the paper: ${[...unknown].slice(0, 10).join(", ")}.`,
      );
}

/** Words that are capitalized mid-sentence without being paper-specific. */
const PROPER_NOUN_ALLOWLIST = new Set([
  "i",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "english",
  "internet",
  "web",
]);

/* ── runner ────────────────────────────────────────────────────────────── */

export const ALL_CHECKS = [
  checkSchema,
  checkAlternation,
  checkTurnCount,
  checkWordCount,
  checkShowName,
  checkNoHonorifics,
  checkNoClaimedExpertise,
  checkNoAuthorImpersonation,
  checkNoDirectAddress,
  checkProperNouns,
  checkNumbers,
];

export function runDeterministicChecks(ctx: CheckContext): DeterministicReport {
  const checks = ALL_CHECKS.map((fn) => fn(ctx));
  const failed = checks.filter((c) => !c.passed);
  return {
    checks,
    errors: failed.filter((c) => c.severity === "error").length,
    warnings: failed.filter((c) => c.severity === "warning").length,
    complianceScore: checks.length ? (checks.length - failed.length) / checks.length : 1,
  };
}
