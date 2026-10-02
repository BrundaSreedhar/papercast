import { join } from "node:path";
import { audioResponse, isSafeAudioId } from "../../../audioResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An episode's recording, read from disk rather than from `public/`.
 *
 * The library page used to point its player straight at `/audio/<id>.wav`,
 * which works for the recordings baked into the image and 404s for every one
 * the deployment makes itself — Next decides what `public/` holds when it
 * starts. Going through a route means the player does not care when the file
 * appeared.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSafeAudioId(id)) return new Response("Not an episode id.", { status: 400 });
  return audioResponse(join(process.cwd(), "public", "audio", `${id}.wav`), req);
}
