import { NextResponse } from "next/server";
import { askPaper, type ChatTurn } from "@/lib/chat/index";
import { getEpisode } from "@/lib/library/store";
import { getProvider } from "@/lib/llm/index";
import { toJobError } from "@/lib/jobs/errors";
import { activeProvider, type ProviderName } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether sending part of the paper beats sending all of it.
 *
 * For a self-hosted model, yes, and not as an optimisation: the stock qwen2:7b
 * defaults to a 4,096-token window, and a paper of seventeen thousand tokens
 * fails outright against it. Retrieval is what makes a small model able to
 * answer at all.
 *
 * For a hosted provider, no. They cache the prefix, so the whole paper costs
 * almost nothing after the first question, and more context is strictly better
 * for an answer that has to be right.
 */
function retrievalPays(provider: ProviderName | undefined): boolean {
  return (provider ?? activeProvider()) === "open";
}

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

  // Default to whichever model wrote the episode, so an answer comes from the
  // same place the transcript did unless the reader says otherwise.
  const name = (body.provider ?? record.provider) as ProviderName | undefined;

  if (new URL(req.url).searchParams.get("stream") === "1") {
    return streamAnswer(id, record.paper, question, history, name);
  }

  try {
    const reply = await askPaper(record.paper, question, {
      provider: getProvider(name),
      history,
      retrieve: retrievalPays(name),
    });
    return NextResponse.json(reply);
  } catch (err) {
    console.error(`[chat ${id}]`, err);
    const e = toJobError(err);
    return NextResponse.json({ error: e.message, remedy: e.remedy }, { status: 502 });
  }
}

/**
 * The same answer, sent as it is written.
 *
 * Two kinds of event, because they are two different things. `text` is the
 * prose so far and may be replaced wholesale by the next one — it is a preview,
 * not a transcript of deltas. `done` carries the real reply: the kind, the
 * citations that survived being looked up, and whether it is grounded. A client
 * that renders `text` and then ignores `done` would show an answer with no
 * label and no sources, which is the one thing this must not do.
 */
function streamAnswer(
  id: string,
  paper: Awaited<ReturnType<typeof getEpisode>> extends infer R
    ? R extends { paper: infer P }
      ? P
      : never
    : never,
  question: string,
  history: ChatTurn[],
  provider: ProviderName | undefined,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true; // the reader went away
        }
      };

      try {
        const reply = await askPaper(paper, question, {
          provider: getProvider(provider),
          history,
          retrieve: retrievalPays(provider),
          onText: (soFar) => send("text", { text: soFar }),
        });
        send("done", reply);
      } catch (err) {
        console.error(`[chat ${id}]`, err);
        const e = toJobError(err);
        send("failed", { error: e.message, remedy: e.remedy });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
