import { NextResponse } from "next/server";
import { loadCatalogue } from "@/lib/demo/index";
import { demo } from "../demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this particular deployment will let the page do.
 *
 * The client cannot infer it: the same build runs locally with uploads and
 * publicly without them, and the difference is an environment variable. Asking
 * the server keeps that knowledge in one place, so the page renders a paper
 * picker or a drop zone from the answer rather than from a build flag.
 */
export async function GET() {
  if (!demo.enabled) return NextResponse.json({ demo: false });

  return NextResponse.json({
    demo: true,
    maxMinutes: demo.maxMinutes,
    papers: await loadCatalogue(),
  });
}
