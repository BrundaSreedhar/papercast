"use client";

import Link from "next/link";
import { useState } from "react";
import type { ConceptMap } from "@/lib/concepts/index";

const SIZE = 620;
const CENTRE = SIZE / 2;
const RADIUS = SIZE * 0.36;

/**
 * The library as a map of ideas.
 *
 * Laid out on a circle rather than by a force simulation. A simulation would
 * look more organic and would put the graph in a different place every time it
 * ran, which for something meant to be recognised on a second visit is a cost
 * with no matching benefit — and it would need a physics loop to draw a picture
 * that never moves. A ring is deterministic, and ordering it by how many
 * episodes touch a concept puts the connective ideas together rather than
 * scattering them.
 *
 * Concepts shared between episodes are the point, so they are the only ones
 * given the accent colour: on a shelf of unrelated papers the map is honestly
 * sparse, and on one with overlap the overlap is what stands out.
 */
export function ConceptGraph({
  map,
  titles,
}: {
  map: ConceptMap;
  titles: Record<string, string>;
}) {
  const [focused, setFocused] = useState<string | null>(null);

  const terms = map.concepts.slice(0, 24);
  const positions = new Map(
    terms.map((c, i) => {
      // Start at the top and go clockwise, so the strongest concept is where
      // the eye lands first.
      const angle = (i / terms.length) * Math.PI * 2 - Math.PI / 2;
      return [
        c.term,
        {
          x: CENTRE + Math.cos(angle) * RADIUS,
          y: CENTRE + Math.sin(angle) * RADIUS,
          angle,
        },
      ];
    }),
  );

  const edges = map.edges.filter((e) => positions.has(e.a) && positions.has(e.b));
  const active = focused
    ? new Set(
        edges
          .filter((e) => e.a === focused || e.b === focused)
          .flatMap((e) => [e.a, e.b])
          .concat(focused),
      )
    : null;

  const node = map.concepts.find((c) => c.term === focused);

  return (
    <div className="graph">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="graph-svg"
        role="img"
        aria-label={`A map of ${terms.length} concepts and the episodes that share them`}
      >
        {edges.map((e) => {
          const a = positions.get(e.a)!;
          const b = positions.get(e.b)!;
          const lit = !active || (active.has(e.a) && active.has(e.b));
          return (
            <line
              key={`${e.a}|${e.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={lit ? "edge lit" : "edge"}
              strokeWidth={Math.min(3, e.episodes.length)}
            />
          );
        })}

        {terms.map((c) => {
          const p = positions.get(c.term)!;
          const shared = c.episodes.length > 1;
          const dimmed = active !== null && !active.has(c.term);
          // Labels on the left half read outward too, so none of them are
          // upside down and none of them run back over the circle.
          const flip = Math.cos(p.angle) < 0;
          return (
            <g
              key={c.term}
              className={dimmed ? "node dimmed" : "node"}
              onMouseEnter={() => setFocused(c.term)}
              onMouseLeave={() => setFocused(null)}
              onClick={() => setFocused((f) => (f === c.term ? null : c.term))}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={5 + Math.min(7, c.episodes.length * 3)}
                className={shared ? "dot shared" : "dot"}
              />
              <text
                x={p.x + Math.cos(p.angle) * 14}
                y={p.y + Math.sin(p.angle) * 14}
                textAnchor={flip ? "end" : "start"}
                dominantBaseline="middle"
                className={shared ? "label shared" : "label"}
              >
                {c.term}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="graph-detail" aria-live="polite">
        {node ? (
          <>
            <strong>{node.term}</strong>
            <span>
              {node.episodes.map((id, i) => (
                <span key={id}>
                  {i > 0 && " · "}
                  <Link href={`/library/${id}`}>{titles[id] ?? id}</Link>
                </span>
              ))}
            </span>
          </>
        ) : (
          <span className="sub" style={{ margin: 0 }}>
            Hover a concept to see which episodes cover it. Filled circles are shared by
            more than one.
          </span>
        )}
      </div>
    </div>
  );
}
