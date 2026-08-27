import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { store } from "../store";
import { runJob } from "@/lib/jobs/pipeline";
import type { ProviderName } from "@/lib/config/env";
import type { TTSProviderName } from "@/lib/tts/index";

export const runtime = "nodejs";
// The pipeline reads models from disk and shells out to local binaries, so
// nothing here can be cached or statically rendered.
export const dynamic = "force-dynamic";

const AUDIO_DIR = join(process.cwd(), "public", "audio");
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function GET() {
  // Results carry a whole episode; the list only needs the state.
  return NextResponse.json(store.list().map(({ result: _r, ...rest }) => rest));
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("pdf");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Upload a PDF in the 'pdf' field." }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "That file is not a PDF." }, { status: 400 });
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "That PDF is larger than 25 MB." }, { status: 413 });
  }

  const minutes = Number(form.get("minutes") ?? 4);
  const verify = form.get("verify") === "true";
  const revise = form.get("revise") === "true";
  const provider = (form.get("provider") as ProviderName | null) ?? undefined;
  const job = store.create({ minutes, provider, verify, revise });

  const pdf = Buffer.from(await file.arrayBuffer());
  await mkdir(AUDIO_DIR, { recursive: true });

  // Deliberately not awaited: the response returns an id immediately and the
  // work continues in the background, which is the whole point of a job.
  void runJob(store, job.id, {
    pdf,
    minutes,
    provider,
    ttsProvider: (form.get("tts") as TTSProviderName | null) ?? undefined,
    verify,
    revise,
    audioPath: join(AUDIO_DIR, `${job.id}.wav`),
  });

  return NextResponse.json({ id: job.id, stage: job.stage }, { status: 202 });
}
