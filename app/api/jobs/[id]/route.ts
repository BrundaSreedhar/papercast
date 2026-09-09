import { NextResponse } from "next/server";
import { store } from "../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await store.get(id);
  if (!job) return NextResponse.json({ error: "No such job." }, { status: 404 });
  return NextResponse.json(job);
}
