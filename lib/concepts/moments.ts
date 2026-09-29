/**
 * Where in an episode a concept is talked about.
 *
 * A concept map that only lists episode titles is a table of contents: it says
 * *which* episode, and leaves the listener to scrub through twenty minutes to
 * find the part that matters. Every episode already carries exact per-turn
 * timings from synthesis, so the missing piece is only which turns speak about
 * which idea.
 *
 * That is found by name, the same way concepts are grounded in the paper: a
 * turn is a moment for a concept when it says the concept's name or one of its
 * aliases. No model, no embedding, nothing that could put a concept somewhere
 * it is not said. A concept the episode never names aloud has no moments, and
 * the card says so rather than pointing at the nearest paragraph.
 */
import type { ConceptMap, ConceptRelation } from "./index";

/** A place in one episode where something is said. */
export interface Moment {
  episodeId: string;
  turnIndex: number;
  /** Where the turn starts in the audio, when the episode has audio. */
  startMs?: number;
  /** The sentence it is said in, trimmed to fit a line. */
  snippet: string;
}

/** The turns and timings an episode needs to be searched. */
export interface EpisodeTranscript {
  id: string;
  turns: { text: string }[];
  timings?: { turnIndex: number; startMs: number }[];
}

export interface ConceptMoments {
  /** By concept term. */
  byConcept: Record<string, Moment[]>;
  /** By `relationKey`. */
  byRelation: Record<string, Moment[]>;
}

/** Moments offered per episode: the first few are where an idea is introduced. */
const PER_EPISODE = 3;
const SNIPPET_CHARS = 140;

/** Lowercase, hyphens as spaces, whitespace collapsed: how names and text are compared. */
export function flatten(text: string): string {
  return text.toLowerCase().replace(/[-‐–]/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether a name appears in flattened text as a whole word or phrase. */
export function mentions(haystack: string, name: string): boolean {
  const needle = flatten(name);
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // An optional plural, so "transformers" still finds "Transformer".
  return new RegExp(`(^|[^a-z0-9])${escaped}(e?s)?([^a-z0-9]|$)`).test(haystack);
}

/** mm:ss, for a moment's position in the audio. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** How a moment is labelled: its time when there is audio, its turn when not. */
export function momentLabel(m: Moment): string {
  return m.startMs !== undefined ? clock(m.startMs) : `turn ${m.turnIndex + 1}`;
}

/** One key per relation, shared by the map, the graph and the moments. */
export function relationKey(
  r: Pick<ConceptRelation, "source" | "type" | "target">,
): string {
  return `${r.source}|${r.type}|${r.target}`;
}

/** A link that opens an episode at a turn, playing from where it starts. */
export function momentHref(episodeId: string, turnIndex: number): string {
  return `/library/${episodeId}?turn=${turnIndex}#turn-${turnIndex}`;
}

/** The sentence of a turn that says one of the names, for a line of context. */
function snippetFor(text: string, names: string[]): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hit =
    sentences.find((s) => names.some((n) => mentions(flatten(s), n))) ??
    sentences[0] ??
    "";
  const trimmed = hit.trim();
  return trimmed.length > SNIPPET_CHARS
    ? `${trimmed.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`
    : trimmed;
}

/**
 * The turns of one episode that say every one of the given name groups.
 *
 * Each group is the names of one idea, any of which counts. One group finds a
 * concept; two find a relation, spoken about in a single turn.
 */
export function findMoments(
  episode: EpisodeTranscript,
  groups: string[][],
  limit = PER_EPISODE,
): Moment[] {
  const starts = new Map((episode.timings ?? []).map((t) => [t.turnIndex, t.startMs]));
  const out: Moment[] = [];
  for (const [turnIndex, turn] of episode.turns.entries()) {
    const flat = flatten(turn.text);
    if (!groups.every((names) => names.some((n) => mentions(flat, n)))) continue;
    const startMs = starts.get(turnIndex);
    out.push({
      episodeId: episode.id,
      turnIndex,
      ...(startMs !== undefined ? { startMs } : {}),
      snippet: snippetFor(turn.text, groups.flat()),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Every concept's and relation's moments across the library.
 *
 * A concept is searched for under every name it goes by in that episode: its
 * library-wide name, its display label, and the aliases that episode gave it.
 */
export function conceptMoments(
  map: ConceptMap,
  transcripts: EpisodeTranscript[],
): ConceptMoments {
  const byId = new Map(transcripts.map((t) => [t.id, t]));

  const namesIn = (term: string, episodeId: string): string[] => {
    const node = map.concepts.find((c) => c.term === term);
    const concept = map.byEpisode[episodeId]?.find((c) => c.term === term);
    return [
      ...new Set([
        term,
        node?.label ?? term,
        ...(concept?.label ? [concept.label] : []),
        ...(concept?.aliases ?? []),
      ]),
    ];
  };

  const byConcept: Record<string, Moment[]> = {};
  for (const node of map.concepts) {
    const found = node.episodes.flatMap((id) => {
      const episode = byId.get(id);
      return episode ? findMoments(episode, [namesIn(node.term, id)]) : [];
    });
    if (found.length) byConcept[node.term] = found;
  }

  const byRelation: Record<string, Moment[]> = {};
  for (const r of map.relations) {
    const found = r.episodes.flatMap((id) => {
      const episode = byId.get(id);
      return episode
        ? findMoments(episode, [namesIn(r.source, id), namesIn(r.target, id)])
        : [];
    });
    if (found.length) byRelation[relationKey(r)] = found;
  }

  return { byConcept, byRelation };
}
