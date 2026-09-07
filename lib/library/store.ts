/**
 * The library: finished episodes on disk.
 *
 * A directory of JSON files rather than a database, for the same reasons the
 * study ledger is a file. The whole project runs with no account anywhere, and
 * requiring Postgres to look at something you already made would be the first
 * thing in it that does not. The audio is already a file next to it; this keeps
 * the transcript beside the sound rather than in a different kind of place.
 *
 * Writes go through a temporary file and a rename, so an interrupted run leaves
 * the previous record intact rather than a half-written one. A record is the
 * only surviving copy of an episode that cost minutes and money to produce.
 *
 * The interface is deliberately the same shape a database-backed one would
 * have — list, get, save, remove — so swapping this for Postgres later touches
 * nothing above it.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EpisodeRecord, EpisodeSummary } from "./types";
import { toSummary } from "./types";

export const DEFAULT_LIBRARY_DIR = join(process.cwd(), "data", "episodes");

export function libraryDir(): string {
  return process.env.LIBRARY_DIR || DEFAULT_LIBRARY_DIR;
}

/** Ids come from `randomUUID`, but they arrive over HTTP, so they are checked. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function pathFor(dir: string, id: string): string {
  if (!ID.test(id)) throw new Error(`Not a valid episode id: ${id}`);
  return join(dir, `${id}.json`);
}

export async function saveEpisode(
  record: EpisodeRecord,
  dir = libraryDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = pathFor(dir, record.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

export async function getEpisode(
  id: string,
  dir = libraryDir(),
): Promise<EpisodeRecord | undefined> {
  try {
    return JSON.parse(await readFile(pathFor(dir, id), "utf8")) as EpisodeRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Every episode, newest first.
 *
 * A record that will not parse is skipped rather than thrown: one bad file —
 * a half-written record from a machine that lost power mid-rename — must not
 * make the whole library unopenable.
 */
export async function listEpisodes(dir = libraryDir()): Promise<EpisodeSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const out: EpisodeSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as EpisodeRecord;
      if (record?.id) out.push(toSummary(record));
    } catch {
      // Unreadable record: skipped, so the rest of the shelf still opens.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function removeEpisode(id: string, dir = libraryDir()): Promise<void> {
  await rm(pathFor(dir, id), { force: true });
}

export type { EpisodeRecord, EpisodeSummary } from "./types";
export { toSummary } from "./types";
