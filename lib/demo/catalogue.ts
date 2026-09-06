/**
 * The papers a public deployment is allowed to run.
 *
 * The demo cannot take uploads — a URL anyone can open, spending an API key on
 * an arbitrary file, is a bill with no ceiling — so it offers a fixed shelf
 * instead. The shelf is a manifest of arXiv papers fetched into the image at
 * build time rather than PDFs committed here: the repository stays free of
 * documents it has no right to redistribute, and the manifest records where
 * each one came from.
 *
 * A paper whose file is missing is dropped rather than offered, because a
 * button that starts a job which then fails to read its own input is worse than
 * a shelf with one fewer book on it.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const DemoPaperSchema = z.object({
  /** Stable id: what the client sends back, and the PDF's filename stem. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  authors: z.string().min(1),
  year: z.number().int(),
  /** Where the PDF is fetched from, so the source is never in doubt. */
  url: z.string().url(),
  /** One line on why this paper is worth four minutes. */
  note: z.string().min(1),
});

export const DemoCatalogueSchema = z.object({
  papers: z.array(DemoPaperSchema).min(1),
});

export type DemoPaper = z.infer<typeof DemoPaperSchema>;

export const catalogueDir = () => join(process.cwd(), "demo", "papers");
export const cataloguePath = () => join(process.cwd(), "demo", "papers.json");
export const paperPath = (id: string) => join(catalogueDir(), `${id}.pdf`);

/** Parse a manifest. Separate from reading one so it can be tested as data. */
export function parseCatalogue(raw: unknown): DemoPaper[] {
  return DemoCatalogueSchema.parse(raw).papers;
}

/** The manifest, filtered to the papers whose PDF actually landed in the image. */
export async function loadCatalogue(): Promise<DemoPaper[]> {
  const papers = parseCatalogue(JSON.parse(await readFile(cataloguePath(), "utf8")));
  const present = await Promise.all(papers.map((p) => exists(paperPath(p.id))));
  return papers.filter((_, i) => present[i]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
