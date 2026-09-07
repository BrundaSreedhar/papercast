import { NextResponse } from "next/server";
import { getEpisode } from "@/lib/library/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One episode, ready to play and read.
 *
 * The paper is deliberately withheld. It rides along in the stored record so
 * questions can be answered against exactly the text the models saw, but it is
 * the largest thing in there by far and no part of the page renders it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const record = await getEpisode(id).catch(() => undefined);
  if (!record) return NextResponse.json({ error: "No such episode." }, { status: 404 });

  const { paper: _paper, ...rest } = record;
  return NextResponse.json(rest);
}
