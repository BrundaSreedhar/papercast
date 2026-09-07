"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface Turn {
  speaker: "host" | "guest" | "narrator";
  text: string;
}
export interface Timing {
  turnIndex: number;
  startMs: number;
  endMs: number;
}

/** Where a turn came from in the paper. Absent when it could not be placed. */
export interface Citation {
  turnIndex: number;
  page: number;
  pageEnd?: number;
  heading: string;
  text: string;
  match: "exact" | "approximate";
  score: number;
}

/**
 * Audio with a transcript that follows it.
 *
 * The per-turn boundaries come from synthesis, where each turn's duration is
 * known exactly from its sample count. Nothing here estimates or aligns: the
 * highlight is driven by real timings, which is why clicking a line seeks
 * precisely to where that line begins.
 */
export function TranscriptPlayer({
  audioUrl,
  turns,
  timings,
  citations = [],
}: {
  audioUrl: string;
  turns: Turn[];
  timings: Timing[];
  citations?: Citation[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [follow, setFollow] = useState(true);

  const citationFor = useMemo(() => {
    const m = new Map<number, Citation>();
    for (const c of citations) m.set(c.turnIndex, c);
    return m;
  }, [citations]);

  // Sorted once so the lookup below can stop at the first match.
  const ordered = useMemo(
    () => [...timings].sort((a, b) => a.startMs - b.startMs),
    [timings],
  );

  const activeIndex = useMemo(() => {
    let active = -1;
    for (const t of ordered) {
      if (currentMs >= t.startMs) active = t.turnIndex;
      else break;
    }
    return active;
  }, [ordered, currentMs]);

  // Keep the active line in view, unless the reader has scrolled away.
  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    document
      .getElementById(`turn-${activeIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex, follow]);

  const seekTo = (turnIndex: number) => {
    const t = ordered.find((x) => x.turnIndex === turnIndex);
    const audio = audioRef.current;
    if (!t || !audio) return;
    audio.currentTime = t.startMs / 1000;
    setCurrentMs(t.startMs);
    void audio.play();
  };

  return (
    <>
      <div className="player">
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
          onSeeked={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
        />
        <div className="meta">
          <span>
            <b>{turns.length}</b> turns
          </span>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            follow along
          </label>
          <span style={{ color: "var(--faint)" }}>click any line to jump</span>
        </div>
      </div>

      <div>
        {turns.map((turn, i) => {
          const timing = ordered.find((t) => t.turnIndex === i);
          const isActive = i === activeIndex;
          const isPast = timing ? currentMs > timing.endMs : false;
          return (
            <div
              key={i}
              id={`turn-${i}`}
              className={`turn${isActive ? " active" : ""}${isPast && !isActive ? " past" : ""}`}
              data-speaker={turn.speaker}
              onClick={() => seekTo(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  seekTo(i);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className="who">{turn.speaker}</span>
              <p>{turn.text}</p>
              {(() => {
                const c = citationFor.get(i);
                if (!c) return null;
                const pages =
                  c.pageEnd && c.pageEnd !== c.page
                    ? `pp. ${c.page}–${c.pageEnd}`
                    : `p. ${c.page}`;
                return (
                  <p
                    className="cite"
                    // The passage itself, so a reader can check the reference
                    // without leaving the page.
                    title={c.text}
                  >
                    {c.heading} · {pages}
                    {c.match === "approximate" && <span className="cite-approx"> ≈</span>}
                  </p>
                );
              })()}
            </div>
          );
        })}
      </div>
    </>
  );
}
