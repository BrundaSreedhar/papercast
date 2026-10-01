/**
 * Serving a recording off disk, for the routes that have one.
 *
 * `public/` cannot do this job. Next's standalone server decides what is in
 * `public/` when it starts, so a file written afterwards — which is every
 * episode a deployment makes — is a 404 no matter that it is sitting right
 * there. It works in development, because `next dev` reads the directory per
 * request, which is exactly why this was invisible until a deployment made its
 * first episode and could not play it back.
 *
 * Range requests are honoured rather than merely advertised. A player asking
 * for the middle of a file and being handed all forty megabytes from the start
 * is how seeking appears to work in one browser and hang in another; the
 * previous version sent `Accept-Ranges` and then ignored the header.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseRange } from "@/lib/library/audio";

export { isSafeAudioId } from "@/lib/library/audio";

/** Stream a wav from disk, honouring a range request if one was made. */
export async function audioResponse(path: string, req: Request): Promise<Response> {
  let size: number;
  try {
    ({ size } = await stat(path));
  } catch {
    return new Response("No audio for this episode.", { status: 404 });
  }

  const range = parseRange(req.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response("That range is not in the file.", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  // Streamed rather than buffered: an episode is tens of megabytes of PCM.
  const stream = range
    ? createReadStream(path, { start: range.start, end: range.end })
    : createReadStream(path);
  const body = Readable.toWeb(stream) as ReadableStream;

  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(range ? range.end - range.start + 1 : size),
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
      // Episodes are immutable once made, and are named by a unique id.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
