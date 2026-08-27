import { store } from "../../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Progress as server-sent events.
 *
 * Subscribing replays everything that already happened before live events
 * arrive, so reloading the page mid-episode shows the whole story rather than
 * an empty progress bar.
 *
 * The terminal check reads each *event's* stage rather than the job's current
 * one. On a finished job every replayed event would otherwise look terminal,
 * closing the stream on the first and then writing to a closed controller.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = store.get(id);
  if (!job) {
    return new Response(JSON.stringify({ error: "No such job." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // client went away mid-write
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      unsubscribe = store.subscribe(id, (j, e) => {
        send("progress", { stage: e.stage, percent: e.percent, message: e.message });
        if (e.stage === "done") {
          send("done", {
            paperTitle: j.paperTitle,
            turns: j.result?.episode.turns.length,
            totalMs: j.result?.totalMs,
            transcriptRecall: j.result?.transcriptRecall,
            review: j.result?.review,
            reviewError: j.result?.reviewError,
            cost: j.cost,
          });
          finish();
        } else if (e.stage === "error") {
          send("failed", j.error);
          finish();
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
