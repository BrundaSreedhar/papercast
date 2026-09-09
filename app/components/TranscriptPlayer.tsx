"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceAsk } from "./VoiceAsk";

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
/** mm:ss, which is the only shape an episode's length ever needs. */
function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function TranscriptPlayer({
  audioUrl,
  turns,
  timings,
  citations = [],
  episodeId,
}: {
  audioUrl: string;
  turns: Turn[];
  timings: Timing[];
  citations?: Citation[];
  /** Enables asking a question out loud, which pauses and resumes playback. */
  episodeId?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
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

  /*
   * Read the duration on mount as well as from the event.
   *
   * With `preload="metadata"` the browser often has it before React attaches a
   * listener, so `loadedmetadata` has already fired and never fires again. The
   * symptom is a scrubber whose maximum stays at zero: the thumb pins to the
   * far right on the first tick and the remaining time never counts down.
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState >= 1 && Number.isFinite(audio.duration)) {
      setDurationMs(audio.duration * 1000);
    }
    setPlaying(!audio.paused);
  }, [audioUrl]);

  // Keep the active line in view, unless the reader has scrolled away.
  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    document
      .getElementById(`turn-${activeIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex, follow]);

  /**
   * Pause for a spoken question, and pick up exactly where it left off.
   *
   * Resuming only if the episode was actually playing: a listener who paused,
   * thought, then asked something does not expect the answer to start the
   * episode up on its own.
   */
  const wasPlaying = useRef(false);
  /** Pauses, and reports whether there was anything to pause. */
  const pauseForQuestion = () => {
    const audio = audioRef.current;
    if (!audio) return false;
    wasPlaying.current = !audio.paused;
    audio.pause();
    return wasPlaying.current;
  };
  const resumeAfterQuestion = () => {
    const audio = audioRef.current;
    if (!audio || !wasPlaying.current) return;
    wasPlaying.current = false;
    void audio.play().catch(() => {
      /* the listener can press play themselves */
    });
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };

  const scrub = (ms: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = ms / 1000;
    // Set locally too: timeupdate does not fire while paused, and a scrubber
    // that does not move under the pointer feels broken.
    setCurrentMs(ms);
  };

  const progress = durationMs > 0 ? Math.min(100, (currentMs / durationMs) * 100) : 0;

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
          preload="metadata"
          onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
          onSeeked={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(e) => setDurationMs(e.currentTarget.duration * 1000)}
          onDurationChange={(e) => setDurationMs(e.currentTarget.duration * 1000)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        <div className="transport">
          <button
            type="button"
            className="play"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <rect
                  x="3.5"
                  y="2.5"
                  width="3.5"
                  height="11"
                  rx="1"
                  fill="currentColor"
                />
                <rect x="9" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M4 2.6 L13 8 L4 13.4 Z" fill="currentColor" />
              </svg>
            )}
          </button>

          <span className="clock">{clock(currentMs)}</span>

          {/*
            A range input rather than a div with a drag handler: it is draggable
            with a mouse, steppable with arrow keys, and announced as a slider,
            none of which comes free from a styled div. The turn marks sit
            behind it, so the bar shows the shape of the conversation rather
            than an undifferentiated line.
          */}
          <div className="scrub">
            <div className="ticks" aria-hidden="true">
              {durationMs > 0 &&
                ordered.map((t) => (
                  <i
                    key={t.turnIndex}
                    style={{ left: `${(t.startMs / durationMs) * 100}%` }}
                  />
                ))}
            </div>
            <div
              className="filled"
              aria-hidden="true"
              style={{ width: `${progress}%` }}
            />
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.round(durationMs))}
              value={Math.min(currentMs, durationMs || currentMs)}
              onChange={(e) => scrub(Number(e.target.value))}
              aria-label="Seek within the episode"
              aria-valuetext={`${clock(currentMs)} of ${clock(durationMs)}`}
            />
          </div>

          <span className="clock remaining">
            −{clock(Math.max(0, durationMs - currentMs))}
          </span>

          <label className="speed">
            <span className="visually-hidden">Playback speed</span>
            <select
              value={rate}
              onChange={(e) => {
                const next = Number(e.target.value);
                setRate(next);
                if (audioRef.current) audioRef.current.playbackRate = next;
              }}
            >
              {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
        </div>

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
        {episodeId && (
          <VoiceAsk
            episodeId={episodeId}
            onPause={pauseForQuestion}
            onResume={resumeAfterQuestion}
          />
        )}
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
