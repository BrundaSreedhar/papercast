#!/usr/bin/env node
/**
 * Re-run section extraction on episodes already on the shelf.
 *
 *   npm run reparse                 # rebuild every episode's paper structure
 *   npm run reparse -- --dry-run    # show what would change, save nothing
 *
 * An episode keeps the paper structure it was made with, so improving the
 * extractor changes nothing for episodes that already exist: the agent still
 * reads their fake sections and their citations still carry junk headings.
 * Every record also keeps the extracted text with its page boundaries, so the
 * structure can be rebuilt from it — no PDF, no model, nothing re-generated.
 *
 * What depends on the structure is re-derived with it, deterministically:
 * the turn citations are re-anchored, and the pages and headings on concept
 * and relation evidence are looked up again. The script, the audio and the
 * concepts themselves are untouched.
 */
import { getEpisode, listEpisodes, saveEpisode } from "../lib/library/store";
import { parsePaperStructure, type PaperStructure } from "../lib/pdf/extract";
import { PaperLocator } from "../lib/pdf/locate";
import { groundTurns } from "../lib/ground/index";
import { runEntry } from "./entry";

/** Evidence re-found in the new structure, keeping its text. */
function relocate<E extends { text: string; page?: number; heading?: string }>(
  locator: PaperLocator,
  evidence: E,
): E {
  const hit = locator.find(evidence.text);
  return hit ? { ...evidence, page: hit.page, heading: hit.heading } : evidence;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let rebuilt = 0;
  let skipped = 0;

  for (const summary of await listEpisodes()) {
    const record = await getEpisode(summary.id);
    if (!record) continue;
    const source = record.paper.source;
    if (!source) {
      console.log(
        `–  ${record.paperTitle} (${record.id.slice(0, 8)}) has no source text; skipped`,
      );
      skipped++;
      continue;
    }

    const paper: PaperStructure = {
      ...parsePaperStructure(source.text),
      source,
      // Figure descriptions came from a vision model, not from the text, so
      // they survive a re-parse unchanged.
      ...(record.paper.figures ? { figures: record.paper.figures } : {}),
    };
    const locator = new PaperLocator(paper);
    const citations = groundTurns(record.episode, paper);
    const concepts = record.concepts?.map((c) =>
      c.evidence ? { ...c, evidence: relocate(locator, c.evidence) } : c,
    );
    const relations = record.relations?.map((r) => ({
      ...r,
      evidence: relocate(locator, r.evidence),
    }));

    const before = record.paper.sections.length;
    const after = paper.sections.length;
    console.log(
      `${after === before ? "=" : "↻"}  ${record.paperTitle.slice(0, 50)} (${record.id.slice(0, 8)}): ` +
        `${before} → ${after} sections, ${record.citations?.length ?? 0} → ${citations.length} anchored turns`,
    );

    if (!dryRun) {
      await saveEpisode({
        ...record,
        paper,
        citations,
        ...(concepts ? { concepts } : {}),
        ...(relations ? { relations } : {}),
      });
    }
    rebuilt++;
  }

  console.log(
    `\n${dryRun ? "Would rebuild" : "Rebuilt"} ${rebuilt} episode${rebuilt === 1 ? "" : "s"}` +
      (skipped ? `; ${skipped} had no source text.` : "."),
  );
}

runEntry(main);
