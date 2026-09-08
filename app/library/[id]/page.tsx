import Link from "next/link";
import { notFound } from "next/navigation";
import { getEpisode } from "@/lib/library/store";
import { TranscriptPlayer } from "@/app/components/TranscriptPlayer";
import { PaperChat } from "@/app/components/PaperChat";
import { VoiceAsk } from "@/app/components/VoiceAsk";
import { DeleteEpisode } from "@/app/components/DeleteEpisode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One episode: listen to it, read it, and ask the paper about it.
 *
 * The audio is a static file under `public/audio`, so it needs no route of its
 * own — the job that produced it is long gone from memory, and the recording is
 * not.
 */
export default async function Episode({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getEpisode(id).catch(() => undefined);
  if (!record) notFound();

  return (
    <main className="wrap">
      <div className="crumbs">
        <Link href="/library" className="back">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M10 3 L5 8 L10 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          All episodes
        </Link>
        <DeleteEpisode episodeId={record.id} title={record.paperTitle} />
      </div>
      <h1>{record.paperTitle}</h1>
      <p className="sub">
        {record.turnCount} turns · {record.model ?? "unknown model"}
        {record.citations?.length
          ? ` · ${record.citations.length} traced back to the paper`
          : ""}
      </p>

      {record.summary && (
        /*
         * Closed by default, and a plain <details> rather than a component with
         * state: it needs no JavaScript, it is keyboard operable for free, and
         * this page is rendered on the server. The trigger says how much is
         * behind it so opening it is a decision rather than a surprise.
         */
        <details className="card summary">
          <summary>
            <span className="summary-label">What this episode covers</span>
            <span className="summary-hint">
              {record.summary.split(/\s+/).length} words
              {record.keyPoints?.length ? ` · ${record.keyPoints.length} key points` : ""}
            </span>
          </summary>
          <p>{record.summary}</p>
          {record.keyPoints?.length > 0 && (
            <ul className="key-points">
              {record.keyPoints.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          )}
        </details>
      )}

      {record.hasAudio ? (
        <TranscriptPlayer
          audioUrl={`/audio/${record.id}.wav`}
          turns={record.episode.turns}
          timings={record.timings ?? []}
          citations={record.citations ?? []}
          episodeId={record.id}
        />
      ) : (
        <section className="card" style={{ marginTop: "1.5rem" }}>
          <p className="sub" style={{ margin: 0 }}>
            Transcript only. This run made no audio.
          </p>
          {/* Asking out loud needs a microphone, not a recording, so it works
              here too rather than being a feature of the player. */}
          <VoiceAsk episodeId={record.id} pausesPlayback={false} />
          <div style={{ marginTop: "1rem" }}>
            {record.episode.turns.map((turn, i) => {
              const cite = record.citations?.find((c) => c.turnIndex === i);
              return (
                <div key={i} className="turn" data-speaker={turn.speaker}>
                  <span className="who">{turn.speaker}</span>
                  <p>{turn.text}</p>
                  {cite && (
                    <p className="cite" title={cite.text}>
                      {cite.heading} · p. {cite.page}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <PaperChat episodeId={record.id} paperTitle={record.paperTitle} />
    </main>
  );
}
