import Link from "next/link";
import { getEpisode, listEpisodes } from "@/lib/library/store";
import { paperToText } from "@/lib/pdf/extract";
import { buildConceptMap, conceptsFor, paperKeyOf } from "@/lib/concepts/index";
import { findSimilar } from "@/lib/concepts/similar";
import { toMapConcepts, toMapRelations } from "@/lib/concepts/extract";
import {
  conceptMoments,
  momentHref,
  momentLabel,
  type EpisodeTranscript,
} from "@/lib/concepts/moments";
import { ConceptGraph } from "@/app/components/ConceptGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the library is about, and where it joins up.
 *
 * Each episode's concepts are the ones a model named when it was made, stored
 * on the record. An episode without them falls back to lexical extraction,
 * which is derived here: cheap, deterministic, and no model call on a page
 * anyone can open. The map itself is always rebuilt, so it never goes stale
 * when an episode is deleted.
 */
export default async function Concepts() {
  const shelf = await listEpisodes();

  const episodes = [];
  const transcripts: EpisodeTranscript[] = [];
  for (const summary of shelf) {
    const record = await getEpisode(summary.id);
    if (!record) continue;
    transcripts.push({
      id: record.id,
      turns: record.episode.turns,
      timings: record.timings,
    });
    episodes.push({
      ...summary,
      concepts: record.concepts?.length
        ? toMapConcepts(record.concepts)
        : conceptsFor(
            record.keyPoints,
            record.summary,
            paperToText(record.paper),
            record.paper.sections.map((section) => section.heading),
          ),
      relations: record.concepts?.length ? toMapRelations(record.relations ?? []) : [],
    });
  }

  const map = buildConceptMap(episodes);
  // Where each concept and relation is spoken, so every node leads to audio.
  const moments = conceptMoments(map, transcripts);
  // Related-but-not-identical links, when a local embedding model is available
  // to find them. Absent silently when it is not: the map is still the map.
  // Run over the map's own concepts, which carry the library-wide names the
  // nodes are keyed on, so a pair always lands on two drawn nodes.
  const similar = await findSimilar(Object.values(map.byEpisode).flat()).catch(() => []);
  // Two ideas an episode already covers together are joined by a solid line, and
  // a dashed one over the top says nothing new. What is worth drawing is the
  // pair no episode covers together: that is the link a shared word could never
  // have found.
  const joined = new Set([
    ...map.edges.map((e) => `${e.a}|${e.b}`),
    ...map.relations.map((r) => `${r.source}|${r.target}`),
  ]);
  const related = similar.filter(
    (r) => !joined.has(`${r.a}|${r.b}`) && !joined.has(`${r.b}|${r.a}`),
  );
  const titles = Object.fromEntries(episodes.map((e) => [e.id, e.paperTitle]));
  // Which paper each episode is of, so the graph can colour it the way it
  // colours that paper's ideas.
  const episodePaper = Object.fromEntries(episodes.map((e) => [e.id, paperKeyOf(e)]));
  // When each concept first reached the library, so the map can say what is
  // new since the reader last looked.
  const createdAt = new Map(episodes.map((e) => [e.id, e.createdAt]));
  const firstSeen = Object.fromEntries(
    map.concepts.map((c) => [
      c.term,
      Math.min(...c.episodes.map((id) => createdAt.get(id) ?? Number.MAX_SAFE_INTEGER)),
    ]),
  );

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

      <ConceptGraph
        map={map}
        titles={titles}
        related={related}
        moments={moments}
        episodePaper={episodePaper}
        firstSeen={firstSeen}
      />

      <section style={{ marginTop: "2rem" }}>
        <h2 className="section-label">Episodes by concept</h2>
        <ul className="concept-list">
          {map.concepts.map((c) => (
            <li key={c.term}>
              <span
                className={c.papers.length > 1 ? "concept-term shared" : "concept-term"}
                title={c.definition}
              >
                {c.label}
              </span>
              <span className="concept-episodes">
                {c.episodes.map((id, i) => {
                  // Straight to where it is first said, when it is said at all.
                  const first = moments.byConcept[c.term]?.find(
                    (m) => m.episodeId === id,
                  );
                  return (
                    <span key={id}>
                      {i > 0 && " · "}
                      <Link href={`/library/${id}`}>{titles[id] ?? id}</Link>
                      {first && (
                        <>
                          {" "}
                          <Link
                            href={momentHref(id, first.turnIndex)}
                            className="moment"
                            title={first.snippet}
                          >
                            ▶ {momentLabel(first)}
                          </Link>
                        </>
                      )}
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
