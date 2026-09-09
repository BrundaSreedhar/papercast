import { NextResponse } from "next/server";
import { askPaper } from "@/lib/chat/index";
import { getEpisode } from "@/lib/library/store";
import { getProvider } from "@/lib/llm/index";
import { activeProvider, type ProviderName } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Put the paper through the model once, so the first real question is not the
 * slow one.
 *
 * Measured on this machine with a 7B local model and the transformer paper:
 * the first question took 36 seconds, of which 32 were the model reading the
 * paper before writing a word. The second took one second, because the runtime
 * had kept the work of reading that same prefix. The wait a reader complains
 * about is almost entirely that first read, and it does not have to happen
 * while they watch.
 *
 * Only for self-hosted models. On a metered provider this would spend real
 * money on every page view for someone who may never ask anything — and those
 * providers cache the prefix themselves, which is what `cacheableContext` is
 * for, so there is nothing here to win.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const record = await getEpisode(id).catch(() => undefined);
  if (!record) return NextResponse.json({ error: "No such episode." }, { status: 404 });

  const provider = ((record.provider as ProviderName | undefined) ??
    activeProvider()) as ProviderName;
  if (provider !== "open") return NextResponse.json({ warmed: false, reason: "metered" });

  try {
    // A real question rather than an empty one: the point is to make the model
    // read the paper, and the answer is thrown away.
    await askPaper(record.paper, "What is this paper about?", {
      provider: getProvider(provider),
    });
    return NextResponse.json({ warmed: true });
  } catch (err) {
    // Warming is an optimization. Failing it changes nothing a reader can see,
    // so it is logged and forgotten rather than surfaced.
    console.warn(`[warm ${id}] could not prime the model:`, err);
    return NextResponse.json({ warmed: false, reason: "failed" });
  }
}
