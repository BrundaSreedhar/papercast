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
import { refineEpisode } from "../lib/refine/index";
import { groundTurns, formatCitation } from "../lib/ground/index";
import { runEntry } from "./entry";
import { withSpan } from "../lib/trace/index";
import * as TA from "../lib/trace/attributes";

interface Args {
  pdfPath: string;
  minutes: number;
  provider?: ProviderName;
  out: string;
  /** Fact-check the script against the paper and rewrite what fails. */
  revise: boolean;
  reviseRounds: number;
  /** One voice talking to the listener, instead of a two-host conversation. */
  solo: boolean;
  /** One voice, explaining the paper to a young child. */
  eli5: boolean;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const pdfPath = rest.find((a) => !a.startsWith("--"));
  if (!pdfPath) {
    console.error(
      "Usage: npm run generate -- <paper.pdf> [--minutes N] [--provider anthropic|openai|gemini|open]\n" +
        "                          [--out file.json] [--figures] [--solo] [--eli5] [--revise] [--revise-rounds N]\n" +
        "                          [--trace] [--trace-payloads]",
    );
    process.exit(1);
  }
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const providerArg = get("--provider");
  return {
    pdfPath,
    minutes: Number(get("--minutes") ?? 10),
    provider: providerArg as ProviderName | undefined,
    out: get("--out") ?? `${basename(pdfPath).replace(/\.pdf$/i, "")}.episode.json`,
    revise: rest.includes("--revise"),
    solo: rest.includes("--solo"),
    eli5: rest.includes("--eli5"),
    reviseRounds: Number(get("--revise-rounds") ?? 1),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  // One workflow span so a traced run is a single tree rather than a scripting
  // root and a refine root sitting side by side.
  return withSpan(
    "invoke_workflow generate",
    {
      [TA.GEN_AI_OPERATION_NAME]: "invoke_workflow",
      [TA.GEN_AI_WORKFLOW_NAME]: "generate",
      [TA.PAPERCAST_MINUTES]: args.minutes,
      [TA.PAPERCAST_REVISE]: args.revise,
    },
    () => generate(args),
  );
}

async function generate(args: Args) {
  const rest = process.argv.slice(2);
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
      onProgress: (d, t) =>
        process.stdout.write(`\r🖼️   Reading figures… ${d}/${t} pages`),
    });
    console.log(`\r🖼️   Described ${paper.figures?.length ?? 0} pages of figures      `);
  }

  console.log(
    `\n🎙️   Generating ${args.minutes}-min ${args.eli5 ? "explain-like-I'm-5" : args.solo ? "solo" : "two-host"} episode via "${provider}"…`,
  );
  const t0 = Date.now();
  const result = await generateEpisode(paper, {
    minutes: args.minutes,
    format: args.eli5 ? "eli5" : args.solo ? "solo" : "dialogue",
    provider: getProvider(provider),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const { usage, retries, truncatedInput, model } = result;
  let episode = result.episode;
  console.log(`\n✅  Done in ${secs}s  (model: ${model})`);
  console.log(
    `    tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out` +
      `${retries ? ` · retries: ${retries}` : ""}` +
      `${truncatedInput ? " · input truncated" : ""}`,
  );

  // Fact-checking costs two judge passes plus a rewrite, so it is opt-in.
  let review: Awaited<ReturnType<typeof refineEpisode>> | undefined;
  if (args.revise) {
    console.log(`\n🔍  Fact-checking the script against the paper…`);
    try {
      review = await refineEpisode(episode, paper, {
        provider: getProvider(provider),
        maxRounds: args.reviseRounds,
        onProgress: (round, of, message) =>
          console.log(`    [${round}/${of}] ${message}`),
      });
    } catch (err) {
      // The script is already written and paid for. Report the failed check and
      // keep going rather than discarding the episode.
      console.error(
        `    ⚠️  the fact-check did not complete: ${err instanceof Error ? err.message : err}`,
      );
      console.error(`    the episode below is UNCHECKED.`);
    }
  }

  if (review) {
    episode = review.episode;

    const before = review.rounds[0]!;
    const kept = review.rounds.find((r) => r.round === review!.bestRound) ?? before;
    const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
    console.log(
      `\n    faithfulness: ${pct(before.faithfulness.faithfulness)} → ${pct(kept.faithfulness.faithfulness)}` +
        ` · unsupported claims: ${before.failures} → ${kept.failures}`,
    );
    if (review.improved) {
      console.log(`    rewrote turns: ${kept.revisedTurns.join(", ")}`);
    } else if (before.failures === 0) {
      console.log(`    nothing to fix — every claim traces to the paper.`);
    } else {
      console.log(`    kept the original: no rewrite scored better.`);
    }
    for (const v of before.faithfulness.verdicts.filter(
      (x) => x.verdict === "contradicted" || (x.verdict === "unsupported" && x.specific),
    )) {
      console.log(`      ✗ [turn ${v.turn}] ${v.verdict}: ${v.claim}`);
    }
  }

  console.log(`\n── SUMMARY ─────────────────────────────────────────────`);
  console.log(episode.summary);
  console.log(`\n── KEY POINTS ──────────────────────────────────────────`);
  episode.keyPoints.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
  // Anchoring is local and deterministic, so it runs here too rather than only
  // in the web app: the CLI is where the script is actually read closely.
  const citations = groundTurns(episode, paper);
  const citeFor = new Map(citations.map((c) => [c.turnIndex, c]));

  console.log(`\n── DIALOGUE (first 4 turns) ────────────────────────────`);
  episode.turns.slice(0, 4).forEach((t, i) => {
    console.log(`  ${t.speaker.toUpperCase()}: ${t.text}`);
    const c = citeFor.get(i);
    if (c)
      console.log(`     ↳ ${formatCitation(c)}${c.match === "approximate" ? " ≈" : ""}`);
  });
  console.log(`  … (${episode.turns.length} turns total)`);
  console.log(
    `\n📍  ${citations.length} of ${episode.turns.length} turns traced back to the paper`,
  );

  await writeFile(
    args.out,
    JSON.stringify({ ...result, episode, review, citations }, null, 2),
    "utf8",
  );
  console.log(`\n💾  Full episode written to ${args.out}\n`);
}

runEntry(main);
