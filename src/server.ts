#!/usr/bin/env node
/**
 * HTTP API over the job pipeline.
 *
 *   npm run serve
 *   curl -F pdf=@paper.pdf -F minutes=4 localhost:8000/api/jobs
 *   curl -N localhost:8000/api/jobs/<id>/stream
 *
 * Kept deliberately thin: every decision lives in lib/jobs, so this file is
 * transport only and the same pipeline runs unchanged behind a Next.js route
 * handler in the next phase.
 */
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { MemoryJobStore } from "../lib/jobs/store";
import { runJob } from "../lib/jobs/pipeline";
import type { ProviderName } from "../lib/config/env";
import type { TTSProviderName } from "../lib/tts/index";
import { initTracing, shutdownTracing } from "../lib/trace/index";

const AUDIO_DIR = join(process.cwd(), "public", "audio");
// A server has no argv to flag, so the standard OTel endpoint variable is the
// switch. No waterfall: a long-lived process would collect spans forever and
// never reach the point where they get rendered.
if (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
) {
  initTracing({ serviceName: "paper-to-podcast-server", waterfall: false });
}

const PORT = Number(process.env.PORT ?? 8000);
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const store = new MemoryJobStore();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(process.cwd(), "public")));

/** Routes that carry a job id, so `req.params.id` survives the wrapper as a string. */
type IdParams = { id: string };

/**
 * Express 4 does not catch a rejected promise from an async handler: it becomes
 * an unhandled rejection and takes the process down. Now that reading a job can
 * fail — a store may answer over a network — every route that awaits one goes
 * through this, so a failing store returns a 500 instead of ending the server.
 */
const route =
  <P = Record<string, string>>(
    fn: (req: Request<P>, res: Response) => Promise<unknown>,
  ) =>
  (req: Request<P>, res: Response) => {
    void fn(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong." });
    });
  };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, cb) => {
    // Reject non-PDFs at the door rather than failing later in extraction.
    cb(null, file.mimetype === "application/pdf");
  },
});

/**
 * Start a job and return immediately. The work outlives the request, which is
 * the whole point: generation and synthesis take longer than any sensible HTTP
 * timeout, and a client that disconnects should not cancel the episode.
 */
app.post(
  "/api/jobs",
  upload.single("pdf"),
  route(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Upload a PDF in the 'pdf' field." });
    }

    const minutes = Number(req.body.minutes ?? 4);
    const job = await store.create({
      minutes,
      provider: req.body.provider,
      verify: req.body.verify === "true",
    });

    void mkdir(AUDIO_DIR, { recursive: true }).then(() =>
      runJob(store, job.id, {
        pdf: req.file!.buffer,
        minutes,
        provider: req.body.provider as ProviderName | undefined,
        ttsProvider: req.body.tts as TTSProviderName | undefined,
        verify: req.body.verify === "true",
        audioPath:
          req.body.audio === "false" ? undefined : join(AUDIO_DIR, `${job.id}.wav`),
      }),
    );

    res.status(202).json({ id: job.id, stage: job.stage });
  }),
);

app.get(
  "/api/jobs",
  route(async (_req, res) => {
    const jobs = await store.list();
    res.json(jobs.map(({ result: _r, ...rest }) => rest));
  }),
);

app.get(
  "/api/jobs/:id",
  route<IdParams>(async (req, res) => {
    const job = await store.get(req.params.id);
    if (!job) return res.status(404).json({ error: "No such job." });
    res.json(job);
  }),
);

/** Progress as server-sent events, including everything that already happened. */
app.get(
  "/api/jobs/:id/stream",
  route<IdParams>(async (req, res) => {
    const job = await store.get(req.params.id);
    if (!job) return res.status(404).json({ error: "No such job." });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming.
      "X-Accel-Buffering": "no",
    });

    // A disconnected client, or a bug, must not be able to take the process down
    // by writing to a finished response.
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      res.end();
    };
    res.on("error", () => {
      closed = true;
    });

    // The terminal check reads the *event's* stage, not the job's. On a finished
    // job every replayed event would otherwise look terminal, so the stream would
    // end on the first one and then write to a closed response.
    const unsubscribe = await store.subscribe(req.params.id, (j, e) => {
      send("progress", { stage: e.stage, percent: e.percent, message: e.message });
      if (e.stage === "done") {
        send("done", {
          paperTitle: j.paperTitle,
          turns: j.result?.episode.turns.length,
          totalMs: j.result?.totalMs,
          transcriptRecall: j.result?.transcriptRecall,
          cost: j.cost,
          audioUrl: j.result?.audioPath ? `/api/jobs/${j.id}/audio` : undefined,
        });
        finish();
      } else if (e.stage === "error") {
        send("failed", j.error);
        finish();
      }
    });

    // A client that navigates away should not leave a listener behind. The
    // subscription is awaited above, so by here it always exists to be undone.
    req.on("close", () => {
      closed = true;
      unsubscribe();
    });
  }),
);

app.get(
  "/api/jobs/:id/audio",
  route<IdParams>(async (req, res) => {
    const job = await store.get(req.params.id);
    if (!job?.result?.audioPath)
      return res.status(404).json({ error: "No audio for this job." });
    res.setHeader("Content-Type", "audio/wav");
    createReadStream(job.result.audioPath).pipe(res);
  }),
);

app.get(
  "/api/jobs/:id/transcript",
  route<IdParams>(async (req, res) => {
    const job = await store.get(req.params.id);
    if (!job?.result)
      return res.status(404).json({ error: "No transcript for this job." });
    res.json({
      paperTitle: job.paperTitle,
      episode: job.result.episode,
      timings: job.result.timings,
      totalMs: job.result.totalMs,
    });
  }),
);

const server = app.listen(PORT, () => {
  console.log(`\n🎙️   PaperCast API on http://localhost:${PORT}`);
  console.log(`    POST /api/jobs                 start a job (multipart: pdf, minutes)`);
  console.log(`    GET  /api/jobs/:id/stream      progress as server-sent events`);
  console.log(`    GET  /api/jobs/:id/audio       finished audio\n`);
});

// Drain buffered spans on the way out; between signals the batch processor
// flushes on its own schedule, so normal operation costs nothing per request.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    server.close();
    void shutdownTracing().then(() => process.exit(0));
  });
}
