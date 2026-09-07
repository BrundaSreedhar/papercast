import { NextResponse } from "next/server";
import { askPaper, type ChatTurn } from "@/lib/chat/index";
import { getEpisode } from "@/lib/library/store";
import { getProvider } from "@/lib/llm/index";
import { toJobError } from "@/lib/jobs/errors";
import type { ProviderName } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Questions long enough to be a question, short enough not to be a prompt. */
const MAX_QUESTION = 1_000;

/**
 * Ask the paper behind an episode a question.
 *
 * Answers are grounded the same way the transcript is: the model quotes the
 * passages it relied on, and each is resolved to a section and page. A quote
 * that is not in the paper is dropped, so a fabricated citation becomes a
 * missing one rather than a convincing one.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const record = await getEpisode(id).catch(() => undefined);
  if (!record) return NextResponse.json({ error: "No such episode." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    question?: unknown;
    history?: unknown;
    provider?: unknown;
  };

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Ask a question." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION) {
    return NextResponse.json({ error: "That question is too long." }, { status: 413 });
  }

  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (t): t is ChatTurn =>
            !!t &&
            typeof (t as ChatTurn).content === "string" &&
            ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant"),
        )
        .slice(-10)
    : [];

  try {
    // Default to whichever model wrote the episode, so an answer comes from the
    // same place the transcript did unless the reader says otherwise.
    const name = (body.provider ?? record.provider) as ProviderName | undefined;
    const reply = await askPaper(record.paper, question, {
      provider: getProvider(name),
      history,
    });
    return NextResponse.json(reply);
  } catch (err) {
    console.error(`[chat ${id}]`, err);
    const e = toJobError(err);
    return NextResponse.json({ error: e.message, remedy: e.remedy }, { status: 502 });
  }
}
