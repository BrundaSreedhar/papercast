#!/usr/bin/env node
/**
 * Record an episode already on the shelf again, in the current voice.
 *
 *   npm run rerecord -- latest                  # the most recent episode
 *   npm run rerecord -- <episode-id>            # a particular one
 *   npm run rerecord -- latest --provider piper # a particular backend
 *   npm run rerecord -- latest --force          # save even if a check fails
 *
 * The script is kept; only the audio is made again, with whichever backend
 * TTS_PROVIDER names (or --provider), so an episode recorded in a flat backup
 * voice can be heard as it should have been. Every audio check runs on the new
 * recording, and one that fails is not saved over a working episode unless
 * asked. The previous recording is kept beside the new one as
 * `<id>.previous.wav`.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEpisode, listEpisodes, saveEpisode } from "../lib/library/store";
import {
  resolveTTSProvider,
  synthesizeEpisode,
  type TTSProviderName,
} from "../lib/tts/index";
import { runAudioChecks } from "../lib/eval/audioChecks";
import { runEntry } from "./entry";

const AUDIO_DIR = join(process.cwd(), "public", "audio");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const which = process.argv
    .slice(2)
    .find((a) => !a.startsWith("--") && a !== arg("--provider"));
  if (!which) {
    console.error(
      "Usage: npm run rerecord -- <episode-id | latest> [--provider NAME] [--force]",
    );
    process.exit(1);
  }
  const force = process.argv.includes("--force");

  const id =
    which === "latest"
      ? (await listEpisodes()).sort((a, b) => b.createdAt - a.createdAt)[0]?.id
      : which;
  const record = id ? await getEpisode(id) : undefined;
  if (!record) {
    console.error(
      `No episode ${which === "latest" ? "on the shelf" : `called ${which}`}.`,
    );
    process.exit(1);
  }

  const provider = await resolveTTSProvider(
    arg("--provider") as TTSProviderName | undefined,
  );
  console.log(
    `🎙  ${record.paperTitle} (${record.id.slice(0, 8)}, ${record.format})\n` +
      `   was: ${record.voices ?? record.ttsProvider ?? "unknown voice"}\n` +
      `   now: ${provider.description}`,
  );

  const started = Date.now();
  const audio = await synthesizeEpisode(record.episode, {
    provider,
    onProgress: (done, total) =>
      process.stdout.write(`\r   recording turn ${done} of ${total}`),
  });
  const seconds = (Date.now() - started) / 1000;
  console.log(
    `\n   ${(audio.totalMs / 60_000).toFixed(1)} min in ${seconds.toFixed(0)}s, ${audio.calls} calls`,
  );

  const checks = runAudioChecks({
    episode: record.episode,
    audio,
    targetMinutes: record.minutes,
  });
  for (const c of checks.checks) {
    console.log(
      `   ${c.passed ? "✓" : c.severity === "error" ? "✗" : "!"} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`,
    );
  }
  if (checks.errors > 0 && !force) {
    console.error(
      "\nNot saved: a check failed. The episode keeps its old recording (--force saves anyway).",
    );
    process.exit(1);
  }

  const target = join(AUDIO_DIR, `${record.id}.wav`);
  if (existsSync(target))
    await copyFile(target, join(AUDIO_DIR, `${record.id}.previous.wav`));
  await writeFile(target, audio.audio);
  await saveEpisode({
    ...record,
    hasAudio: true,
    timings: audio.timings,
    totalMs: audio.totalMs,
    ttsProvider: audio.provider,
    voices: audio.voices,
    // Measured on the old recording, so it no longer describes this one.
    transcriptRecall: undefined,
    ...(record.cost ? { cost: { ...record.cost, ttsCalls: audio.calls } } : {}),
  });
  console.log(
    `\nSaved. The previous recording is at public/audio/${record.id}.previous.wav.`,
  );
}

runEntry(main);
