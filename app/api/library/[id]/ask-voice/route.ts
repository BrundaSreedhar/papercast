import { access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { WhisperCppProvider, whisperAvailable } from "@/lib/asr/index";
import { askPaper } from "@/lib/chat/index";
import { getEpisode } from "@/lib/library/store";
import { getProvider } from "@/lib/llm/index";
import { resolveTTSProvider } from "@/lib/tts/index";
import { speak } from "@/lib/tts/speak";
import { toJobError } from "@/lib/jobs/errors";
import { activeProvider, type ProviderName } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIO_DIR = join(process.cwd(), "public", "audio");
/** Half a minute of 16 kHz mono is a long spoken question. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/**
 * Ask the paper a question out loud, and get the answer back as speech.
 *
 * Three stages, all local by default: whisper.cpp reads the question, the same
 * grounded answering path the typed chat uses produces the reply, and the TTS
 * backend speaks it. Nothing here is new reasoning — the value is that a
 * listener never has to stop listening to ask something.
 *
 * The browser sends 16 kHz mono WAV because whisper.cpp wants exactly that and
 * this machine has no ffmpeg to convert with. Encoding it client-side keeps the
 * recording on the listener's machine until the moment it is transcribed.
 */
/** The most accurate model actually present, for a short spoken question. */
async function questionModel(): Promise<string | undefined> {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL;
  for (const path of [".models/ggml-small.en.bin", ".models/ggml-base.en.bin"]) {
    try {
      await access(join(process.cwd(), path));
      return path;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const record = await getEpisode(id).catch(() => undefined);
  if (!record) return NextResponse.json({ error: "No such episode." }, { status: 404 });

  if (!(await whisperAvailable())) {
    return NextResponse.json(
      {
        error: "Speech recognition is not set up on this machine.",
        remedy:
          "Install whisper.cpp and a model, or type the question instead — the typed answer is identical.",
      },
      { status: 501 },
    );
  }

  const form = await req.formData().catch(() => undefined);
  const file = form?.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No recording was sent." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "That recording is too long." }, { status: 413 });
  }

  try {
    const wav = Buffer.from(await file.arrayBuffer());
    // A spoken question is a couple of seconds long, so the larger model costs
    // almost nothing here and mishears far less — and unlike verifying a whole
    // episode, every word of a question matters. Falls back to whatever
    // WHISPER_MODEL names when the bigger one was never fetched.
    const question = (
      await new WhisperCppProvider({ modelPath: await questionModel() }).transcribe(wav)
    ).trim();
    // Silence transcribes to nothing, or to whisper's own bracketed markers for
    // non-speech. Answering either would mean answering a question nobody asked.
    const spoken = question.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
    if (spoken.length < 3) {
      return NextResponse.json(
        {
          error: "I could not make out a question there.",
          remedy: "Try again, a little closer to the microphone.",
        },
        { status: 422 },
      );
    }

    const name = (form?.get("provider") as ProviderName | null) ?? record.provider;
    const reply = await askPaper(record.paper, spoken, {
      provider: getProvider((name as ProviderName) || undefined),
      // Same reasoning as the typed path: a local model cannot hold the paper.
      retrieve: ((name as ProviderName) || activeProvider()) === "open",
    });

    // Speaking the answer is best-effort: a reader who can see the text has
    // still had their question answered, and failing the whole request because
    // a voice model is missing would take that away too.
    let audioUrl: string | undefined;
    try {
      const tts = await resolveTTSProvider();
      const said = await speak(reply.answer, tts);
      const name = `answer-${randomUUID()}.wav`;
      await mkdir(AUDIO_DIR, { recursive: true });
      await writeFile(join(AUDIO_DIR, name), said.audio);
      audioUrl = `/audio/${name}`;
    } catch (err) {
      console.warn(`[ask-voice ${id}] could not speak the answer:`, err);
    }

    return NextResponse.json({ question: spoken, ...reply, audioUrl });
  } catch (err) {
    console.error(`[ask-voice ${id}]`, err);
    const e = toJobError(err);
    return NextResponse.json({ error: e.message, remedy: e.remedy }, { status: 502 });
  }
}
