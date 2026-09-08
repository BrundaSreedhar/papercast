/**
 * Deliberate corruption of a known-good episode.
 *
 * Static fixtures show that the checks catch the specific failures already
 * observed. They say nothing about sensitivity in general, and hand-writing
 * more cases only ever tests the failures already imagined. Injecting known
 * corruptions into a clean episode turns one good sample into a family of
 * known-bad ones, and makes the question answerable as a rate rather than an
 * anecdote: of N injected faults, how many does the harness catch?
 *
 * Every mutation names the check expected to catch it, so a mutation that goes
 * unnoticed is a measurable gap rather than a silent one.
 */
import type { Episode } from "../llm/schema";

export type MutationKind =
  | "swap-number"
  | "fabricate-entity"
  | "add-honorific"
  | "claim-authorship"
  | "claim-expertise"
  | "invent-show-name"
  | "address-by-name"
  | "break-alternation"
  | "truncate-dialogue";

export interface Mutation {
  kind: MutationKind;
  /** id of the check that should detect this corruption. */
  expectedCheck: string;
  description: string;
}

export const MUTATIONS: Mutation[] = [
  {
    kind: "swap-number",
    expectedCheck: "numbers",
    description: "Replace a figure with one the paper never states",
  },
  {
    kind: "fabricate-entity",
    expectedCheck: "proper-nouns",
    description: "Introduce a system the paper never mentions",
  },
  {
    kind: "add-honorific",
    expectedCheck: "honorifics",
    description: "Give a speaker a doctorate",
  },
  {
    kind: "claim-authorship",
    expectedCheck: "author-impersonation",
    description: "Have a speaker claim the paper's work as their own",
  },
  {
    kind: "claim-expertise",
    expectedCheck: "claimed-expertise",
    description: "Describe a speaker as an expert in the field",
  },
  {
    kind: "invent-show-name",
    expectedCheck: "show-name",
    description: "Open with a show name other than the configured one",
  },
  {
    kind: "address-by-name",
    expectedCheck: "no-names",
    description: "Have a speaker address the other by an invented name",
  },
  {
    kind: "break-alternation",
    expectedCheck: "alternation",
    description: "Make the same speaker take two turns in a row",
  },
  {
    kind: "truncate-dialogue",
    expectedCheck: "turn-count",
    description: "Cut the dialogue far below its target length",
  },
];

function clone(episode: Episode): Episode {
  return {
    summary: episode.summary,
    keyPoints: [...episode.keyPoints],
    turns: episode.turns.map((t) => ({ ...t })),
  };
}

/** Index of the first turn whose text matches, or 0. */
function findTurn(episode: Episode, re: RegExp): number {
  const i = episode.turns.findIndex((t) => re.test(t.text));
  return i === -1 ? 0 : i;
}

/**
 * Apply one corruption. Deterministic, so a failing detection is reproducible
 * rather than dependent on which random turn was hit.
 */
export function applyMutation(episode: Episode, kind: MutationKind): Episode {
  const out = clone(episode);
  const turns = out.turns;
  if (turns.length === 0) return out;

  switch (kind) {
    case "swap-number": {
      const i = findTurn(out, /\b\d[\d,]*(?:\.\d+)?\b/);
      const t = turns[i]!;
      // 8317 is arbitrary and absent from any realistic paper.
      t.text = t.text.replace(/\b\d[\d,]*(?:\.\d+)?\b/, "8317");
      if (!/8317/.test(t.text))
        t.text += " Throughput reached 8317 transactions per second.";
      break;
    }
    case "fabricate-entity":
      turns[Math.min(1, turns.length - 1)]!.text +=
        " This builds directly on the Chubby coordination service.";
      break;
    case "add-honorific":
      turns[0]!.text += " Dr. Halloran walks us through it.";
      break;
    case "claim-authorship":
      turns[Math.min(1, turns.length - 1)]!.text +=
        " In our experiments we designed the quorum scheme to cut latency.";
      break;
    case "claim-expertise":
      turns[0]!.text += " Joining us is an expert in distributed storage systems.";
      break;
    case "invent-show-name":
      turns[0]!.text = `Welcome to Science Uncovered. ${turns[0]!.text}`;
      break;
    case "address-by-name":
      turns[turns.length - 1]!.text =
        `Thanks, Marcus, for that. ${turns[turns.length - 1]!.text}`;
      break;
    case "break-alternation":
      if (turns.length >= 2) turns[1]!.speaker = turns[0]!.speaker;
      break;
    case "truncate-dialogue":
      out.turns = turns.slice(0, 3);
      break;
  }
  return out;
}
