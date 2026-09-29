/**
 * Where each concept sits on the map.
 *
 * Two layouts, both deterministic: the same library draws the same picture on
 * every visit, which is what lets someone recognise their map rather than
 * re-read it.
 *
 * The overview is a ring, grouped. Each paper's concepts sit together on their
 * own arc with a gap before the next paper, so "which paper is this from" is
 * answered by position (and colour) instead of a line to every sibling. Concepts shared
 * between papers leave the ring for an inner circle: they are the bridges, and
 * the middle is where the eye goes.
 *
 * The ego view is what selecting a concept turns the map into. It moves to the
 * centre; the ideas it connects to form a ring around it, those with a typed
 * relation first; and the ideas one step further sit faded behind the
 * neighbour they are reached through. Everything else leaves. A whole library
 * at once is a picture; one idea and its surroundings is something a person
 * can actually read.
 */
import type { ConceptMap, ConceptNode } from "./index";

export type Ring = "centre" | "inner" | "outer" | "near" | "far";

export interface Placed {
  term: string;
  x: number;
  y: number;
  ring: Ring;
}

export interface Layout {
  placed: Placed[];
}

export interface LayoutOptions {
  size: number;
}

/** Shared concepts beyond this go to the outer ring; the inner one is small. */
const INNER_MAX = 6;
/** Neighbours around a selected concept, and ideas one step beyond them. */
export const NEAR_MAX = 10;
export const FAR_MAX = 12;

const TOP = -Math.PI / 2;

function onCircle(size: number, radius: number, angle: number) {
  return {
    x: size / 2 + Math.cos(angle) * radius,
    y: size / 2 + Math.sin(angle) * radius,
  };
}

/**
 * The overview: shared concepts inside, each paper's on its own arc.
 *
 * `concepts` arrive already chosen and in strength order; this only decides
 * where they go. Papers take their arcs in the order their strongest concept
 * appears, so the most important paper starts at the top.
 */
export function overviewLayout(concepts: ConceptNode[], { size }: LayoutOptions): Layout {
  const multi = concepts.filter((c) => c.papers.length > 1);
  const single = concepts.filter((c) => c.papers.length <= 1);

  // The inner circle only means something against an outer one: when every
  // concept is shared, there is nothing to set the bridges apart from.
  const inner = single.length > 0 ? multi.slice(0, INNER_MAX) : [];
  const overflow = single.length > 0 ? multi.slice(INNER_MAX) : multi;

  const placed: Placed[] = [];
  if (inner.length === 1) {
    placed.push({ term: inner[0]!.term, ...onCircle(size, 0, 0), ring: "inner" });
  } else {
    inner.forEach((c, i) => {
      const angle = TOP + (i / inner.length) * Math.PI * 2;
      placed.push({ term: c.term, ...onCircle(size, size * 0.13, angle), ring: "inner" });
    });
  }

  // Groups: any shared overflow first, then one per paper.
  const order: string[] = [];
  for (const c of single) {
    const paper = c.papers[0] ?? "";
    if (!order.includes(paper)) order.push(paper);
  }
  const groups: ConceptNode[][] = [
    ...(overflow.length ? [overflow] : []),
    ...order.map((paper) => single.filter((c) => (c.papers[0] ?? "") === paper)),
  ];

  // One empty slot after each group separates the arcs, when there are arcs
  // to separate.
  const gap = groups.length > 1 ? 1 : 0;
  const slots = groups.reduce((n, g) => n + g.length + gap, 0);
  const radius = size * 0.36;
  let slot = 0;
  for (const g of groups) {
    for (const c of g) {
      // Half a slot off the top, so the first two concepts straddle it and
      // their labels run apart instead of both running right into each other.
      const angle = TOP + ((slot + 0.5) / slots) * Math.PI * 2;
      placed.push({ term: c.term, ...onCircle(size, radius, angle), ring: "outer" });
      slot++;
    }
    slot += gap;
  }

  return { placed };
}

/**
 * The concepts the overview has room for, strongest first.
 *
 * The ring holds a fixed number of slots before labels collide near the top
 * and bottom, where they run almost horizontally. The gap between two papers'
 * arcs takes a slot like a concept does, so the more papers are on the map,
 * the fewer concepts each gets — rather than the same number squeezed closer.
 */
export function chooseForOverview(concepts: ConceptNode[], slots: number): ConceptNode[] {
  const chosen: ConceptNode[] = [];
  const papers = new Set<string>();
  for (const c of concepts) {
    const next = new Set(papers);
    if (c.papers.length <= 1) next.add(c.papers[0] ?? "");
    const gaps = next.size > 1 ? next.size : 0;
    if (chosen.length + 1 + gaps > slots) continue;
    chosen.push(c);
    for (const p of next) papers.add(p);
  }
  return chosen;
}

/** A concept's neighbours, those it has a typed relation with first. */
export function neighboursOf(map: ConceptMap, term: string): string[] {
  const typed = map.relations
    .filter((r) => r.source === term || r.target === term)
    .map((r) => (r.source === term ? r.target : r.source));
  const together = map.edges
    .filter((e) => e.a === term || e.b === term)
    .map((e) => (e.a === term ? e.b : e.a));
  return [...new Set([...typed, ...together])].filter((t) => t !== term);
}

/**
 * The ego view around one concept.
 *
 * Ideas one step further out are placed by the neighbour they are reached
 * through, in that neighbour's order, so a branch stays on its own side of
 * the map instead of being scattered around it.
 */
export function egoLayout(
  map: ConceptMap,
  centre: string,
  { size }: LayoutOptions,
): Layout {
  const near = neighboursOf(map, centre).slice(0, NEAR_MAX);
  const seen = new Set([centre, ...near]);
  const far: string[] = [];
  for (const n of near) {
    for (const f of neighboursOf(map, n)) {
      if (far.length >= FAR_MAX) break;
      if (seen.has(f)) continue;
      seen.add(f);
      far.push(f);
    }
  }

  const placed: Placed[] = [{ term: centre, ...onCircle(size, 0, 0), ring: "centre" }];
  near.forEach((term, i) => {
    const angle = TOP + (i / near.length) * Math.PI * 2;
    placed.push({ term, ...onCircle(size, size * 0.23, angle), ring: "near" });
  });
  // Offset by half a step, so a far idea sits between two neighbours rather
  // than directly behind one and hidden by its label.
  far.forEach((term, i) => {
    const angle = TOP + ((i + 0.5) / far.length) * Math.PI * 2;
    placed.push({ term, ...onCircle(size, size * 0.4, angle), ring: "far" });
  });
  return { placed };
}
