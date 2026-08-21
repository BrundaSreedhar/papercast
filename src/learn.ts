#!/usr/bin/env node
/**
 * The study ledger: what has been covered, and what is left.
 *
 *   npm run learn                              # show the ledger
 *   npm run learn -- record paper.episode.json --paper aurora.pdf
 *
 * Recording takes an episode that has already been generated, so a history can
 * be built from past runs without regenerating or re-paying for anything.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractPaper } from "../lib/pdf/extract";
import { EpisodeSchema } from "../lib/llm/schema";
import {
  loadLedger,
  openGaps,
  recordEpisode,
  saveLedger,
  suggestedReadings,
  summarize,
  ledgerPath,
} from "../lib/learning/index";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function mmss(ms: number): string {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

async function record() {
  const episodePath = process.argv[3];
  const paperPath = arg("--paper");
  if (!episodePath || !paperPath) {
    console.error("Usage: npm run learn -- record <episode.json> --paper <paper.pdf> [--timings <file>]");
    process.exit(1);
  }

  const rawEpisode = JSON.parse(await readFile(episodePath, "utf8"));
  const episode = EpisodeSchema.parse(rawEpisode.episode ?? rawEpisode);
  const pdf = await readFile(paperPath);
  const paper = await extractPaper(pdf);
  const paperId = basename(paperPath).replace(/\.pdf$/i, "").toLowerCase();

  const timingsPath = arg("--timings");
  const timings = timingsPath
    ? JSON.parse(await readFile(timingsPath, "utf8")).turns
    : undefined;

  const ledger = recordEpisode(await loadLedger(), {
    paperId,
    paper,
    episode,
    provider: rawEpisode.provider ?? "unknown",
    model: rawEpisode.model ?? "unknown",
    minutes: Number(arg("--minutes") ?? 4),
    timings,
  });
  await saveLedger(ledger);

  const rec = ledger.papers[paperId]!;
  console.log(`\n📓  Recorded "${rec.title}"`);
  console.log(`    ${rec.learned.length} things learnt · ${rec.references.length} references captured`);
  console.log(`    → ${ledgerPath()}\n`);
}

async function show() {
  const ledger = await loadLedger();
  const s = summarize(ledger);

  if (s.papers === 0) {
    console.log(`\n📓  Nothing recorded yet — ${ledgerPath()} is empty.`);
    console.log(`    npm run learn -- record <episode.json> --paper <paper.pdf>\n`);
    return;
  }

  console.log(`\n📓  ${s.papers} paper(s) · ${s.episodes} episode(s) · ${s.learned} things learnt (${s.verified} verified)\n`);

  for (const p of Object.values(ledger.papers)) {
    console.log(`── ${p.title}`);
    console.log(`   studied ${p.episodes.length}× · last ${p.lastStudied.slice(0, 10)}`);
    for (const item of p.learned.slice(0, 4)) {
      const at = item.startMs !== undefined ? ` [${mmss(item.startMs)}]` : "";
      const mark = item.provenance === "verified" ? "✓" : "·";
      console.log(`   ${mark}${at} ${item.text.slice(0, 88)}`);
    }
    if (p.learned.length > 4) console.log(`     … ${p.learned.length - 4} more`);
    console.log();
  }

  const gaps = openGaps(ledger);
  if (gaps.length) {
    console.log(`🕳  Not yet covered — annotated contributions no episode conveyed:\n`);
    for (const g of gaps) console.log(`   ${g.paperTitle}: ${g.contribution}`);
    console.log();
  }

  const next = suggestedReadings(ledger, 6);
  if (next.length) {
    console.log(`📚  Read next — cited by the papers you have studied:\n`);
    for (const r of next) {
      const cites = r.citations > 1 ? ` (cited by ${r.citations})` : "";
      console.log(`   ${r.year ?? "----"}  ${r.title.slice(0, 76)}${cites}`);
    }
    console.log();
  }
}

const cmd = process.argv[2];
(cmd === "record" ? record() : show()).catch((err) => {
  console.error("\n❌  Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
