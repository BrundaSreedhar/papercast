import Link from "next/link";
import { notFound } from "next/navigation";
import { getEpisode } from "@/lib/library/store";
import { TranscriptPlayer } from "@/app/components/TranscriptPlayer";
import { PaperChat } from "@/app/components/PaperChat";

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
      <p className="sub">
        <Link href="/library">← All episodes</Link>
      </p>
      <h1>{record.paperTitle}</h1>
      <p className="sub">
        {record.turnCount} turns · {record.model ?? "unknown model"}
        {record.citations?.length
          ? ` · ${record.citations.length} traced back to the paper`
          : ""}
      </p>

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
            Transcript only — this run made no audio.
          </p>
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
