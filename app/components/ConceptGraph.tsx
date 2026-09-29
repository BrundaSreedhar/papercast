"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ConceptMap } from "@/lib/concepts/index";
import { RELATION_TYPES, type RelationType } from "@/lib/concepts/relations";
import {
  momentHref,
  momentLabel,
  relationKey,
  type ConceptMoments,
  type Moment,
} from "@/lib/concepts/moments";
import { chooseForOverview, egoLayout, overviewLayout } from "@/lib/concepts/layout";

const SIZE = 620;
const CENTRE = SIZE / 2;
const MAX_NODES = 16;
/** How visible ideas two steps from the selected one are: there, but behind. */
const FAR_OPACITY = 0.45;
/** Long enough to follow where an idea went, short enough not to wait for. */
const TWEEN_MS = 520;
/** The beat between one idea setting off and the next. */
const STAGGER_MS = 22;

/** Ease out with a slight overshoot, so movement lands with a little bounce. */
function springOut(k: number): number {
  const c1 = 1.35;
  const c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
}
const VISIT_KEY = "papercast:concepts:last-visit";

/**
 * Coordinates are rounded before they reach the DOM.
 *
 * The server and the browser do not agree on the last bit of Math.cos, so an
 * unrounded position renders as 503.2968701246867 on one and 503.2968701246866
 * on the other, and React reports a hydration mismatch on every line in the
 * graph. Two decimal places is far below a pixel and removes it entirely.
 */
const at = (n: number): number => Math.round(n * 100) / 100;

/** How each relation reads in a sentence, "source <verb> target". */
const VERB: Record<RelationType, string> = {
  "builds-on": "builds on",
  "is-a": "is a kind of",
  "part-of": "is part of",
  "used-for": "is used for",
  "contrasts-with": "is contrasted with",
};

/** Symmetric relations have no direction to draw. */
const DIRECTED = (type: RelationType) => type !== "contrasts-with";

/**
 * When the reader last opened the map, read once per page load.
 *
 * Once, because reading also records this visit: a second read — React runs
 * mount effects twice in development, and remounts on navigation — would find
 * the visit just recorded and mark nothing as new. Held at module level so it
 * survives both.
 */
let visitReadThisLoad: number | null | undefined;
function readLastVisit(): number | null {
  if (visitReadThisLoad !== undefined) return visitReadThisLoad;
  let last: number | null = null;
  try {
    const stored = window.localStorage.getItem(VISIT_KEY);
    last = stored ? Number(stored) : null;
    window.localStorage.setItem(VISIT_KEY, String(Date.now()));
  } catch {
    // Storage refused: nothing is marked new, which is a fine default.
  }
  visitReadThisLoad = last;
  return last;
}

interface Pose {
  x: number;
  y: number;
  /** Opacity, 0–1. */
  o: number;
}

/**
 * Glide from one layout to the next instead of jumping.
 *
 * Moving between the overview and a selected idea rearranges every node, and
 * a jump leaves the reader hunting for where each one went. Positions are
 * interpolated frame by frame rather than left to CSS, because the lines have
 * to move with the nodes and an SVG line's endpoints are not animatable
 * properties. An idea arriving fades in where it lands; one leaving fades out
 * where it was. Readers who ask for reduced motion get the jump.
 */
function useTween(target: Map<string, Pose>): Map<string, Pose> {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const key = [...target]
    .map(([t, p]) => `${t}:${Math.round(p.x)},${Math.round(p.y)},${p.o}`)
    .join("|");
  const lastKey = useRef(key);

  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    const from = current.current;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const k = Math.min(1, elapsed / (TWEEN_MS + target.size * STAGGER_MS));
      const eased = 1 - (1 - k) ** 3;
      const next = new Map<string, Pose>();
      let i = 0;
      for (const [term, to] of target) {
        // Each idea sets off a beat after the one before, and overshoots a
        // touch before settling: a map that springs into place rather than
        // sliding. The order is the layout's, so the centre goes first.
        const own = Math.min(1, Math.max(0, (elapsed - i++ * STAGGER_MS) / TWEEN_MS));
        const spring = springOut(own);
        const f = from.get(term) ?? { ...to, o: 0 };
        next.set(term, {
          x: f.x + (to.x - f.x) * spring,
          y: f.y + (to.y - f.y) * spring,
          o: f.o + (to.o - f.o) * (1 - (1 - own) ** 3),
        });
      }
      if (k < 1) {
        for (const [term, f] of from) {
          if (!target.has(term)) next.set(term, { ...f, o: f.o * (1 - eased) });
        }
      }
      current.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Keyed on the layout's content, not the Map, which is new every render.
  }, [key]);

  return shown;
}

/** One colour per paper, in the order papers first appear; defined in globals.css. */
const PAPER_COLOURS = 6;
const BRIDGE_COLOUR = "var(--accent)";

/** Node size follows how central the idea is: core concepts read as bigger. */
const radiusOfNode = (weight: number, sharedNode: boolean) =>
  5 + 6 * Math.min(1, weight / 1.5) + (sharedNode ? 2 : 0);
const CENTRE_RADIUS = 17;

/**
 * A gently curved line between two points, pulled back from both circles.
 *
 * Chords straight across a ring cross each other in a thicket; bowed a little
 * toward the middle they read as a bundle. `bend` is how far the midpoint
 * moves toward the centre (negative bows outward), and the ends are pulled
 * back along the curve so an arrowhead stops at the circle's edge.
 */
function curve(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bend: number,
  gapA: number,
  gapB: number,
) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx + (CENTRE - mx) * bend;
  const cy = my + (CENTRE - my) * bend;
  const pull = (p: { x: number; y: number }, gap: number) => {
    const dx = cx - p.x;
    const dy = cy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * gap, y: p.y + (dy / len) * gap };
  };
  const s = pull(a, gapA);
  const e = pull(b, gapB);
  return `M${at(s.x)},${at(s.y)} Q${at(cx)},${at(cy)} ${at(e.x)},${at(e.y)}`;
}

/**
 * The library as a map of ideas.
 *
 * Laid out by rule rather than by a force simulation, so the same library is
 * the same picture on every visit (see `lib/concepts/layout`). The overview
 * gives each paper an arc and a colour and pulls shared ideas into the middle;
 * clicking an idea zooms in on it — it takes the centre, what it connects to
 * orbits it, and the rest leaves — and the close button or Escape zooms back
 * out.
 *
 * Colour says where an idea comes from and line style says how two ideas
 * relate, so the two never compete: nodes carry their paper's colour, lines
 * stay neutral and are solid, dotted or dashed by relation. Ideas that bridge
 * papers take the accent colour — on a shelf of unrelated papers the map is
 * honestly sparse, and on one with overlap the bridges are what stand out.
 *
 * Co-occurrence lines are not drawn by default: every concept of an episode is
 * co-covered with every other, so a paper drew as a complete clique saying
 * only "same paper", which the arcs and colours already say. Typed relations
 * are always drawn; they are the lines that say something, with a passage in
 * the paper saying so.
 *
 * Every card leads back to the audio: each moment opens the episode cued to
 * the turn that says it. A map you can only look at is one you stop opening.
 */
export function ConceptGraph({
  map,
  titles,
  related = [],
  moments = { byConcept: {}, byRelation: {} },
  episodePaper = {},
  firstSeen = {},
}: {
  map: ConceptMap;
  titles: Record<string, string>;
  /** Concepts that mean roughly the same thing without sharing words. */
  related?: { a: string; b: string; score: number }[];
  /** Where each concept and relation is spoken, for links into the audio. */
  moments?: ConceptMoments;
  /** Which paper each episode is of, by paper key, for colouring the card. */
  episodePaper?: Record<string, string>;
  /** When each concept first reached the library, by term, in ms. */
  firstSeen?: Record<string, number>;
}) {
  // Hover explores, a click zooms in. Without pinning the panel empties the
  // moment the pointer leaves, which makes the episode links unreachable.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // A relation chosen by clicking its line, or its row in a concept's card.
  const [chosen, setChosen] = useState<string | null>(null);
  const focused = pinned ?? hovered;
  const relation = chosen
    ? map.relations.find((r) => relationKey(r) === chosen)
    : undefined;

  const pinConcept = (term: string) => {
    setChosen(null);
    setPinned(term);
  };
  const toggleConcept = (term: string) => {
    setChosen(null);
    setPinned((f) => (f === term ? null : term));
  };
  const chooseRelation = (key: string) => {
    setPinned(null);
    setChosen(key);
  };
  const zoomOut = () => {
    setPinned(null);
    setHovered(null);
  };

  const shared = map.concepts.filter((c) => c.papers.length > 1);
  // One-off concepts are noise on a map whose subject is what connects. They
  // are hidden when there is enough shared material to be worth looking at,
  // and shown when hiding them would leave an empty page.
  const canFilter = shared.length >= 3;
  const [sharedOnly, setSharedOnly] = useState(canFilter);
  const [allLinks, setAllLinks] = useState(false);
  const visible = sharedOnly && canFilter ? shared : map.concepts;
  const byTerm = new Map(map.concepts.map((c) => [c.term, c]));

  // Papers in the order they first appear, each with its own colour.
  const paperOrder = [...new Set(map.concepts.flatMap((c) => c.papers))];
  const colourOfPaper = (paper: string | undefined) => {
    const i = paper === undefined ? -1 : paperOrder.indexOf(paper);
    return i < 0 ? "var(--faint)" : `var(--paper-${(i % PAPER_COLOURS) + 1})`;
  };
  const colourOf = (term: string) => {
    const c = byTerm.get(term);
    if (!c) return "var(--faint)";
    return c.papers.length > 1 ? BRIDGE_COLOUR : colourOfPaper(c.papers[0]);
  };

  // What is new since the reader last opened the map. Read after mount,
  // because the server has no idea when anyone last visited; a first visit
  // marks nothing rather than everything.
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  useEffect(() => {
    setLastVisit(readLastVisit());
  }, []);
  const isNew = (term: string) =>
    lastVisit !== null && (firstSeen[term] ?? 0) > lastVisit;
  const newCount = map.concepts.filter((c) => isNew(c.term)).length;

  // Sixteen slots is what fits around a circle before labels collide near the
  // top and bottom, where they run almost horizontally; the gap between two
  // papers' arcs takes one. Chosen by strength; where each goes is the
  // layout's business.
  const onRing = chooseForOverview(visible, MAX_NODES);
  const ego = pinned !== null && byTerm.has(pinned);

  // Escape zooms back out, as the close button does.
  useEffect(() => {
    if (!ego) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") zoomOut();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ego]);

  const layout = ego
    ? egoLayout(map, pinned!, { size: SIZE })
    : overviewLayout(onRing, { size: SIZE });
  const ringOf = new Map(layout.placed.map((p) => [p.term, p.ring]));
  const target = new Map(
    layout.placed.map((p) => [
      p.term,
      { x: p.x, y: p.y, o: p.ring === "far" ? FAR_OPACITY : 1 },
    ]),
  );
  const shown = useTween(target);
  // Rounded for the DOM, and only what is visible enough to draw.
  const positions = new Map(
    [...shown]
      .filter(([term, p]) => p.o > 0.02 && byTerm.has(term))
      .map(([term, p]) => [term, { x: at(p.x), y: at(p.y), o: p.o }]),
  );
  const isShared = new Set(
    [...positions.keys()].filter((t) => (byTerm.get(t)?.papers.length ?? 0) > 1),
  );
  const rings = new Set(layout.placed.map((p) => p.ring));

  const typed = map.relations.filter(
    (r) => positions.has(r.source) && positions.has(r.target),
  );
  const typedPair = new Set(
    typed.flatMap((r) => [`${r.source}|${r.target}`, `${r.target}|${r.source}`]),
  );
  const edges = map.edges.filter((e) => positions.has(e.a) && positions.has(e.b));
  const bridgesOut = (a: string, b: string) =>
    (ringOf.get(a) === "near" && ringOf.get(b) === "far") ||
    (ringOf.get(a) === "far" && ringOf.get(b) === "near");
  const drawn = edges.filter(
    (e) =>
      !typedPair.has(`${e.a}|${e.b}`) &&
      (allLinks ||
        (ego
          ? // Around the idea zoomed in on: its own links, and the ones that
            // explain how each idea further out is reached.
            e.a === pinned || e.b === pinned || bridgesOut(e.a, e.b)
          : isShared.has(e.a) ||
            isShared.has(e.b) ||
            (focused !== null && (e.a === focused || e.b === focused)))),
  );
  // Zoomed in, the layout already says what matters, so only hovering dims;
  // in the overview, selection does too.
  const highlight = ego ? hovered : focused;
  const active =
    !highlight && relation
      ? new Set([relation.source, relation.target])
      : highlight
        ? new Set(
            [
              ...edges
                .filter((e) => e.a === highlight || e.b === highlight)
                .flatMap((e) => [e.a, e.b]),
              ...typed
                .filter((r) => r.source === highlight || r.target === highlight)
                .flatMap((r) => [r.source, r.target]),
            ].concat(highlight),
          )
        : null;
  const labelOf = new Map(map.concepts.map((c) => [c.term, c.label]));
  const radiusFor = (term: string) => {
    if (ringOf.get(term) === "centre") return CENTRE_RADIUS;
    const c = byTerm.get(term);
    return c ? radiusOfNode(c.weight, c.papers.length > 1) : 6;
  };
  const typesShown = RELATION_TYPES.filter((t) => typed.some((r) => r.type === t));
  const fade = (a: string, b: string) =>
    Math.min(positions.get(a)?.o ?? 1, positions.get(b)?.o ?? 1);
  // Lines into the centre run straight, like spokes; others bow gently.
  const bendFor = (a: string, b: string) =>
    ego ? (a === pinned || b === pinned ? 0 : -0.3) : 0.35;

  // Any concept, not only the ones drawn: a chip can select one that is off
  // the ring, and its card is still worth reading.
  const node = map.concepts.find((c) => c.term === focused);
  // Every relation of the selected idea, including ones to ideas not drawn.
  const nodeRelations = node
    ? map.relations.filter((r) => r.source === node.term || r.target === node.term)
    : [];
  // Neighbours, those it has a typed relation with first: they are the ones the
  // card can say something about.
  const neighbours = node
    ? [
        ...new Set([
          ...nodeRelations.map((r) => (r.source === node.term ? r.target : r.source)),
          ...map.edges
            .filter((e) => e.a === node.term || e.b === node.term)
            .map((e) => (e.a === node.term ? e.b : e.a)),
        ]),
      ].slice(0, 10)
    : [];
  const sharedTerms = new Set(shared.map((c) => c.term));
  const nearCount = layout.placed.filter((p) => p.ring === "near").length;

  const momentLinks = (list: Moment[]) =>
    list.map((m) => (
      <Link
        key={`${m.episodeId}-${m.turnIndex}`}
        href={momentHref(m.episodeId, m.turnIndex)}
        className="moment"
        title={m.snippet}
      >
        ▶ {momentLabel(m)}
      </Link>
    ));

  const conceptLink = (term: string) => (
    <button type="button" className="relation-link" onClick={() => pinConcept(term)}>
      {labelOf.get(term) ?? term}
    </button>
  );

  return (
    <div className="graph">
      <div className={`graph-stage${ego ? " zoomed" : ""}`}>
        {ego && (
          <>
            <div className="zoom-title">
              <i
                className="paper-dot"
                style={{ color: colourOf(pinned!) }}
                aria-hidden="true"
              />
              <strong>{labelOf.get(pinned!)}</strong>
              <span>
                {nearCount} connected idea{nearCount === 1 ? "" : "s"}
              </span>
            </div>
            <button
              type="button"
              className="zoom-close"
              onClick={zoomOut}
              aria-label={`Close ${labelOf.get(pinned!)} and zoom out`}
              title="Zoom out (Esc)"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </>
        )}

        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="graph-svg"
          role="img"
          aria-label={
            ego
              ? `${labelOf.get(pinned!)} and the ${positions.size - 1} ideas around it`
              : `A map of ${positions.size} ideas and the episodes that cover them`
          }
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,1 L9,5 L0,9 z" className="arrowhead" />
            </marker>
            <radialGradient
              id="centre-glow"
              style={{ color: ego ? colourOf(pinned!) : undefined }}
            >
              <stop offset="0" stopColor="currentColor" stopOpacity="0.32" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* The tracks ideas sit on: orbits when zoomed in, the ring otherwise. */}
          <g className="orbits" aria-hidden="true">
            {ego ? (
              <>
                <circle
                  cx={CENTRE}
                  cy={CENTRE}
                  r={at(SIZE * 0.2)}
                  fill="url(#centre-glow)"
                  className="glow"
                />
                {rings.has("near") && (
                  <circle
                    cx={CENTRE}
                    cy={CENTRE}
                    r={at(SIZE * 0.23)}
                    className="orbit spin"
                  />
                )}
                {rings.has("far") && (
                  <circle
                    cx={CENTRE}
                    cy={CENTRE}
                    r={at(SIZE * 0.4)}
                    className="orbit spin slow"
                  />
                )}
              </>
            ) : (
              <>
                <circle cx={CENTRE} cy={CENTRE} r={at(SIZE * 0.36)} className="orbit" />
                {rings.has("inner") && (
                  <circle cx={CENTRE} cy={CENTRE} r={at(SIZE * 0.13)} className="orbit" />
                )}
              </>
            )}
          </g>

          {drawn.map((e) => {
            const a = positions.get(e.a)!;
            const b = positions.get(e.b)!;
            const lit = !active || (active.has(e.a) && active.has(e.b));
            return (
              <path
                key={`${e.a}|${e.b}`}
                d={curve(a, b, bendFor(e.a, e.b), radiusFor(e.a) + 2, radiusFor(e.b) + 2)}
                className={lit ? "edge lit" : "edge"}
                opacity={fade(e.a, e.b)}
              />
            );
          })}

          {typed.map((r) => {
            const key = relationKey(r);
            const lit = !active || (active.has(r.source) && active.has(r.target));
            const a = positions.get(r.source)!;
            const b = positions.get(r.target)!;
            const d = curve(
              a,
              b,
              bendFor(r.source, r.target),
              radiusFor(r.source) + 2,
              radiusFor(r.target) + (DIRECTED(r.type) ? 5 : 2),
            );
            // Zoomed in, the idea's own relations say what they are on the line.
            const says = ego && (r.source === pinned || r.target === pinned);
            const outer = r.source === pinned ? b : a;
            const hub = positions.get(pinned ?? "") ?? a;
            return (
              // A wide invisible stroke under the visible one, because a thin
              // line is too hard to hit with a pointer.
              <g
                key={key}
                className="relation"
                opacity={fade(r.source, r.target)}
                onClick={() => chooseRelation(key)}
              >
                <path d={d} className="edge-hit" />
                <path
                  d={d}
                  className={`edge typed t-${r.type}${lit ? " lit" : ""}${chosen === key ? " chosen" : ""}`}
                  markerEnd={DIRECTED(r.type) ? "url(#arrow)" : undefined}
                />
                {says && (
                  // Out toward the neighbour, not at the middle: the middle is
                  // crowded by the centre's own label and every other spoke.
                  <text
                    x={at(hub.x + (outer.x - hub.x) * 0.68)}
                    y={at(hub.y + (outer.y - hub.y) * 0.68)}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="edge-label"
                  >
                    {VERB[r.type].replace(/^is /, "")}
                  </text>
                )}
                <title>
                  {`${labelOf.get(r.source)} ${VERB[r.type]} ${labelOf.get(r.target)}: ${r.explanation}`}
                </title>
              </g>
            );
          })}

          {/*
            Dashed and separate from the solid edges, because they are a
            different claim: a solid line means one episode covered both, a
            fact; a dashed one means the two read as being about the same
            thing, a judgement.
          */}
          {related
            .filter((r) => positions.has(r.a) && positions.has(r.b))
            .map((r) => {
              const a = positions.get(r.a)!;
              const b = positions.get(r.b)!;
              const lit = !active || (active.has(r.a) && active.has(r.b));
              return (
                <path
                  key={`~${r.a}|${r.b}`}
                  d={curve(
                    a,
                    b,
                    bendFor(r.a, r.b),
                    radiusFor(r.a) + 2,
                    radiusFor(r.b) + 2,
                  )}
                  className={lit ? "edge related lit" : "edge related"}
                  opacity={fade(r.a, r.b)}
                />
              );
            })}

          {[...positions].map(([term, p]) => {
            const c = byTerm.get(term)!;
            const ring = ringOf.get(term);
            const dimmed = active !== null && !active.has(term);
            const r = radiusFor(term);
            // Labels read outward from the middle, so none are upside down and
            // none run back over the map; the centre's label sits beneath it.
            const dx = p.x - CENTRE;
            const dy = p.y - CENTRE;
            const central = Math.hypot(dx, dy) < 4;
            const angle = Math.atan2(dy, dx);
            const classes = [
              "node",
              dimmed ? "dimmed" : "",
              ring === "centre" ? "centre" : "",
              ring === undefined ? "leaving" : "",
              c.papers.length > 1 ? "bridge" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <g
                key={term}
                className={classes}
                opacity={p.o}
                style={{ color: colourOf(term) }}
                onMouseEnter={() => setHovered(term)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => toggleConcept(term)}
              >
                {isNew(term) && (
                  <circle cx={p.x} cy={p.y} r={r + 5} className="new-halo" />
                )}
                <circle cx={p.x} cy={p.y} r={r} className="dot" />
                <text
                  x={central ? p.x : at(p.x + Math.cos(angle) * (r + 8))}
                  y={central ? at(p.y + r + 16) : at(p.y + Math.sin(angle) * (r + 8))}
                  textAnchor={central ? "middle" : Math.cos(angle) < 0 ? "end" : "start"}
                  dominantBaseline="middle"
                  className={`label${ring === "centre" ? " centre" : ""}`}
                >
                  {c.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {typesShown.length > 0 && (
        <ul className="graph-legend" aria-label="Kinds of relation">
          {typesShown.map((type) => (
            <li key={type}>
              <svg width="30" height="10" aria-hidden="true">
                <path
                  d="M2,5 L22,5"
                  className={`edge typed lit t-${type}`}
                  markerEnd={DIRECTED(type) ? "url(#arrow)" : undefined}
                />
              </svg>
              {VERB[type]}
            </li>
          ))}
        </ul>
      )}

      <div className="graph-controls">
        {canFilter ? (
          <label className="graph-toggle">
            <input
              type="checkbox"
              checked={sharedOnly}
              onChange={(e) => setSharedOnly(e.target.checked)}
            />
            only ideas more than one paper covers
          </label>
        ) : (
          <span className="sub" style={{ margin: 0 }}>
            Showing everything: too few ideas are shared yet to filter by.
          </span>
        )}
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={allLinks}
            onChange={(e) => setAllLinks(e.target.checked)}
          />
          every idea covered together
        </label>
        {newCount > 0 && (
          <span className="graph-new">{newCount} new since your last visit</span>
        )}
        {chosen && !pinned && (
          <button type="button" className="graph-clear" onClick={() => setChosen(null)}>
            clear selection
          </button>
        )}
      </div>

      <div className="graph-detail" aria-live="polite">
        {relation && !pinned ? (
          <>
            <strong>
              {conceptLink(relation.source)} <em>{VERB[relation.type]}</em>{" "}
              {conceptLink(relation.target)}
            </strong>
            <span>{relation.explanation}</span>
            <blockquote className="relation-quote">
              “{relation.evidence.text}”
              {relation.evidence.page !== undefined && (
                <span className="relation-where">
                  {" "}
                  — p. {relation.evidence.page}
                  {relation.evidence.heading ? `, ${relation.evidence.heading}` : ""}
                </span>
              )}
            </blockquote>
            <span className="card-label">Where it is said</span>
            {moments.byRelation[relationKey(relation)]?.length ? (
              <ul className="moments">
                {moments.byRelation[relationKey(relation)]!.map((m) => (
                  <li key={`${m.episodeId}-${m.turnIndex}`}>
                    {momentLinks([m])} <span className="snippet">{m.snippet}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span>
                No single turn names both.{" "}
                {relation.episodes.map((id, i) => (
                  <span key={id}>
                    {i > 0 && " · "}
                    <Link href={`/library/${id}`}>{titles[id] ?? id}</Link>
                  </span>
                ))}
              </span>
            )}
          </>
        ) : node ? (
          <>
            <strong>{node.label}</strong>
            {node.definition && <span>{node.definition}</span>}

            <span className="card-label">Where it is said</span>
            <ul className="moments">
              {node.episodes.map((id) => {
                const here = (moments.byConcept[node.term] ?? []).filter(
                  (m) => m.episodeId === id,
                );
                return (
                  <li key={id}>
                    <i
                      className="paper-dot"
                      style={{ color: colourOfPaper(episodePaper[id]) }}
                      aria-hidden="true"
                    />
                    <Link href={`/library/${id}`}>{titles[id] ?? id}</Link>{" "}
                    {here.length ? (
                      <>
                        {momentLinks(here)}
                        <span className="snippet">{here[0]!.snippet}</span>
                      </>
                    ) : (
                      <span className="snippet">not named aloud in this episode</span>
                    )}
                  </li>
                );
              })}
            </ul>

            {nodeRelations.length > 0 && (
              <>
                <span className="card-label">How it connects</span>
                <ul className="graph-relations">
                  {nodeRelations.map((r) => {
                    const key = relationKey(r);
                    const first = moments.byRelation[key]?.[0];
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className="relation-link relation-head"
                          onClick={() => chooseRelation(key)}
                        >
                          {labelOf.get(r.source) ?? r.source} <em>{VERB[r.type]}</em>{" "}
                          {labelOf.get(r.target) ?? r.target}
                        </button>
                        <span>
                          {r.explanation}
                          {r.evidence.page !== undefined && ` (p. ${r.evidence.page})`}
                          {first && <> {momentLinks([first])}</>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {neighbours.length > 0 && (
              <>
                <span className="card-label">Related ideas</span>
                <span className="chips">
                  {neighbours.map((term) => (
                    <button
                      key={term}
                      type="button"
                      className={sharedTerms.has(term) ? "chip shared" : "chip"}
                      onClick={() => pinConcept(term)}
                    >
                      {labelOf.get(term) ?? term}
                    </button>
                  ))}
                </span>
              </>
            )}
          </>
        ) : (
          <span className="sub" style={{ margin: 0 }}>
            Click an idea to zoom in on it and everything it connects to. Click a line to
            see how two ideas relate. ▶ opens the episode at the moment it is said. Each
            paper has its own colour; ideas that bridge papers take the accent colour.
          </span>
        )}
      </div>
    </div>
  );
}
