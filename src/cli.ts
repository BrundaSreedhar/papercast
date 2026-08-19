#!/usr/bin/env node
/**
 * End-to-end CLI: PDF -> clean structure -> faithful two-host episode (JSON).
 *
 *   npm run generate -- path/to/paper.pdf
 *   npm run generate -- paper.pdf --minutes 8 --provider openai --out ep.json
 *
 * This is the harness for tuning prompts on real papers before any UI exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractPaper } from "../lib/pdf/extract";
import { generateEpisode } from "../lib/llm/generateEpisode";
import { getProvider } from "../lib/llm/index";
import { activeProvider, type ProviderName } from "../lib/config/env";
import { enrichWithFigures, getVisionProvider } from "../lib/vision/index";

interface Args {
  pdfPath: string;
  minutes: number;
  provider?: ProviderName;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const pdfPath = rest.find((a) => !a.startsWith("--"));
  if (!pdfPath) {
    console.error("Usage: npm run generate -- <paper.pdf> [--minutes N] [--provider anthropic|openai|open] [--out file.json] [--figures]");
    process.exit(1);
  }
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const providerArg = get("--provider");
  console.log(providerArg);
  console.log(get("--minutes"));
  console.log(get("--out"));
  return {
    pdfPath,
    minutes: Number(get("--minutes") ?? 10),
    provider: providerArg as ProviderName | undefined,
    out: get("--out") ?? `${basename(pdfPath).replace(/\.pdf$/i, "")}.episode.json`,
  };
}

async function main() {
  const rest = process.argv.slice(2);
  const args = parseArgs(process.argv);
  const provider = args.provider ?? activeProvider();

  console.log(`\n📄  Reading ${args.pdfPath}`);
  const bytes = await readFile(args.pdfPath);

  console.log("✂️   Extracting and cleaning sections…");
  let paper = await extractPaper(bytes);
  console.log(
    `    title: ${paper.title || "(none detected)"}\n` +
      `    sections kept: ${paper.sections.length} · words: ${paper.wordCount}`,
  );

  // Figures are read only on request: it costs a vision call per page, and the
  // text path is unchanged without it.
  if (rest.includes("--figures")) {
    process.stdout.write("🖼️   Reading figures…");
    paper = await enrichWithFigures(paper, bytes, {
      provider: getVisionProvider(),
      onProgress: (d, t) => process.stdout.write(`\r🖼️   Reading figures… ${d}/${t} pages`),
    });
    console.log(`\r🖼️   Described ${paper.figures?.length ?? 0} pages of figures      `);
  }

  console.log(`\n🎙️   Generating ${args.minutes}-min episode via "${provider}"…`);
  const t0 = Date.now();
  const result = await generateEpisode(paper, {
    minutes: args.minutes,
    provider: getProvider(provider),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const { episode, usage, retries, truncatedInput, model } = result;
  console.log(`\n✅  Done in ${secs}s  (model: ${model})`);
  console.log(
    `    tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out` +
      `${retries ? ` · retries: ${retries}` : ""}` +
      `${truncatedInput ? " · input truncated" : ""}`,
  );

  console.log(`\n── SUMMARY ─────────────────────────────────────────────`);
  console.log(episode.summary);
  console.log(`\n── KEY POINTS ──────────────────────────────────────────`);
  episode.keyPoints.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
  console.log(`\n── DIALOGUE (first 4 turns) ────────────────────────────`);
  episode.turns.slice(0, 4).forEach((t) => console.log(`  ${t.speaker.toUpperCase()}: ${t.text}`));
  console.log(`  … (${episode.turns.length} turns total)`);

  await writeFile(args.out, JSON.stringify(result, null, 2), "utf8");
  console.log(`\n💾  Full episode written to ${args.out}\n`);
}

main().catch((err) => {
  console.error("\n❌  Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
