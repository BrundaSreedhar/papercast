import type { EvalResult } from "./types";

/** Approximate USD per million tokens, for order-of-magnitude cost reporting. */
const PRICING: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3 },
  "claude-opus-5": { in: 15, out: 75, cacheRead: 1.5 },
  "gpt-4o": { in: 2.5, out: 10, cacheRead: 1.25 },
};

/** Local models cost nothing per token; only hosted ones are priced. */
export function estimateCost(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number },
): number | undefined {
  const p = PRICING[model];
  if (!p) return undefined;
  const cached = usage.cacheReadTokens ?? 0;
  const fresh = Math.max(0, (usage.inputTokens ?? 0) - cached);
  return (
    (fresh * p.in + cached * p.cacheRead + (usage.outputTokens ?? 0) * p.out) / 1_000_000
  );
}

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${(n * 100).toFixed(0)}%`;
}

/**
 * What a run cost, or an honest blank.
 *
 * "free" is claimed only for the self-hosted `open` provider, which is the one
 * that genuinely costs nothing per token. A hosted model with no entry in the
 * price table is *unknown*, not free, and printing free would understate a real
 * bill in the one table people read to compare providers against each other.
 */
function cost(
  provider: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number },
): string {
  const n = estimateCost(model, usage);
  if (n !== undefined) return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
  return provider === "open" ? "free" : "—";
}

function secs(ms: number | undefined): string {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(0)}s`;
}

/**
 * Render results as a markdown comparison table.
 *
 * Every row carries whether the judge also generated the episode. Models favour
 * their own output, so a score produced by a self-judging pair is not directly
 * comparable to one that was judged independently, and hiding that would make
 * the table more flattering than it is honest.
 */
export function renderMarkdown(results: EvalResult[]): string {
  if (results.length === 0) return "# Eval results\n\nNo results.\n";

  const judge = results[0]!.judge;
  const lines: string[] = [
    "# Eval results",
    "",
    `Judge: \`${judge.provider}\` / \`${judge.model}\``,
    `Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "| Paper | Generator | Faithful | Halluc. | Coverage | Compliance | Errors | Cost | Time | Self-judged |",
    "|---|---|--:|--:|--:|--:|--:|--:|--:|:-:|",
  ];

  for (const r of results) {
    lines.push(
      `| ${r.paperId} | \`${r.generator.model}\` | ${pct(r.faithfulness?.faithfulness)} | ` +
        `${pct(r.faithfulness?.hallucinationRate)} | ${pct(r.coverage?.coverage)} | ` +
        `${pct(r.deterministic.complianceScore)} | ${r.deterministic.errors} | ` +
        `${cost(r.generator.provider, r.generator.model, r.generationCost ?? {})} | ` +
        `${secs(r.generationCost?.latencyMs)} | ${r.selfJudged ? "yes" : "no"} |`,
    );
  }

  lines.push("", "## Metrics", "");
  lines.push("- **Faithful** — share of factual claims the paper supports.");
  lines.push(
    "- **Halluc.** — share of claims the paper contradicts, plus specific claims it never makes. Vague framing is excluded; asserting a number the paper does not give is not the same as saying the work is interesting.",
  );
  lines.push(
    "- **Coverage** — share of the paper's annotated key contributions the episode conveys.",
  );
  lines.push(
    "- **Compliance** — deterministic checks passed: schema, alternation, length targets, and grounding of names and figures.",
  );
  lines.push(
    "- **Cost** — generation only, at list prices. Locally run models are free and marked so; a hosted model with no published price in this harness shows as — rather than being reported as free.",
  );

  const anySelf = results.some((r) => r.selfJudged);
  if (anySelf) {
    lines.push("", "## Caveat", "");
    lines.push(
      `Rows marked self-judged were graded by the same model that wrote them (\`${judge.model}\`). Language models systematically prefer their own output, so treat those scores as an upper bound rather than a neutral measurement. Judging with a second provider is the fix; the harness takes \`JUDGE_PROVIDER\` for exactly that reason.`,
    );
  }

  const failed = results.filter((r) => r.deterministic.errors > 0);
  if (failed.length) {
    lines.push("", "## Deterministic failures", "");
    for (const r of failed) {
      const bad = r.deterministic.checks.filter(
        (c) => !c.passed && c.severity === "error",
      );
      lines.push(`**${r.paperId} · ${r.generator.model}**`);
      for (const c of bad) lines.push(`- \`${c.id}\` — ${c.detail}`);
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}
