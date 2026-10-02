#!/usr/bin/env node
/**
 * Make an episode for each paper on the demo shelf, ready to be baked into the
 * deployed image.
 *
 *   npm run seed:demo -- --from-library          # stage episodes you already have
 *   npm run seed:demo -- --from-library <id>,<id>
 *
 *   npm run demo:papers                 # fetch the shelf's PDFs first
 *   npm run seed:demo                   # the papers that have no episode yet
 *   npm run seed:demo -- --force        # all of them, again
 *   npm run seed:demo -- --minutes 4 --provider gemini
 *
 * A public demo whose shelf is empty asks a visitor to spend four minutes and
 * somebody's API quota before it shows them anything, and most visitors leave
 * instead. Seeded episodes mean the link opens on something to listen to, read
 * and explore straight away, and the day's allowance is left for the visitors
 * who do want to watch one being made.
 *
 * Two ways to get them, and `--from-library` is the one to reach for first: an
 * episode already on the local shelf costs nothing to stage, since the model
 * calls were paid for when it was made. Generating fresh ones is for a shelf
 * that has none worth shipping.
 *
 * Either way they are produced here, on a laptop, rather than by the
 * deployment. That is not only about cost. The deployed container's disk is
 * ephemeral — a restart, a redeploy or a wake from sleep takes it — so an
 * episode uploaded to the running site would survive exactly until the next
 * one of those. An episode baked into the image survives all of them.
 *
 * Output goes to `demo/seed/`, which the Dockerfile copies into the image. It
 * is deliberately not committed — three episodes of WAV is tens of megabytes,
 * and the repository has no business carrying audio that can be rebuilt with
 * one command.
 *
 * The staged records are renamed to the paper's own id, so re-seeding replaces
 * an episode rather than piling a second copy of the same paper beside it.
 */
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCatalogue, paperPath, type DemoPaper } from "../lib/demo/index";
import { MemoryJobStore } from "../lib/jobs/store";
import { runJob } from "../lib/jobs/pipeline";
import { getEpisode, listEpisodes } from "../lib/library/store";
import { activeProvider, demoConfig, type ProviderName } from "../lib/config/env";
import type { EpisodeFormat } from "../lib/llm/generateEpisode";
import type { TTSProviderName } from "../lib/tts/index";
import { runEntry } from "./entry";

const SEED_DIR = join(process.cwd(), "demo", "seed");
const SEED_EPISODES = join(SEED_DIR, "episodes");
const SEED_AUDIO = join(SEED_DIR, "audio");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const AUDIO_DIR = join(process.cwd(), "public", "audio");

/**
 * A filename-safe name for an episode taken from the local shelf.
 *
 * It becomes the record's id, which is also the URL the library page serves it
 * at and the stem of its `.wav`, so it has to satisfy the store's id rule. A
 * title is used rather than the original uuid because the deployed shelf reads
 * better as `/library/purpcode-reasoning-for-safer-code` than as a uuid, and
 * because a stable name means re-staging replaces rather than duplicates.
 */
function slugFor(title: string, format: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "episode";
  // Two formats of the same paper are two episodes, and would otherwise
  // overwrite each other.
  return `${base}-${format}`;
}

/**
 * Stage episodes that already exist on the local shelf.
 *
 * Nothing is generated and no provider is called: the record is copied with a
 * new id and its recording is copied beside it. An episode with no audio is
 * refused rather than staged, because a deployed shelf whose player 404s is
 * worse than a shelf with one fewer thing on it.
 */
async function stageFromLibrary(ids: string[]): Promise<number> {
  await mkdir(SEED_EPISODES, { recursive: true });
  await mkdir(SEED_AUDIO, { recursive: true });

  let staged = 0;
  for (const id of ids) {
    const record = await getEpisode(id).catch(() => undefined);
    if (!record) {
      console.error(`   ✗ ${id} — no such episode on the local shelf`);
      continue;
    }

    const wav = join(AUDIO_DIR, `${record.id}.wav`);
    try {
      await access(wav);
    } catch {
      console.error(
        `   ✗ ${record.paperTitle} — no recording at public/audio/${record.id}.wav`,
      );
      continue;
    }

    const slug = slugFor(record.paperTitle, record.format);
    await writeFile(
      join(SEED_EPISODES, `${slug}.json`),
      JSON.stringify({ ...record, id: slug }, null, 2) + "\n",
      "utf8",
    );
    await copyFile(wav, join(SEED_AUDIO, `${slug}.wav`));
    console.log(
      `   ✓ ${record.paperTitle} (${record.format}, ${record.ttsProvider ?? "unknown voice"})` +
        `\n       → demo/seed/episodes/${slug}.json`,
    );
    staged++;
  }
  return staged;
}

/** Which papers already have a staged episode, by paper id. */
async function alreadySeeded(): Promise<Set<string>> {
  try {
    const files = await readdir(SEED_EPISODES);
    return new Set(
      files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
    );
  } catch {
    return new Set();
  }
}

async function seed(
  paper: DemoPaper,
  opts: {
    minutes: number;
    provider?: ProviderName;
    ttsProvider?: TTSProviderName;
    format: EpisodeFormat;
  },
): Promise<void> {
  const store = new MemoryJobStore();
  const job = await store.create({
    minutes: opts.minutes,
    provider: opts.provider,
    verify: false,
    revise: false,
    format: opts.format,
  });

  // Written under the seed directory from the start, so a failed run leaves
  // nothing behind in the local library or in public/audio.
  await mkdir(SEED_AUDIO, { recursive: true });
  const audioPath = join(SEED_AUDIO, `${paper.id}.wav`);

  let lastStage = "";
  const stop = await store.subscribe(job.id, (j) => {
    if (j.stage === lastStage) return;
    lastStage = j.stage;
    process.stdout.write(`\r   ${j.stage.padEnd(24)} ${String(j.percent).padStart(3)}%`);
  });

  try {
    await runJob(store, job.id, {
      pdf: await readFile(paperPath(paper.id)),
      minutes: opts.minutes,
      provider: opts.provider,
      ttsProvider: opts.ttsProvider,
      verify: false,
      revise: false,
      format: opts.format,
      paperId: paper.id,
      paperTitle: paper.title,
      audioPath,
    });
  } finally {
    stop();
    process.stdout.write("\n");
  }

  const finished = await store.get(job.id);
  if (finished?.stage !== "done") {
    throw new Error(finished?.error?.message ?? "the job did not finish");
  }

  // The pipeline shelves the record under the job's own uuid. Restamping it
  // with the paper's id is what makes seeding idempotent, and the audio file
  // beside it has to be named to match: the library page builds its player
  // source as `/audio/<record id>.wav`.
  const record = await getEpisode(job.id);
  if (!record) throw new Error("the episode was produced but not shelved");

  await mkdir(SEED_EPISODES, { recursive: true });
  await writeFile(
    join(SEED_EPISODES, `${paper.id}.json`),
    JSON.stringify({ ...record, id: paper.id }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * The local shelf, printed so an id can be picked without opening the app.
 *
 * Which recording each one has is the column that matters: staging an episode
 * voiced by the flat fallback would put that voice on the demo's front page.
 */
async function listLocal(): Promise<void> {
  const episodes = (await listEpisodes()).sort((a, b) => b.createdAt - a.createdAt);
  if (episodes.length === 0) {
    console.log("Nothing on the local shelf yet. Make an episode first.");
    return;
  }
  console.log("Episodes on this machine — pass the ids you want:\n");
  for (const e of episodes) {
    const voice = (e.ttsProvider ?? "unknown").padEnd(8);
    console.log(`  ${e.id}  ${voice}  ${e.format}\n      ${e.paperTitle}`);
  }
  console.log("\n  npm run seed:demo -- --from-library <id>,<id>");
}

async function main() {
  if (process.argv.includes("--from-library")) {
    const ids = (arg("--from-library") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("--"));

    if (ids.length === 0) {
      await listLocal();
      return;
    }

    console.log(
      `Staging ${ids.length} episode${ids.length === 1 ? "" : "s"} from the local shelf.`,
    );
    const staged = await stageFromLibrary(ids);
    console.log(
      `\n${staged} of ${ids.length} staged in demo/seed.` +
        (staged ? " Rebuild the image and they ship with it; nothing else to do." : ""),
    );
    if (staged < ids.length) process.exit(1);
    return;
  }

  const force = process.argv.includes("--force");
  const minutes = Number(arg("--minutes") ?? demoConfig().maxMinutes);
  const provider = arg("--provider") as ProviderName | undefined;
  const ttsProvider = arg("--tts") as TTSProviderName | undefined;
  const asked = arg("--format");
  const format: EpisodeFormat = asked === "solo" || asked === "eli5" ? asked : "dialogue";

  const papers = await loadCatalogue().catch(() => []);
  if (papers.length === 0) {
    console.error(
      "No papers on the shelf. Run `npm run demo:papers` to fetch them, then try again.",
    );
    process.exit(1);
  }

  const done = force ? new Set<string>() : await alreadySeeded();
  const todo = papers.filter((p) => !done.has(p.id));

  console.log(
    `Seeding ${todo.length} of ${papers.length} shelf paper${papers.length === 1 ? "" : "s"}` +
      ` with ${provider ?? activeProvider()}, ${minutes} min, ${format}.` +
      (done.size ? ` ${done.size} already staged (--force to redo).` : ""),
  );

  const failed: string[] = [];
  for (const paper of todo) {
    console.log(`\n📄  ${paper.title}`);
    try {
      await seed(paper, { minutes, provider, ttsProvider, format });
      console.log(`   staged as demo/seed/episodes/${paper.id}.json`);
    } catch (err) {
      // One paper that will not parse or a provider that rate-limits partway
      // through should not throw away the episodes already made.
      failed.push(paper.id);
      console.error(`   ✗ ${err instanceof Error ? err.message : err}`);
    }
  }

  const staged = (await alreadySeeded()).size;
  console.log(
    `\n${staged} episode${staged === 1 ? "" : "s"} staged in demo/seed.` +
      (failed.length ? ` Failed: ${failed.join(", ")}.` : "") +
      "\nThey are copied into the image by the Dockerfile; nothing else to do.",
  );
  if (failed.length) process.exit(1);
}

runEntry(main);
