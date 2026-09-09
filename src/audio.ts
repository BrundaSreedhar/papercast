#!/usr/bin/env node
/**
 * Turn a generated episode into audio.
 *
 *   npm run audio -- aurora.episode.json
 *   npm run audio -- aurora.episode.json --provider openai --gap 500 --m4a
 *
 * Works on any episode JSON, so a transcript can be re-voiced without paying to
 * generate it again.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { EpisodeSchema, type Episode } from "../lib/llm/schema";
import { sliceWav } from "../lib/tts/wav";
import { resolveTTSProvider, synthesizeEpisode, type TTSProviderName } from "../lib/tts/index";
import { runAudioChecks } from "../lib/eval/audioChecks";
import { WhisperCppProvider, whisperAvailable } from "../lib/asr/index";
import { fidelityCheck, verifyPerTurn } from "../lib/eval/transcriptFidelity";
import { runEntry } from "./entry";

const run = promisify(execFile);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

/** Accept either a raw episode or the wrapper the generator writes. */
function readEpisode(raw: unknown): Episode {
  const candidate =
    raw && typeof raw === "object" && "episode" in raw
      ? (raw as { episode: unknown }).episode
      : raw;
  return EpisodeSchema.parse(candidate);
}

function mmss(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function main() {
  const input = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!input) {
    console.error(
      "Usage: npm run audio -- <episode.json> [--provider piper|say|openai] [--gap MS] [--out FILE] [--m4a] [--verify]",
    );
    process.exit(1);
  }

  const episode = readEpisode(JSON.parse(await readFile(input, "utf8")));
  const provider = await resolveTTSProvider(arg("--provider") as TTSProviderName | undefined);
  const gapMs = Number(arg("--gap") ?? 350);
  const stem = (arg("--out") ?? input).replace(/\.(episode\.)?json$/i, "");
  const wavPath = `${stem}.wav`;

  console.log(`\n🎧  ${basename(input)} — ${episode.turns.length} turns`);
  console.log(`    voices: ${provider.description}`);

  const t0 = Date.now();
  const result = await synthesizeEpisode(episode, {
    provider,
    gapMs,
    onProgress: (done, total) => {
      process.stdout.write(`\r    synthesizing… ${done}/${total} turns`);
    },
  });
  process.stdout.write("\n");

  await writeFile(wavPath, result.audio);

  // Timings are written beside the audio so a player can highlight the current
  // line without re-deriving them from the file.
  const timingsPath = `${stem}.timings.json`;
  await writeFile(
    timingsPath,
    JSON.stringify(
      {
        totalMs: result.totalMs,
        provider: result.provider,
        voices: result.voices,
        turns: result.timings.map((t) => ({
          ...t,
          text: episode.turns[t.turnIndex]?.text ?? "",
        })),
      },
      null,
      2,
    ),
  );

  // Verify the output rather than trusting it. Text silently going missing in
  // synthesis is invisible on playback, so the file is checked before it is
  // announced as finished.
  const targetMinutes = arg("--target") ? Number(arg("--target")) : undefined;
  const checks = runAudioChecks({ episode, audio: result, targetMinutes });

  console.log(`\n✅  ${mmss(result.totalMs)} of audio in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`    ${result.calls} synthesis calls across ${result.timings.length} turns`);
  console.log(
    `    checks ${(checks.complianceScore * 100).toFixed(0)}% (${checks.errors} errors, ${checks.warnings} warnings)`,
  );
  for (const c of checks.checks.filter((x) => !x.passed)) {
    console.log(`    ${c.severity === "error" ? "❌" : "⚠️ "} ${c.id}: ${c.detail}`);
  }
  // Opt-in, because recognition takes about as long as synthesis. This is the
  // only check that establishes what the audio actually says rather than
  // inferring it from duration.
  if (has("--verify")) {
    if (!(await whisperAvailable())) {
      console.log("    ⚠️  --verify needs whisper-cli and a model; see the README.");
    } else {
      const asr = new WhisperCppProvider();
      // Per turn rather than in one pass: recognizers skip material on long
      // recordings, and the exact timings from synthesis make short clips
      // possible. Verifying the whole file at once measured 61% on audio that
      // was word-perfect clip by clip.
      const fidelity = await verifyPerTurn(
        episode,
        result,
        asr,
        sliceWav,
        (done, total) => process.stdout.write(`\r    verifying turn ${done}/${total}…      `),
      );
      // Clear the progress line so the result is not written over it.
      process.stdout.write("\r\x1b[K");
      const check = fidelityCheck(fidelity);
      console.log(
        `    verified: ${Math.round(fidelity.episodeRecall * 100)}% of the script recognized in the audio`,
      );
      if (!check.passed) console.log(`    ${check.severity === "error" ? "❌" : "⚠️ "} ${check.detail}`);
      for (const t of fidelity.suspect.slice(0, 3)) {
        console.log(`      turn ${t.turnIndex}: missing ${t.missing.slice(0, 6).join(", ")}`);
      }
    }
  }

  console.log(`    ${wavPath}`);
  console.log(`    ${timingsPath}`);

  if (has("--m4a")) {
    // afconvert ships with macOS, so compression needs no extra dependency.
    const m4aPath = `${stem}.m4a`;
    try {
      await run("afconvert", ["-f", "m4af", "-d", "aac", wavPath, m4aPath]);
      console.log(`    ${m4aPath}`);
    } catch {
      console.log("    ⚠️  afconvert unavailable; keeping WAV only.");
    }
  }

  console.log();
  for (const t of result.timings.slice(0, 3)) {
    console.log(`    ${mmss(t.startMs)}  ${t.speaker.toUpperCase()}`);
  }
  if (result.timings.length > 3) console.log(`    … ${result.timings.length} turns total\n`);
}

runEntry(main);
