import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { store } from "../../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const path = (await store.get(id))?.result?.audioPath;
  if (!path) return new Response("No audio for this job.", { status: 404 });

  // Streamed rather than buffered: an episode is tens of megabytes of PCM.
  const { size } = await stat(path);
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
}
