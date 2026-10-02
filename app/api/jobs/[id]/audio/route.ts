import { store } from "../../../store";
import { audioResponse } from "../../../audioResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The path comes from the job record rather than from the id, so it is the
  // file this job actually wrote.
  const path = (await store.get(id))?.result?.audioPath;
  if (!path) return new Response("No audio for this job.", { status: 404 });
  return audioResponse(path, req);
}
