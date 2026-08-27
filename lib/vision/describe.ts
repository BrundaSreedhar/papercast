/**
 * Turning a paper's figures into text the script writer can use.
 *
 * Pages carrying captions are rendered and described one at a time. Doing this
 * per page rather than per document keeps each description anchored to a
 * specific figure, which matters later: a claim traced to "Figure 3" can be
 * checked against the description of the page Figure 3 is on.
 */
import { findFigurePages, renderPages, rendererAvailable } from "../pdf/render";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FigureDescription, VisionProvider } from "./types";
import { withSpan } from "../trace/tracer";
import { PAPERCAST_TASK } from "../trace/attributes";

export interface DescribeOptions {
  provider: VisionProvider;
  /** Cap on pages described, bounding both cost and time. */
  maxPages?: number;
  dpi?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Replies that mean "there was nothing to describe here". */
function isEmptyDescription(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || /^none\b/i.test(t);
}

export async function describeFigures(
  pdf: Buffer,
  opts: DescribeOptions,
): Promise<FigureDescription[]> {
  if (!(await rendererAvailable())) return [];

  // Page detection needs a path; the caller holds bytes.
  const dir = await mkdtemp(join(tmpdir(), "papercast-figs-"));
  const pdfPath = join(dir, "in.pdf");
  let pages;
  try {
    await writeFile(pdfPath, pdf);
    pages = await findFigurePages(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (pages.length === 0) return [];

  const rendered = await renderPages(pdf, pages, {
    maxPages: opts.maxPages ?? 8,
    dpi: opts.dpi,
  });

  return withSpan(
    "describe figures",
    { [PAPERCAST_TASK]: "describe_figures", "papercast.pages": rendered.length },
    async () => describeEach(rendered, opts),
  );
}

async function describeEach(
  rendered: Awaited<ReturnType<typeof renderPages>>,
  opts: DescribeOptions,
): Promise<FigureDescription[]> {
  const out: FigureDescription[] = [];
  for (const [i, page] of rendered.entries()) {
    const description = await opts.provider.describePage(page.png, page.captions);
    // A page whose captions sit in running prose rather than under a figure
    // yields nothing, and an empty entry would only dilute the source text.
    if (!isEmptyDescription(description)) {
      out.push({ page: page.page, captions: page.captions, description });
    }
    opts.onProgress?.(i + 1, rendered.length);
  }
  return out;
}

/**
 * Render figure descriptions for inclusion in the source text.
 *
 * Clearly labelled as derived. The judge verifies claims against this text, and
 * it must be able to tell what the paper states from what a model reported
 * seeing — the descriptions are evidence, but second-hand evidence.
 */
export function figuresToText(figures: FigureDescription[]): string {
  if (figures.length === 0) return "";
  const parts = figures.map(
    (f) =>
      `[Figure description — produced by a vision model reading page ${f.page}, not text quoted from the paper]\n${f.captions.join(" ")}\n${f.description}`,
  );
  return `## Figures and tables\n\n${parts.join("\n\n")}`;
}

/**
 * Attach figure descriptions to an already-extracted paper.
 *
 * Kept separate from extraction so the text path stays pure and free of any
 * model call. Enriching afterwards also means the figures land in
 * `paperToText`, which is the single string the writer, the judge, and the
 * grounding checks all read — so a claim about a diagram is verifiable by the
 * same machinery as a claim about a paragraph, with no special case anywhere.
 */
export async function enrichWithFigures<T extends { figures?: FigureDescription[] }>(
  paper: T,
  pdf: Buffer,
  opts: DescribeOptions,
): Promise<T> {
  const figures = await describeFigures(pdf, opts);
  return figures.length ? { ...paper, figures } : paper;
}
