import Link from "next/link";
import { getEpisode, listEpisodes } from "@/lib/library/store";
import { paperToText } from "@/lib/pdf/extract";
import { buildConceptMap, conceptsFor, sharedConcepts } from "@/lib/concepts/index";
import { ConceptGraph } from "@/app/components/ConceptGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the library is about, and where it joins up.
 *
 * Concepts are derived here rather than stored, because the extraction is
 * cheap, deterministic and still being tuned — a stored map would have to be
 * migrated every time the ranking improved, and would go stale the moment an
 * episode was deleted.
 */
export default async function Concepts() {
  const shelf = await listEpisodes();

  const episodes = [];
  for (const summary of shelf) {
    const record = await getEpisode(summary.id);
    if (!record) continue;
    episodes.push({
      ...summary,
      concepts: conceptsFor(record.keyPoints, record.summary, paperToText(record.paper)),
    });
  }

  const map = buildConceptMap(episodes);
  const shared = sharedConcepts(map);
  const titles = Object.fromEntries(episodes.map((e) => [e.id, e.paperTitle]));

  if (episodes.length === 0) {
    return (
      <main className="wrap">
        <h1>Concepts</h1>
        <div className="empty">
          <strong>Nothing to map yet</strong>
          <p style={{ margin: 0 }}>
            Concepts are drawn from the episodes you have made. Make one and they appear
            here.
          </p>
          <p style={{ margin: "0.9rem 0 0" }}>
            <Link href="/">Make your first one →</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>Concepts</h1>
      <p className="sub">
        {map.concepts.length} ideas across {episodes.length} episode
        {episodes.length === 1 ? "" : "s"}
        {shared.length > 0
          ? `, ${shared.length} of them shared between more than one.`
          : ". Nothing is shared between episodes yet — that needs two papers that overlap."}
      </p>

      <ConceptGraph map={map} titles={titles} />

      <section style={{ marginTop: "2rem" }}>
        <h2 className="section-label">Episodes by concept</h2>
        <ul className="concept-list">
          {map.concepts.map((c) => (
            <li key={c.term}>
              <span
                className={c.episodes.length > 1 ? "concept-term shared" : "concept-term"}
              >
                {c.term}
              </span>
              <span className="concept-episodes">
                {c.episodes.map((id, i) => (
                  <span key={id}>
                    {i > 0 && " · "}
                    <Link href={`/library/${id}`}>{titles[id] ?? id}</Link>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
