/**
 * Synthesis via Kokoro, a small open-weight speech model, run locally.
 *
 * Piper made local episodes possible and made them sound flat: every turn at
 * much the same pitch and pace, and a listener noticed within a sentence.
 * Kokoro is 82 million parameters, Apache-2.0, and runs at about four times
 * real time on a laptop CPU, with a delivery much closer to a person reading
 * aloud. It uses fixed voice presets rather than generating a voice per call,
 * so unlike Gemini a narrator cannot drift into someone else between turns.
 *
 * It runs through the ONNX build (`kokoro-onnx`) in the project's speech
 * virtualenv, with no PyTorch. The model loads once into a long-lived worker
 * (`scripts/kokoro_worker.py`) that every provider instance shares, because a
 * process per call would reload a second of weights on every turn, and a
 * spoken answer would pay it before saying anything.
 *
 * Output is 24 kHz 16-bit mono, the same rate Gemini returns, so an episode or
 * an answer joins with the existing code unchanged.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { kokoroConfig } from "../config/env";
import type { Speaker, TTSProvider } from "./types";

const WORKER_SCRIPT = join(process.cwd(), "scripts", "kokoro_worker.py");

export interface KokoroOptions {
  python?: string;
  model?: string;
  voices?: string;
  hostVoice?: string;
  guestVoice?: string;
  narratorVoice?: string;
  speed?: number;
  guestSpeed?: number;
  /** The worker script; injectable so tests can stand in a fake. */
  script?: string;
}

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * One Python process holding the model, answering one request at a time.
 *
 * It is referenced only while a request is in flight. Idle, it must not keep
 * a command-line run alive after the episode is written; busy, it must, or
 * Node would exit with a synthesis still pending.
 */
class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /**
   * Requests made and not yet answered, counted from the moment they are made.
   * Counting only the ones sent would miss a request still waiting for the
   * model to load — which is how the first version let Node exit mid-request.
   */
  private inFlight = 0;
  private stderrTail = "";
  private markReady!: () => void;
  private failReady!: (err: Error) => void;
  /** Settles once the model has loaded, or the worker failed to start. */
  readonly ready: Promise<void>;
  dead = false;

  constructor(python: string, script: string, model: string, voices: string) {
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve;
      this.failReady = reject;
    });
    // A failed start surfaces through the synthesize() that is waiting on it.
    this.ready.catch(() => {});

    this.child = spawn(python, [script, model, voices], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg: { ready?: boolean; id?: number; ok?: boolean; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // a library printing to stdout; not a reply
      }
      if (msg.ready) {
        this.markReady();
        this.idleIfDone();
        return;
      }
      const waiting = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id!);
      if (msg.ok) waiting.resolve();
      else
        waiting.reject(
          new Error(`Kokoro synthesis failed: ${msg.error ?? "no reason given"}`),
        );
      this.idleIfDone();
    });

    // Kept for the error message only: onnxruntime is chatty on stderr.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    this.child.on("error", (err) => this.fail(err));
    this.child.on("exit", (code) =>
      this.fail(new Error(`Kokoro worker exited (code ${code}): ${this.lastError()}`)),
    );
  }

  private lastError(): string {
    const lines = this.stderrTail
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/telemetry/i.test(l));
    return lines.at(-1) ?? "no output";
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = true;
    this.failReady(err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** The pipes, which are sockets at runtime and can be (un)referenced like the process. */
  private handles(): { ref?: () => void; unref?: () => void }[] {
    const { stdin, stdout, stderr } = this.child;
    return [this.child, stdin, stdout, stderr] as unknown as {
      ref?: () => void;
      unref?: () => void;
    }[];
  }

  private busy() {
    for (const h of this.handles()) h.ref?.();
  }

  private idleIfDone() {
    if (this.inFlight > 0) return;
    for (const h of this.handles()) h.unref?.();
  }

  async synthesize(
    text: string,
    voice: string,
    speed: number,
    out: string,
  ): Promise<void> {
    this.inFlight++;
    this.busy();
    try {
      await this.ready;
      const id = this.nextId++;
      const done = new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      this.child.stdin.write(`${JSON.stringify({ id, text, voice, speed, out })}\n`);
      await done;
    } finally {
      this.inFlight--;
      this.idleIfDone();
    }
  }
}

/** Workers by configuration, shared by every provider using that model. */
const workers = new Map<string, Worker>();

function workerFor(
  python: string,
  script: string,
  model: string,
  voices: string,
): Worker {
  const key = [python, script, model, voices].join("\u0000");
  const existing = workers.get(key);
  if (existing && !existing.dead) return existing;
  const worker = new Worker(python, script, model, voices);
  workers.set(key, worker);
  return worker;
}

export class KokoroProvider implements TTSProvider {
  readonly name = "kokoro";
  readonly format = "wav" as const;
  /**
   * Kokoro splits long input into its own batches, so this only bounds a
   * single request's latency; the chunker splits on sentence boundaries.
   */
  readonly maxChars = 2_000;

  private readonly python: string;
  private readonly model: string;
  private readonly voices: string;
  private readonly hostVoice: string;
  private readonly guestVoice: string;
  private readonly narratorVoice: string;
  private readonly speed: number;
  private readonly guestSpeed: number;
  private readonly script: string;

  constructor(opts: KokoroOptions = {}) {
    const cfg = kokoroConfig();
    this.python = opts.python ?? cfg.python;
    this.model = opts.model ?? cfg.model;
    this.voices = opts.voices ?? cfg.voices;
    this.hostVoice = opts.hostVoice ?? cfg.hostVoice;
    this.guestVoice = opts.guestVoice ?? cfg.guestVoice;
    this.narratorVoice = opts.narratorVoice ?? cfg.narratorVoice;
    this.speed = opts.speed ?? cfg.speed;
    this.guestSpeed = opts.guestSpeed ?? cfg.guestSpeed;
    this.script = opts.script ?? WORKER_SCRIPT;
  }

  get description(): string {
    const faster = this.guestSpeed !== this.speed ? ` at ${this.guestSpeed}x` : "";
    return `kokoro: ${this.hostVoice} (host) / ${this.guestVoice} (guest${faster}) / ${this.narratorVoice} (narrator)`;
  }

  voiceFor(speaker: Speaker): string {
    if (speaker === "guest") return this.guestVoice;
    if (speaker === "narrator") return this.narratorVoice;
    return this.hostVoice;
  }

  /** The guest reads a little quicker; see `guestSpeed` in the config. */
  speedFor(speaker: Speaker): number {
    return speaker === "guest" ? this.guestSpeed : this.speed;
  }

  async synthesizeChunk(text: string, speaker: Speaker): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "papercast-kokoro-"));
    const out = join(dir, "chunk.wav");
    try {
      await workerFor(this.python, this.script, this.model, this.voices).synthesize(
        text,
        this.voiceFor(speaker),
        this.speedFor(speaker),
        out,
      );
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Whether the interpreter, model and voices are all present. */
export async function kokoroAvailable(opts: KokoroOptions = {}): Promise<boolean> {
  const cfg = kokoroConfig();
  for (const p of [
    opts.python ?? cfg.python,
    opts.model ?? cfg.model,
    opts.voices ?? cfg.voices,
    opts.script ?? WORKER_SCRIPT,
  ]) {
    try {
      await access(p);
    } catch {
      return false;
    }
  }
  return true;
}
