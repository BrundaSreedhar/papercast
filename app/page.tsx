"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TranscriptPlayer,
  type Citation,
  type Timing,
  type Turn,
} from "./components/TranscriptPlayer";

const STAGES = [
  "parsing",
  "scripting",
  "reviewing",
  "synthesizing",
  "verifying",
] as const;
const STAGE_LABELS: Record<string, string> = {
  parsing: "Reading the paper",
  scripting: "Writing the episode",
  reviewing: "Fact-checking it against the paper",
  synthesizing: "Recording it",
  verifying: "Checking the audio against the script",
};

/** "Reading the paper" reads as a heading; mid-sentence it needs a small letter. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface Progress {
  stage: string;
  percent: number;
  message: string;
}
interface Review {
  faithfulnessBefore: number;
  faithfulnessAfter: number;
  failuresBefore: number;
  failuresAfter: number;
  revisedTurns: number[];
  improved: boolean;
}
interface Summary {
  paperTitle?: string;
  totalMs?: number;
  transcriptRecall?: number;
  review?: Review;
  reviewError?: { message: string };
  cost?: {
    llmInputTokens: number;
    llmOutputTokens: number;
    ttsCalls: number;
    usd?: number;
  };
}
interface DemoPaper {
  id: string;
  title: string;
  authors: string;
  year: number;
  note: string;
}
/**
 * What this deployment allows. Uploads locally, a fixed shelf publicly — the
 * page asks rather than assuming, because it is the same build either way.
 */
type Config = { demo: false } | { demo: true; papers: DemoPaper[]; maxMinutes: number };

export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(4);
  const [verify, setVerify] = useState(false);
  const [revise, setRevise] = useState(false);
  const [provider, setProvider] = useState("open");
  const [format, setFormat] = useState("dialogue");
  const [over, setOver] = useState(false);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{
    message: string;
    remedy?: string;
    failedStage?: string;
    ref?: string;
  } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [timings, setTimings] = useState<Timing[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const demo = config?.demo === true ? config : null;
  const running = progress !== null && !summary && !error;
  const ready = demo ? paperId !== null : file !== null;

  useEffect(() => {
    // A failed config request means the local build, which is the mode with
    // fewer restrictions — so it degrades toward the drop zone rather than
    // toward a page with nothing on it.
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ demo: false }));
  }, []);

  useEffect(() => {
    if (demo) setMinutes((m) => Math.min(m, demo.maxMinutes));
  }, [demo]);

  const start = useCallback(async () => {
    if (!ready) return;
    setError(null);
    setSummary(null);
    setTurns([]);
    setCitations([]);
    setProgress({ stage: "queued", percent: 0, message: "Starting" });

    const body = new FormData();
    if (demo) body.set("paper", paperId ?? "");
    else if (file) body.set("pdf", file);
    body.set("minutes", String(minutes));
    body.set("verify", String(verify));
    body.set("revise", String(revise));
    body.set("format", format);
    if (!demo) body.set("provider", provider);

    const res = await fetch("/api/jobs", { method: "POST", body });
    if (!res.ok) {
      setProgress(null);
      // A refusal carries a remedy — which limit was hit, and when to come
      // back — and dropping it would leave the page looking broken.
      const failed = await res.json().catch(() => ({}));
      setError({
        message: failed.error ?? "Could not start the job.",
        remedy: failed.remedy,
      });
      return;
    }
    const { id } = await res.json();
    setJobId(id);

    // Server-sent events carry progress, because the server already knows when
    // something changed and a job emits an event for every turn it records.
    //
    // But the stream is an optimization, not the truth. EventSource fires
    // `onerror` on any transient drop — a dev-server recompile, a proxy idle
    // timeout — and closing it there left the page showing the last progress it
    // happened to see. A job that then failed never reached the browser at all,
    // so the page sat claiming to be working on an episode that had already
    // died. The job record is authoritative, so a poll runs alongside the
    // stream and reconciles against it.
    let settled = false;
    const source = new EventSource(`/api/jobs/${id}/stream`);

    // Declared as a function so it can be referenced by the handlers below and
    // still close over the poll timer created after them.
    function stop() {
      settled = true;
      source.close();
      clearInterval(poll);
    }

    const loadTranscript = async () => {
      const t = await fetch(`/api/jobs/${id}/transcript`).then((r) => r.json());
      setTurns(t.episode.turns);
      setTimings(t.timings ?? []);
      setCitations(t.citations ?? []);
    };

    source.addEventListener("progress", (e) => {
      if (!settled) setProgress(JSON.parse(e.data));
    });
    source.addEventListener("failed", (e) => {
      if (settled) return;
      stop();
      setError(JSON.parse(e.data));
      setProgress(null);
    });
    source.addEventListener("done", async (e) => {
      if (settled) return;
      stop();
      setSummary(JSON.parse(e.data));
      await loadTranscript();
    });

    /** Ask the server what actually happened, rather than trusting the stream. */
    const reconcile = async () => {
      if (settled) return;
      const job = await fetch(`/api/jobs/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!job || settled) return;

      if (job.stage === "error") {
        stop();
        setError(
          job.error ?? { message: "The episode failed, and the server gave no reason." },
        );
        setProgress(null);
      } else if (job.stage === "done") {
        stop();
        setSummary({
          paperTitle: job.paperTitle,
          totalMs: job.result?.totalMs,
          transcriptRecall: job.result?.transcriptRecall,
          review: job.result?.review,
          reviewError: job.result?.reviewError,
          cost: job.cost,
        });
        await loadTranscript();
      }
    };

    const poll = setInterval(() => void reconcile(), 8000);
    // Deliberately not closing: EventSource reconnects on its own, and the
    // reconcile covers the case where the job ended while it was disconnected.
    source.onerror = () => void reconcile();
  }, [demo, ready, file, paperId, minutes, verify, revise, provider, format]);

  // Only show the stages this run will actually pass through, so the stepper
  // matches the progress bar instead of stranding a step that never runs.
  const shownStages = STAGES.filter(
    (s) => (s !== "reviewing" || revise) && (s !== "verifying" || verify),
  );
  const stageIndex = progress
    ? shownStages.indexOf(progress.stage as (typeof STAGES)[number])
    : -1;

  return (
    <main className="wrap">
      <h1>PaperCast</h1>
      <p className="sub">
        A paper in, an episode out — saying only what the paper says.{" "}
        <Link href="/library">Library →</Link>
      </p>

      {!running && !summary && (
        <section>
          {demo ? (
            <>
              <div className="papers">
                {demo.papers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`paper${paperId === p.id ? " chosen" : ""}`}
                    onClick={() => setPaperId(p.id)}
                    aria-pressed={paperId === p.id}
                  >
                    <strong>{p.title}</strong>
                    <span className="who-wrote">
                      {p.authors}, {p.year}
                    </span>
                    <span>{p.note}</span>
                  </button>
                ))}
              </div>
              <p className="note">
                This is a public demo, so it runs a fixed shelf of papers rather than
                accepting uploads — a link anyone can open should not be able to spend an
                API key on an arbitrary file. It makes {demo.maxMinutes} minutes at a
                time, one episode at a time. Run it on your own PDF by cloning the
                repository, where none of that applies.
              </p>
            </>
          ) : (
            <>
              <div
                className={`drop${over ? " over" : ""}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  const f = e.dataTransfer.files[0];
                  if (f?.type === "application/pdf") setFile(f);
                }}
              >
                <strong>{file ? file.name : "Drop a paper here"}</strong>
                <span>
                  {file
                    ? `${(file.size / 1048576).toFixed(1)} MB`
                    : "or click to choose a PDF"}
                </span>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </>
          )}

          <div className="controls">
            <label>
              Length
              <input
                type="number"
                min={1}
                max={demo ? demo.maxMinutes : 20}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                style={{ width: "4rem" }}
              />
              min
            </label>
            {!demo && (
              <label>
                Model
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="open">local (free)</option>
                  <option value="anthropic">Claude</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
            )}
            <label>
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="dialogue">two hosts</option>
                <option value="solo">solo</option>
                <option value="eli5">explain like I&apos;m 5</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={revise}
                onChange={(e) => setRevise(e.target.checked)}
              />
              fact-check and repair the script
            </label>
            {/* Verification transcribes the audio back with whisper.cpp, which
                the deployed image does not carry. */}
            {!demo && (
              <label>
                <input
                  type="checkbox"
                  checked={verify}
                  onChange={(e) => setVerify(e.target.checked)}
                />
                verify the audio afterwards
              </label>
            )}
            <button onClick={start} disabled={!ready}>
              Make the episode
            </button>
          </div>
        </section>
      )}

      {progress && !summary && (
        <section className="card" style={{ marginTop: "1.5rem" }}>
          <div className="stages">
            {shownStages.map((s, i) => (
              <div
                key={s}
                className={`stage${i === stageIndex ? " active" : ""}${i < stageIndex ? " complete" : ""}`}
              >
                <span className="dot" />
                {i === stageIndex ? progress.message : STAGE_LABELS[s]}
              </div>
            ))}
          </div>
          <div className="bar">
            <i style={{ width: `${progress.percent}%` }} />
          </div>
        </section>
      )}

      {error && (
        <section className="err" style={{ marginTop: "1.5rem" }}>
          <strong>
            {error.failedStage
              ? `That didn't work — it failed while ${lowerFirst(STAGE_LABELS[error.failedStage] ?? error.failedStage)}`
              : "That didn't work"}
          </strong>
          {error.message}
          {error.remedy && (
            <div style={{ marginTop: "0.4rem", color: "var(--muted)" }}>
              {error.remedy}
            </div>
          )}
          {error.ref && (
            <div
              style={{ marginTop: "0.4rem", color: "var(--muted)", fontSize: "0.85em" }}
            >
              Server log reference: <code>{error.ref}</code>
            </div>
          )}
        </section>
      )}

      {summary && (
        <section style={{ marginTop: "1.5rem" }}>
          {summary.paperTitle && (
            <p className="sub" style={{ marginBottom: "1rem" }}>
              {summary.paperTitle}
            </p>
          )}
          <div className="meta" style={{ marginBottom: "1rem" }}>
            {summary.totalMs && (
              <span>
                <b>
                  {Math.floor(summary.totalMs / 60000)}:
                  {String(Math.round((summary.totalMs % 60000) / 1000)).padStart(2, "0")}
                </b>{" "}
                long
              </span>
            )}
            {summary.transcriptRecall !== undefined && (
              <span>
                <b>{Math.round(summary.transcriptRecall * 100)}%</b> of the script
                verified in the audio
              </span>
            )}
            {summary.reviewError && (
              <span title={summary.reviewError.message}>
                <b>unchecked</b> — the fact-check did not run
              </span>
            )}
            {summary.review && (
              <span>
                <b>{Math.round(summary.review.faithfulnessAfter * 100)}%</b> of claims
                trace to the paper
                {summary.review.improved &&
                  ` · repaired ${summary.review.revisedTurns.length} turns`}
              </span>
            )}
            {summary.cost?.usd !== undefined && (
              <span>
                <b>${summary.cost.usd.toFixed(3)}</b>
              </span>
            )}
            <button
              className="ghost"
              onClick={() => {
                setSummary(null);
                setProgress(null);
                setFile(null);
                setPaperId(null);
              }}
            >
              New episode
            </button>
          </div>

          {jobId && turns.length > 0 && (
            <TranscriptPlayer
              audioUrl={`/api/jobs/${jobId}/audio`}
              turns={turns}
              timings={timings}
              citations={citations}
            />
          )}
        </section>
      )}
    </main>
  );
}
