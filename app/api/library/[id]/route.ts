import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getEpisode, removeEpisode } from "@/lib/library/store";

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

/**
 * Remove an episode for good.
 *
 * The recording goes with the record. Leaving it behind would accumulate tens
 * of megabytes per deleted episode in a directory nothing lists any more, and
 * an id is enough to guess a URL for audio the shelf no longer admits to
 * holding. The record is removed first: an orphaned file is untidy, whereas a
 * record pointing at audio that is gone is a broken page.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const record = await getEpisode(id).catch(() => undefined);
  if (!record) return NextResponse.json({ error: "No such episode." }, { status: 404 });

  await removeEpisode(id);
  if (record.hasAudio) {
    await rm(join(process.cwd(), "public", "audio", `${id}.wav`), { force: true }).catch(
      (err) => console.warn(`[library ${id}] could not remove the audio:`, err),
    );
  }
  return NextResponse.json({ deleted: id });
}
