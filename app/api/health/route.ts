import { NextResponse } from "next/server";
import { store } from "../store";
import { demo, gate } from "../demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The platform's health check, and the first thing to read when the deployment
 * is behaving oddly.
 *
 * It reports what the process is doing rather than only that it is alive, since
 * "up" is rarely the question — whether the demo gate is holding, and how much
 * of today's allowance is gone, is what actually explains a refused job.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    demo: demo.enabled,
    jobs: (await store.list()).length,
    ...(demo.enabled ? { gate: gate.status() } : {}),
  });
}
