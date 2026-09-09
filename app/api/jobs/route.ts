import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { store } from "../store";
import { demo, gate } from "../demo";
import { loadCatalogue, paperPath } from "@/lib/demo/index";
import { runJob } from "@/lib/jobs/pipeline";
import type { ProviderName } from "@/lib/config/env";
import type { EpisodeFormat } from "@/lib/llm/generateEpisode";
import type { TTSProviderName } from "@/lib/tts/index";

export const runtime = "nodejs";
// The pipeline reads models from disk and shells out to local binaries, so
// nothing here can be cached or statically rendered.
export const dynamic = "force-dynamic";

const AUDIO_DIR = join(process.cwd(), "public", "audio");
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function GET() {
  // Results carry a whole episode; the list only needs the state.
  const jobs = await store.list();
  return NextResponse.json(jobs.map(({ result: _r, ...rest }) => rest));
}

export async function POST(req: Request) {
  const form = await req.formData();

  // Where the paper comes from is the one thing the two deployments disagree
  // about: locally you bring your own, publicly you pick one off the shelf.
  // Everything below this point is identical, because it is the same pipeline.
  const input = demo.enabled ? await demoPaper(form) : await uploadedPaper(form);
  if ("error" in input) {
    return NextResponse.json({ error: input.error }, { status: input.status });
  }

  const asked = Number(form.get("minutes") ?? 4);
  const minutes = demo.enabled
    ? Math.min(Math.max(1, Math.round(asked) || 4), demo.maxMinutes)
    : asked;
  // Verification transcribes the audio back with whisper.cpp, which is not in
  // the deployed image; asking for it there would advertise a stage that
  // silently never runs.
  const verify = !demo.enabled && form.get("verify") === "true";
  const revise = form.get("revise") === "true";
  // In demo mode the provider is whichever one the deployment holds
  // credentials for. A visitor choosing "local" would pick an Ollama server
  // that exists on a laptop and nowhere else.
  const provider = demo.enabled
    ? undefined
    : ((form.get("provider") as ProviderName | null) ?? undefined);
  // Anything unrecognized falls back to the dialogue rather than erroring: the
  // format changes how an episode sounds, not whether one can be made.
  const asked_format = form.get("format");
  const format: EpisodeFormat =
    asked_format === "solo" || asked_format === "eli5" ? asked_format : "dialogue";

  if (demo.enabled) {
    const admission = gate.admit();
    if (!admission.ok) {
      return NextResponse.json(
        { error: admission.message, remedy: admission.remedy },
        { status: admission.status },
      );
    }
  }

  const job = await store.create({ minutes, provider, verify, revise, format });
  await mkdir(AUDIO_DIR, { recursive: true });

  // Deliberately not awaited: the response returns an id immediately and the
  // work continues in the background, which is the whole point of a job. The
  // gate is released however that work ends, including the ways it ends badly.
  void runJob(store, job.id, {
    pdf: input.pdf,
    minutes,
    provider,
    ttsProvider: (form.get("tts") as TTSProviderName | null) ?? undefined,
    verify,
    revise,
    format,
    paperId: input.paperId,
    paperTitle: input.paperTitle,
    audioPath: join(AUDIO_DIR, `${job.id}.wav`),
  }).finally(() => {
    if (demo.enabled) gate.release();
  });

  return NextResponse.json({ id: job.id, stage: job.stage }, { status: 202 });
}

type PaperInput =
  | { pdf: Buffer; paperId?: string; paperTitle?: string }
  | { error: string; status: number };

/** The local path: whatever PDF was dropped on the page. */
async function uploadedPaper(form: FormData): Promise<PaperInput> {
  const file = form.get("pdf");

  if (!(file instanceof File)) {
    return { error: "Upload a PDF in the 'pdf' field.", status: 400 };
  }
  if (file.type !== "application/pdf") {
    return { error: "That file is not a PDF.", status: 400 };
  }
  if (file.size > MAX_PDF_BYTES) {
    return { error: "That PDF is larger than 25 MB.", status: 413 };
  }

  return { pdf: Buffer.from(await file.arrayBuffer()) };
}

/** The public path: one of the papers the deployment ships with. */
async function demoPaper(form: FormData): Promise<PaperInput> {
  const id = form.get("paper");
  if (typeof id !== "string") {
    return {
      error: "This deployment runs its own papers. Pick one from the list.",
      status: 400,
    };
  }

  // Checked against the catalogue rather than trusted as a filename, so the id
  // can only ever name a paper this deployment chose to offer.
  const papers = await loadCatalogue();
  const paper = papers.find((p) => p.id === id);
  if (!paper) {
    return { error: "That paper is not one of the ones on offer.", status: 404 };
  }

  // The catalogue's title is authoritative for these three, which spares the
  // demo a paper introduced by whatever text happens to sit at the top of
  // page one.
  return {
    pdf: await readFile(paperPath(paper.id)),
    paperId: paper.id,
    paperTitle: paper.title,
  };
}
