/**
 * Rendering PDF pages to images, and finding which pages are worth rendering.
 *
 * Text extraction discards everything a paper draws rather than writes:
 * architecture diagrams, plots, and tables laid out graphically. The Amazon
 * Aurora paper carries thirty-nine embedded images, including the table that
 * reports its headline throughput figures — none of which reached the model
 * before this.
 *
 * Whole pages are rendered rather than embedded images extracted. A figure
 * pulled out of its page loses its caption, axis labels, and surrounding
 * sentence, which are exactly what makes it interpretable; the page keeps them.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Captions that mark a page as carrying a figure or table worth looking at. */
const CAPTION_RE = /\b(figure|fig\.|table|algorithm)\s*(\d+)\s*[:.]/gi;

export interface PageFigure {
  page: number;
  /** Caption lines found on the page, e.g. "Figure 3:", "Table 1:". */
  captions: string[];
}

export interface RenderedPage {
  page: number;
  png: Buffer;
  captions: string[];
}

/** Text of a single page, used to decide whether it is worth rendering. */
export async function pageText(pdfPath: string, page: number): Promise<string> {
  const { stdout } = await run("pdftotext", [
    "-f", String(page),
    "-l", String(page),
    pdfPath,
    "-",
  ]);
  return stdout;
}

export async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run("pdfinfo", [pdfPath]);
  const m = stdout.match(/^Pages:\s*(\d+)/m);
  return m ? Number(m[1]) : 0;
}

/**
 * Find pages carrying figures or tables, by looking for their captions.
 *
 * Caption detection is reused from extraction, where the same pattern is used
 * to strip caption lines out of the prose. What was noise for the text path is
 * the index for the visual one.
 */
export async function findFigurePages(pdfPath: string): Promise<PageFigure[]> {
  const pages = await pageCount(pdfPath);
  const found: PageFigure[] = [];
  for (let p = 1; p <= pages; p++) {
    const text = await pageText(pdfPath, p);
    const captions = [...text.matchAll(CAPTION_RE)].map((m) => m[0].trim());
    if (captions.length) found.push({ page: p, captions: [...new Set(captions)] });
  }
  return found;
}

export interface RenderOptions {
  /** Resolution in DPI. 110 keeps a page legible at a manageable file size. */
  dpi?: number;
  /** Cap on pages rendered, so a long paper cannot run up an unbounded bill. */
  maxPages?: number;
}

/** Render the given pages to PNG. */
export async function renderPages(
  pdf: Buffer,
  pages: { page: number; captions: string[] }[],
  opts: RenderOptions = {},
): Promise<RenderedPage[]> {
  const { dpi = 110, maxPages = 8 } = opts;
  const wanted = pages.slice(0, maxPages);
  if (wanted.length === 0) return [];

  const dir = await mkdtemp(join(tmpdir(), "papercast-render-"));
  const pdfPath = join(dir, "in.pdf");
  try {
    await writeFile(pdfPath, pdf);
    const out: RenderedPage[] = [];
    for (const { page, captions } of wanted) {
      const stem = join(dir, `p${page}`);
      await run("pdftoppm", [
        "-png",
        "-r", String(dpi),
        "-f", String(page),
        "-l", String(page),
        pdfPath,
        stem,
      ]);
      // pdftoppm zero-pads the page number by a width it chooses itself.
      const produced = (await readdir(dir)).find(
        (f) => f.startsWith(`p${page}-`) && f.endsWith(".png"),
      );
      if (produced) out.push({ page, png: await readFile(join(dir, produced)), captions });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether the rendering tools are installed. */
export async function rendererAvailable(): Promise<boolean> {
  try {
    await run("pdftoppm", ["-v"]);
    await run("pdfinfo", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

export { CAPTION_RE };
