import { NextResponse } from "next/server";
import { listEpisodes } from "@/lib/library/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shelf: every episode this instance has made, newest first.
 *
 * Summaries only. A record carries the whole transcript and the paper it came
 * from, which is tens of thousands of words nobody needs to render a list.
 */
export async function GET() {
  return NextResponse.json(await listEpisodes());
}
