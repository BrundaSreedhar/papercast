"use client";

import { useEffect, useRef, useState } from "react";

interface Citation {
  page: number;
  pageEnd?: number;
  heading: string;
  text: string;
  match: "exact" | "approximate";
}

type AnswerKind = "from-paper" | "background" | "not-addressed";

interface Exchange {
  question: string;
  answer?: string;
  kind?: AnswerKind;
  grounded?: boolean;
  citations?: Citation[];
  error?: string;
  remedy?: string;
}

/**
 * Asking the paper a question, with the passages behind the answer.
 *
 * The sources are the point, not decoration. An answer with no citations is
 * either the paper declining to address the question — which is a real answer
 * and shown as one — or a claim nothing in the paper was found to support, and
 * a reader deserves to be able to tell those apart at a glance.
 */
export function PaperChat({
  episodeId,
  paperTitle,
}: {
  episodeId: string;
  paperTitle: string;
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Send the paper through the model as soon as the page is open, so the first
  // question does not pay for reading it. Fire and forget: the response says
  // whether it warmed, and there is nothing useful to do with either answer.
  useEffect(() => {
    const stop = new AbortController();
    void fetch(`/api/library/${episodeId}/warm`, {
      method: "POST",
      signal: stop.signal,
    }).catch(() => {
      /* warming is an optimization, never an error the reader sees */
    });
    return () => stop.abort();
  }, [episodeId]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;

    setQuestion("");
    setAsking(true);
    const index = exchanges.length;
    setExchanges((list) => [...list, { question: q }]);

    // Only completed exchanges are replayed, so a failed one does not travel
    // back as though the paper had said something.
    const history = exchanges
      .filter((x) => x.answer)
      .flatMap((x) => [
        { role: "user" as const, content: x.question },
        { role: "assistant" as const, content: x.answer! },
      ]);

    const patch = (fields: Partial<Exchange>) =>
      setExchanges((list) => list.map((x, i) => (i === index ? { ...x, ...fields } : x)));

    try {
      const res = await fetch(`/api/library/${episodeId}/chat?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        patch({ error: data.error ?? "That did not work.", remedy: data.remedy });
        return;
      }

      // Read the events by hand rather than with EventSource, which can only
      // issue GETs and this is a POST carrying the question and its history.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; a partial one stays buffered.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !raw) continue;
          const data = JSON.parse(raw);

          // `text` is the prose so far, replaced wholesale each time; `done`
          // carries the label and the citations that survived being looked up.
          if (event === "text") patch({ answer: data.text });
          else if (event === "done")
            patch({
              answer: data.answer,
              kind: data.kind,
              grounded: data.grounded,
              citations: data.citations,
            });
          else if (event === "failed") patch({ error: data.error, remedy: data.remedy });
        }
      }
    } catch {
      patch({ error: "Could not reach the server." });
    } finally {
      setAsking(false);
      inputRef.current?.focus();
    }
  }

  return (
    <section className="card chat">
      <h2>Ask the paper</h2>
      <p className="sub">
        Answers about {paperTitle.length > 60 ? "this paper" : paperTitle} come with the
        passages behind them. Ask about a concept the paper assumes and you will get an
        explanation instead, marked as not coming from the paper.
      </p>

      {exchanges.map((x, i) => (
        <div key={i} className="exchange">
          <p className="q">{x.question}</p>

          {x.error ? (
            <p className="a err-text">
              {x.error}
              {x.remedy && <span className="sources"> {x.remedy}</span>}
            </p>
          ) : x.answer === undefined ? (
            <p className="a sub">Reading the paper…</p>
          ) : (
            <>
              {x.kind === "background" && (
                <p className="kind background">
                  General background — not from this paper
                </p>
              )}
              <p className="a">{x.answer}</p>
              {x.citations && x.citations.length > 0 ? (
                <p className="sources">
                  {x.citations.map((c, j) => (
                    <span key={j} title={c.text}>
                      {j > 0 && " · "}
                      {c.heading}, p.{" "}
                      {c.pageEnd && c.pageEnd !== c.page
                        ? `${c.page}–${c.pageEnd}`
                        : c.page}
                      {c.match === "approximate" && " ≈"}
                    </span>
                  ))}
                </p>
              ) : (
                x.kind === "from-paper" && (
                  <p className="sources unsupported">
                    Nothing in the paper was found to support this. Treat it with
                    suspicion — the answer may describe something the paper does not say.
                  </p>
                )
              )}
            </>
          )}
        </div>
      ))}

      <form onSubmit={ask} className="ask">
        <input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What write quorum does it use?"
          aria-label="Ask a question about the paper"
          maxLength={1000}
        />
        <button type="submit" disabled={asking || !question.trim()}>
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
