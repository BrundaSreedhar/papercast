#!/usr/bin/env node
/**
 * Name the key concepts of episodes already on the shelf.
 *
 *   npm run concepts                          # episodes that have none yet
 *   npm run concepts -- --force               # every episode, replacing what is there
 *   npm run concepts -- --provider open       # with a particular provider
 *   npm run concepts -- --dry-run             # print, do not save
 *
 * New episodes get concepts and their relations as they are made. This is for
 * the ones made before that, which otherwise stay on the lexical fallback, and
 * for ones named before relations existed. One call per paper: two
 * episodes of the same paper share the result rather than paying twice.
 */
import { activeProvider, type ProviderName } from "../lib/config/env";
import { getProvider } from "../lib/llm/index";
import { getEpisode, listEpisodes, saveEpisode } from "../lib/library/store";
import {
  extractConcepts,
  type PaperConcept,
  type PaperRelation,
} from "../lib/concepts/extract";
import { normalizeTitle } from "../lib/pdf/references";
import { runEntry } from "./entry";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  const providerName =
    (arg("--provider") as ProviderName | undefined) ?? activeProvider();
  const provider = getProvider(providerName);

  const byPaper = new Map<
    string,
    { concepts: PaperConcept[]; relations: PaperRelation[] }
  >();
  let named = 0;
  let skipped = 0;

  for (const summary of await listEpisodes()) {
    const record = await getEpisode(summary.id);
    if (!record) continue;
    if (record.concepts?.length && record.relations !== undefined && !force) {
      skipped++;
      continue;
    }

    const key = normalizeTitle(record.paperTitle) || record.id;
    let found = byPaper.get(key);
    if (!found) {
      process.stdout.write(`🧠  ${record.paperTitle} … `);
      const result = await extractConcepts(record.paper, provider);
      found = { concepts: result.concepts, relations: result.relations };
      byPaper.set(key, found);
      const { concepts, relations } = found;
      console.log(
        `${concepts.length} concepts` +
          (result.dropped.length
            ? ` (dropped, not in the paper: ${result.dropped.join(", ")})`
            : ""),
      );
      for (const c of concepts) {
        const where = c.evidence?.page ? ` p.${c.evidence.page}` : "";
        console.log(`    ${c.importance.padEnd(10)} ${c.name}${where} — ${c.definition}`);
      }
      console.log(
        `  ${relations.length} relations` +
          (result.droppedRelations
            ? ` (${result.droppedRelations} dropped, unquotable or off-list)`
            : ""),
      );
      for (const r of relations) {
        const where = r.evidence.page ? ` p.${r.evidence.page}` : "";
        console.log(`    ${r.source} —${r.type}→ ${r.target}${where}`);
      }
    } else {
      console.log(
        `🧠  ${record.paperTitle} (${record.id}) … reusing this paper's concepts`,
      );
    }

    if (!dryRun) await saveEpisode({ ...record, ...found });
    named++;
  }

  console.log(
    `\n${dryRun ? "Would name" : "Named"} concepts for ${named} episode${named === 1 ? "" : "s"}` +
      ` with ${provider.name} (${provider.model})` +
      (skipped ? `; ${skipped} already had them (use --force to redo).` : "."),
  );
}

runEntry(main);
