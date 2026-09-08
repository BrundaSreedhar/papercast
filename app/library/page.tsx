import Link from "next/link";
import { listEpisodes } from "@/lib/library/store";
import { Bars } from "@/app/components/SiteHeader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMAT_LABEL: Record<string, string> = {
  dialogue: "two hosts",
  solo: "solo",
  eli5: "for a five-year-old",
};

function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * The shelf.
 *
 * Reads the library directly rather than through the API: this renders on the
 * server, and a page fetching its own origin over HTTP to reach a function it
 * could have called is a round trip that buys nothing.
 */
export default async function Library() {
  const episodes = await listEpisodes();

  return (
    <main className="wrap">
      <h1>Library</h1>
      <p className="sub">
        {episodes.length === 0
          ? "Nothing here yet. Episodes appear once they finish."
          : `${episodes.length} episode${episodes.length === 1 ? "" : "s"}, newest first.`}
      </p>

      {episodes.length === 0 ? (
        <div className="empty">
          <Bars />
          <strong>No episodes yet</strong>
          <p style={{ margin: 0 }}>
            Everything you make lands here — with its transcript, its sources, and
            somewhere to ask the paper questions.
          </p>
          <p style={{ margin: "0.9rem 0 0" }}>
            <Link href="/">Make your first one →</Link>
          </p>
        </div>
      ) : (
        <ul className="shelf">
          {episodes.map((e) => (
            <li key={e.id}>
              <Link href={`/library/${e.id}`} className="shelf-item">
                <strong>{e.paperTitle}</strong>
                {e.summary && <span className="shelf-summary">{e.summary}</span>}
                <span className="shelf-meta">
                  {FORMAT_LABEL[e.format] ?? e.format} · {e.turnCount} turns
                  {e.totalMs
                    ? ` · ${Math.round(e.totalMs / 60000)} min`
                    : " · transcript only"}
                  {e.model ? ` · ${e.model}` : ""} · {when(e.createdAt)}
                </span>
                {e.review && (
                  <span className="shelf-score">
                    {Math.round(e.review.faithfulnessAfter * 100)}% faithful
                    {e.review.improved
                      ? ` · ${e.review.revisedTurns.length} turns repaired`
                      : ""}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
