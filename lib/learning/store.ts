/**
 * Reading and writing the ledger as a JSON file.
 *
 * A local file rather than a database because a study history is small, is
 * inherently one person's, and gains nothing from a server. It is also readable
 * and diffable, which matters for something meant to be looked at.
 *
 * Writes go through a temporary file and a rename, so an interrupted run leaves
 * the previous ledger intact instead of a half-written one. A study history is
 * exactly the kind of file that is painful to lose and never backed up.
 */
import { rename, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyLedger, type Ledger } from "./types";

export const DEFAULT_LEDGER_PATH = join(process.cwd(), "learning.json");

export function ledgerPath(): string {
  return process.env.LEDGER_PATH || DEFAULT_LEDGER_PATH;
}

export async function loadLedger(path = ledgerPath()): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    // A ledger from a future version is left alone rather than overwritten.
    if (raw?.version !== 1) {
      throw new Error(`Ledger at ${path} has unsupported version ${raw?.version}.`);
    }
    return raw as Ledger;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyLedger();
    throw err;
  }
}

export async function saveLedger(ledger: Ledger, path = ledgerPath()): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
