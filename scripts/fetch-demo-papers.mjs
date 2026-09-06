#!/usr/bin/env node
/**
 * Fetch the demo shelf.
 *
 * The papers a public deployment offers are not committed here. They are other
 * people's documents, and a repository is the wrong place to redistribute them
 * from; the manifest records where each one lives and this fetches them into
 * the image at build time.
 *
 *   npm run demo:papers
 *
 * Already-present files are left alone, so it is safe to run repeatedly and
 * cheap to leave in a Dockerfile layer. A failure is loud: a demo that starts
 * with half a shelf and discovers the rest at request time is worse than a
 * build that stops.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo", "papers");
const MIN_BYTES = 50_000;

const { papers } = JSON.parse(await readFile(join(root, "demo", "papers.json"), "utf8"));
await mkdir(outDir, { recursive: true });

for (const paper of papers) {
  const out = join(outDir, `${paper.id}.pdf`);
  const have = await stat(out).catch(() => null);
  if (have && have.size > MIN_BYTES) {
    console.log(`have  ${paper.id}.pdf  ${(have.size / 1e6).toFixed(1)} MB`);
    continue;
  }

  process.stdout.write(`fetch ${paper.id}.pdf  ${paper.url} ... `);
  // arXiv asks for an identifiable client, and answers 403 to some defaults.
  const res = await fetch(paper.url, {
    redirect: "follow",
    headers: { "User-Agent": "papercast-demo/1.0 (+https://github.com/)" },
  });
  if (!res.ok) {
    throw new Error(`${paper.url} returned ${res.status} ${res.statusText}`);
  }

  const body = Buffer.from(await res.arrayBuffer());
  // A truncated file or an error page dressed as a PDF fails here rather than
  // inside the pipeline, where it would read as a bad paper instead of a bad
  // download.
  if (
    body.length < MIN_BYTES ||
    !body.subarray(0, 5).toString("latin1").startsWith("%PDF-")
  ) {
    throw new Error(`${paper.url} did not return a PDF (${body.length} bytes)`);
  }

  // Written aside and moved, so an interrupted fetch never leaves a partial
  // file that the next run would take for a complete one.
  const tmp = `${out}.partial`;
  await writeFile(tmp, body);
  await rename(tmp, out);
  console.log(`${(body.length / 1e6).toFixed(1)} MB`);
}

console.log(`${papers.length} papers in ${outDir}`);
