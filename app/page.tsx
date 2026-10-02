"use client";

import Link from "next/link";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TranscriptPlayer,
  type Citation,
  type Timing,
  type Turn,
} from "./components/TranscriptPlayer";
import { PaperChat } from "./components/PaperChat";
import { EpisodeSummary } from "./components/EpisodeSummary";

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

const FORMAT_LABEL: Record<string, string> = {
  dialogue: "two hosts",
  solo: "solo",
  eli5: "explained simply",
};

/**
 * Two lengths, not a number box. A reader choosing how long an episode runs is
 * choosing what kind of listen it is, and "7 minutes" says less than "the
 * gist" or "the whole argument". Each sends the middle of its range to the
 * length budget, which already allows for runs landing a little either side.
 */
const LENGTHS = [
  {
    id: "summary",
    minutes: 5,
    label: "Summary",
    range: "4–6 min",
    blurb: "The gist, over a coffee.",
  },
  {
    id: "deep",
    minutes: 11,
    label: "Deep dive",
    range: "10–12 min",
    blurb: "The whole argument, for a long walk.",
  },
] as const;
type LengthId = (typeof LENGTHS)[number]["id"];

const FORMATS = [
  { id: "dialogue", label: "Two hosts" },
  { id: "solo", label: "Solo" },
  { id: "eli5", label: "Like I'm five" },
] as const;

/**
 * An equalizer: the wordmark's bars, grown up. It idles while nothing is
 * happening, jumps when a paper is dragged over, and plays while an episode is
 * being made. Decoration only, so it is hidden from assistive technology, and
 * it holds still for readers who ask for reduced motion.
 */
function Equalizer({ live = false, lit = false }: { live?: boolean; lit?: boolean }) {
  return (
    <span className={`eq${live ? " live" : ""}${lit ? " lit" : ""}`} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/** Speech backends as a listener would name them. */
const VOICE_NAME: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  kokoro: "Kokoro",
  piper: "Piper",
  say: "the system voice",
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
  voice?: { provider: string; fellBackFrom?: string; why?: string };
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
type Config =
  | { demo: false }
  | { demo: true; papers: DemoPaper[]; maxMinutes: number; allowUploads?: boolean };

export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [length, setLength] = useState<LengthId>("summary");
  const [provider, setProvider] = useState("open");
  const [format, setFormat] = useState("dialogue");
  const [recent, setRecent] = useState<
    { id: string; paperTitle: string; format: string }[]
  >([]);
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
  const [covers, setCovers] = useState<{ summary: string; keyPoints: string[] } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const demo = config?.demo === true ? config : null;
  const running = progress !== null && !summary && !error;
  // Uploads may be open alongside the shelf, so either way in counts.
  const canUpload = !demo || demo.allowUploads === true;
  const ready = file !== null || (demo !== null && paperId !== null);

  useEffect(() => {
    // A failed config request means the local build, which is the mode with
    // fewer restrictions — so it degrades toward the drop zone rather than
    // toward a page with nothing on it.
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ demo: false }));
  }, []);

  // The public demo caps episode length; a deep dive it cannot make is not offered.
  const deepAllowed = !demo || demo.maxMinutes >= 10;
  useEffect(() => {
    if (!deepAllowed) setLength("summary");
  }, [deepAllowed]);
  const minutes = LENGTHS.find((l) => l.id === length)!.minutes;

  // The shelf, so someone returning lands on what they already made rather than
  // an empty form. Failing quietly: this is a convenience, not the page.
  useEffect(() => {
    void fetch("/api/library")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const start = useCallback(async () => {
    if (!ready) return;
    setError(null);
    setSummary(null);
    setTurns([]);
    setCitations([]);
    setCovers(null);
    setProgress({ stage: "queued", percent: 0, message: "Starting" });

    const body = new FormData();
    // A dropped file wins: it is the more deliberate act of the two, and the
    // shelf selection may just be left over from before they dropped it.
    if (file) body.set("pdf", file);
    else if (demo) body.set("paper", paperId ?? "");
    body.set("minutes", String(minutes));
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
      setCovers({
        summary: t.episode.summary ?? "",
        keyPoints: t.episode.keyPoints ?? [],
      });
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
          voice: job.result?.voice,
        });
        await loadTranscript();
      }
    };

    const poll = setInterval(() => void reconcile(), 8000);
    // Deliberately not closing: EventSource reconnects on its own, and the
    // reconcile covers the case where the job ended while it was disconnected.
    source.onerror = () => void reconcile();
  }, [demo, ready, file, paperId, minutes, provider, format]);

  // Only show the stages a run from this page passes through, so the stepper
  // matches the progress bar instead of stranding a step that never runs. The
  // page no longer offers the fact-check or the audio verification, so neither
  // stage is shown; both remain available to the CLI and the API.
  const shownStages: (typeof STAGES)[number][] = STAGES.filter(
    (s) => s !== "reviewing" && s !== "verifying",
  );
  const stageIndex = progress
    ? shownStages.indexOf(progress.stage as (typeof STAGES)[number])
    : -1;

  return (
    <main className="wrap">
      {summary ? (
        <>
          <h1>{summary.paperTitle ?? "Your episode"}</h1>
          <p className="sub">
            {FORMAT_LABEL[format] ?? format}
            {summary.totalMs ? ` · ${Math.round(summary.totalMs / 60000)} min` : ""}
          </p>
        </>
      ) : running ? (
        <>
          <h1>Making your episode</h1>
          <p className="sub">
            {file ? file.name : "Your paper"}, as a{" "}
            {length === "deep" ? "deep dive" : "summary"}. You can leave this page open
            and come back.
          </p>
        </>
      ) : (
        <>
          <h1>Hear what the paper says</h1>
          <p className="sub">
            Drop in a PDF and get an episode that sticks to what the paper actually says.
          </p>
        </>
      )}

      {!running && !summary && (
        <p className="pitch">
          <span>Every line traced to its page</span>
          <span>Ask the paper questions, by voice or text</span>
          <span>Also runs locally</span>
        </p>
      )}

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
                {demo.allowUploads ? (
                  <>
                    Pick one of these, or drop in a paper of your own below. This is a
                    public demo, so it makes {demo.maxMinutes} minutes at a time, one
                    episode at a time, and a limited number a day. Clone the repository to
                    run it without any of that.
                  </>
                ) : (
                  <>
                    This is a public demo, so it runs a fixed shelf of papers rather than
                    accepting uploads. A link anyone can open should not be able to spend
                    an API key on an arbitrary file. It makes {demo.maxMinutes} minutes at
                    a time, one episode at a time. Run it on your own PDF by cloning the
                    repository, where none of that applies.
                  </>
                )}
              </p>
            </>
          ) : null}

          {canUpload && (
            <>
              <div
                className={`drop${over ? " over" : ""}${file ? " loaded" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
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
                <Equalizer live={over} lit={file !== null} />
                <span className="drop-text">
                  <strong>
                    {file ? file.name : over ? "Let go" : "Drop a paper here"}
                  </strong>
                  <span>
                    {file
                      ? `${(file.size / 1048576).toFixed(1)} MB · ready when you are`
                      : "or click to choose a PDF"}
                  </span>
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

          <fieldset className="lengths">
            <legend>How long</legend>
            {LENGTHS.map((l) => {
              const off = l.id === "deep" && !deepAllowed;
              return (
                <label
                  key={l.id}
                  className={`length${length === l.id ? " chosen" : ""}${off ? " off" : ""}`}
                >
                  <input
                    type="radio"
                    name="length"
                    value={l.id}
                    checked={length === l.id}
                    disabled={off}
                    onChange={() => setLength(l.id)}
                  />
                  <strong>{l.label}</strong>
                  <span className="range">{l.range}</span>
                  <em>{off ? "Not in the public demo." : l.blurb}</em>
                </label>
              );
            })}
          </fieldset>

          <div className="controls">
            <fieldset className="segmented">
              <legend className="visually-hidden">Format</legend>
              {FORMATS.map((f) => (
                <label key={f.id} className={format === f.id ? "chosen" : ""}>
                  <input
                    type="radio"
                    name="format"
                    value={f.id}
                    checked={format === f.id}
                    onChange={() => setFormat(f.id)}
                  />
                  {f.label}
                </label>
              ))}
            </fieldset>
            {!demo && (
              <label className="model">
                Model
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="open">local (free)</option>
                  <option value="anthropic">Claude</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
            )}
          </div>

          <button className="record" onClick={start} disabled={!ready}>
            <i className="rec-light" aria-hidden="true" />
            Record the episode
          </button>
        </section>
      )}

      {progress && !summary && (
        <section className="card on-air" style={{ marginTop: "1.5rem" }}>
          <div className="on-air-head">
            <Equalizer live lit />
            <span>On air</span>
          </div>
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

      {!running && !summary && recent.length > 0 && (
        <section className="recent">
          <h2 className="section-label">Pick up where you left off</h2>
          <ul>
            {recent.slice(0, 4).map((e) => (
              <li key={e.id}>
                <Link href={`/library/${e.id}`}>{e.paperTitle}</Link>
                <span>{FORMAT_LABEL[e.format] ?? e.format}</span>
              </li>
            ))}
          </ul>
          {recent.length > 4 && (
            <p className="note" style={{ marginTop: "0.6rem" }}>
              <Link href="/library">All {recent.length} episodes →</Link>
            </p>
          )}
        </section>
      )}

      {error && (
        <section className="err" style={{ marginTop: "1.5rem" }}>
          <strong>
            {error.failedStage
              ? `That didn't work. It failed while ${lowerFirst(STAGE_LABELS[error.failedStage] ?? error.failedStage)}`
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
          {summary.voice?.fellBackFrom && (
            // A listener hears the backup voice at once; they should not have
            // to guess why the episode sounds flatter than the last one.
            <p className="voice-note">
              Recorded with the local voice because{" "}
              {VOICE_NAME[summary.voice.fellBackFrom] ?? summary.voice.fellBackFrom}{" "}
              {summary.voice.why ?? "was unavailable"}. New episodes use{" "}
              {VOICE_NAME[summary.voice.fellBackFrom] ?? summary.voice.fellBackFrom} again
              once it is back.
            </p>
          )}

          {covers && (
            <EpisodeSummary summary={covers.summary} keyPoints={covers.keyPoints} />
          )}

          {jobId && turns.length > 0 && (
            <>
              {/*
                The job id is the episode's id — the record is filed under it
                when the job finishes — so everything the library page offers
                works here the moment the episode exists. Without this a
                listener had to find their way to the library to ask anything
                about what they had just made.
              */}
              <TranscriptPlayer
                audioUrl={`/api/jobs/${jobId}/audio`}
                turns={turns}
                timings={timings}
                citations={citations}
                episodeId={jobId}
              />
              <PaperChat
                episodeId={jobId}
                paperTitle={summary?.paperTitle ?? "this paper"}
              />
            </>
          )}
        </section>
      )}
    </main>
  );
}
