/**
 * Synthesis via Piper, an open-source neural text-to-speech system.
 *
 * Chosen over the built-in macOS voices for anything anyone will actually
 * listen to. Piper is MIT-licensed, runs entirely on CPU, and needs no account
 * — so the project keeps its property of producing a complete episode with no
 * hosted service anywhere, while sounding like something from this decade
 * rather than a screen reader.
 *
 * It is a command-line program that reads text and writes a WAV, which is the
 * same shape as the `say` backend and lands on the existing joining and timing
 * path unchanged. Conveniently it emits 22.05 kHz 16-bit mono, matching the
 * other local backend exactly.
 *
 * Voice models are ONNX files downloaded once (~60 MB each) and kept out of the
 * repository; see the README for the two commands that fetch them.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { piperConfig } from "../config/env";
import type { Speaker, TTSProvider } from "./types";

const run = promisify(execFile);

export interface PiperOptions {
  binary?: string;
  hostVoice?: string;
  guestVoice?: string;
}

export class PiperProvider implements TTSProvider {
  readonly name = "piper";
  readonly format = "wav" as const;
  // Piper reads from stdin and has no documented input cap, but turns are still
  // chunked so one failure costs a chunk rather than a whole turn.
  readonly maxChars = 8000;

  private readonly binary: string;
  private readonly hostVoice: string;
  private readonly guestVoice: string;

  constructor(opts: PiperOptions = {}) {
    const cfg = piperConfig();
    this.binary = opts.binary ?? cfg.binary;
    this.hostVoice = opts.hostVoice ?? cfg.hostVoice;
    this.guestVoice = opts.guestVoice ?? cfg.guestVoice;
  }

  get description(): string {
    return `piper: ${voiceName(this.hostVoice)} (host) / ${voiceName(this.guestVoice)} (guest)`;
  }

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    const model = speaker === "host" ? this.hostVoice : this.guestVoice;
    const dir = await mkdtemp(join(tmpdir(), "papercast-piper-"));
    const out = join(dir, "chunk.wav");
    try {
      // Text goes in on stdin so nothing has to be escaped for a shell.
      const child = run(this.binary, ["-m", model, "-f", out], { encoding: "buffer" });
      child.child.stdin?.end(text, "utf8");
      await child;
      return await readFile(out);
    } catch (err) {
      // Piper explains itself on stderr and says almost nothing useful in the
      // exit message, so dropping stderr threw away the actual reason — a
      // missing voice file, an unreadable model — and left "Command failed".
      const detail = failureDetail(err);
      throw new Error(
        `Piper synthesis failed (${this.binary}, ${voiceName(model)}): ${detail}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * The most informative single line available about a failed run.
 *
 * Prefers stderr, which is where Piper writes the reason, and falls back to the
 * exit message when the process produced none.
 */
function failureDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : Buffer.isBuffer(e?.stderr)
        ? e.stderr.toString("utf8")
        : "";
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (line) return line;
  return err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
}

/** Strip path and extension so reports name the voice, not a file path. */
export function voiceName(modelPath: string): string {
  return modelPath.replace(/^.*\//, "").replace(/\.onnx$/i, "");
}

/** Whether the binary and both voice models are present. */
export async function piperAvailable(opts: PiperOptions = {}): Promise<boolean> {
  const cfg = piperConfig();
  const paths = [
    opts.binary ?? cfg.binary,
    opts.hostVoice ?? cfg.hostVoice,
    opts.guestVoice ?? cfg.guestVoice,
  ];
  for (const p of paths) {
    try {
      await access(p);
    } catch {
      return false;
    }
  }
  return true;
}
