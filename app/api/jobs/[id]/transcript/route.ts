import { NextResponse } from "next/server";
import { store } from "../../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await store.get(id);
  if (!job?.result) {
    return NextResponse.json({ error: "No transcript for this job." }, { status: 404 });
  }
  return NextResponse.json({
    paperTitle: job.paperTitle,
    episode: job.result.episode,
    timings: job.result.timings ?? [],
    citations: job.result.citations ?? [],
    totalMs: job.result.totalMs,
    transcriptRecall: job.result.transcriptRecall,
  });
}
