"use client";

import { useRef, useState } from "react";
import { startRecording, type Recorder } from "./recordWav";

interface Citation {
  page: number;
  pageEnd?: number;
  heading: string;
  text: string;
  match: "exact" | "approximate";
}

interface Reply {
  question: string;
  answer: string;
  kind: "from-paper" | "background" | "not-addressed";
  grounded: boolean;
  citations: Citation[];
  audioUrl?: string;
}

type Phase = "idle" | "listening" | "thinking" | "answering";

/**
 * Asking a question out loud without stopping the episode yourself.
 *
 * The episode pauses the moment recording starts and resumes at the same
 * instant once the answer has been spoken — not at the beginning of the turn,
 * and not a second later. That is the whole feature: a listener who wonders
 * something mid-sentence should be able to ask without losing their place.
 *
 * Resuming is deliberately unconditional. It happens when the answer finishes,
 * when its audio fails to load, and when the question fails outright, because
 * the failure a listener would find hardest to forgive is being left in silence
 * with the episode stopped.
 */
export function VoiceAsk({
  episodeId,
  onPause,
  onResume,
}: {
  episodeId: string;
  /** Pause the episode. Returns nothing; the player keeps its own position. */
  onPause: () => void;
  onResume: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<{ message: string; remedy?: string } | null>(null);
  const recorder = useRef<Recorder | null>(null);
  const answerAudio = useRef<HTMLAudioElement | null>(null);

  async function begin() {
    setError(null);
    setReply(null);
    try {
      recorder.current = await startRecording();
      onPause();
      setPhase("listening");
    } catch {
      setError({
        message: "The microphone is not available.",
        remedy: "Allow microphone access for this site, then try again.",
      });
    }
  }

  async function finish() {
    const rec = recorder.current;
    if (!rec) return;
    recorder.current = null;
    setPhase("thinking");

    try {
      const wav = await rec.stop();
      const body = new FormData();
      body.set("audio", wav, "question.wav");

      const res = await fetch(`/api/library/${episodeId}/ask-voice`, {
        method: "POST",
        body,
      });
      const data = await res.json();

      if (!res.ok) {
        setError({ message: data.error ?? "That did not work.", remedy: data.remedy });
        setPhase("idle");
        onResume();
        return;
      }

      setReply(data as Reply);
      if (data.audioUrl) {
        setPhase("answering");
        const audio = new Audio(data.audioUrl);
        answerAudio.current = audio;
        const done = () => {
          setPhase("idle");
          onResume();
        };
        audio.addEventListener("ended", done, { once: true });
        audio.addEventListener("error", done, { once: true });
        await audio.play().catch(done);
      } else {
        // No spoken answer, but the text is there to read, so the episode picks
        // up rather than sitting paused behind a wall of prose.
        setPhase("idle");
        onResume();
      }
    } catch {
      setError({ message: "Could not send the question." });
      setPhase("idle");
      onResume();
    }
  }

  function skipAnswer() {
    answerAudio.current?.pause();
    answerAudio.current = null;
    setPhase("idle");
    onResume();
  }

  const label =
    phase === "listening"
      ? "Stop and ask"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "answering"
          ? "Skip answer"
          : "Ask out loud";

  return (
    <div className="voice">
      <button
        type="button"
        className={phase === "listening" ? "voice-btn recording" : "voice-btn"}
        onClick={
          phase === "idle"
            ? begin
            : phase === "listening"
              ? finish
              : phase === "answering"
                ? skipAnswer
                : undefined
        }
        disabled={phase === "thinking"}
        aria-label={label}
      >
        <span className="voice-dot" aria-hidden="true" />
        {label}
      </button>
      {phase === "listening" && (
        <span className="voice-hint">The episode is paused. Ask your question.</span>
      )}

      {error && (
        <p className="voice-error">
          {error.message}
          {error.remedy && <span className="sources"> {error.remedy}</span>}
        </p>
      )}

      {reply && (
        <div className="voice-reply">
          <p className="q">“{reply.question}”</p>
          {reply.kind === "background" && (
            <p className="kind background">General background — not from this paper</p>
          )}
          <p className="a">{reply.answer}</p>
          {reply.citations.length > 0 ? (
            <p className="sources">
              {reply.citations.map((c, i) => (
                <span key={i} title={c.text}>
                  {i > 0 && " · "}
                  {c.heading}, p.{" "}
                  {c.pageEnd && c.pageEnd !== c.page ? `${c.page}–${c.pageEnd}` : c.page}
                  {c.match === "approximate" && " ≈"}
                </span>
              ))}
            </p>
          ) : (
            reply.kind === "from-paper" && (
              <p className="sources unsupported">
                Nothing in the paper was found to support this. Treat it with suspicion.
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
