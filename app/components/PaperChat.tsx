"use client";

import { useRef, useState } from "react";

interface Citation {
  page: number;
  pageEnd?: number;
  heading: string;
  text: string;
  match: "exact" | "approximate";
}

interface Exchange {
  question: string;
  answer?: string;
  answered?: boolean;
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

    try {
      const res = await fetch(`/api/library/${episodeId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      const data = await res.json();
      setExchanges((list) =>
        list.map((x, i) =>
          i === index
            ? res.ok
              ? {
                  ...x,
                  answer: data.answer,
                  answered: data.answered,
                  grounded: data.grounded,
                  citations: data.citations,
                }
              : { ...x, error: data.error ?? "That did not work.", remedy: data.remedy }
            : x,
        ),
      );
    } catch {
      setExchanges((list) =>
        list.map((x, i) =>
          i === index ? { ...x, error: "Could not reach the server." } : x,
        ),
      );
    } finally {
      setAsking(false);
      inputRef.current?.focus();
    }
  }

  return (
    <section className="card chat">
      <h2>Ask the paper</h2>
      <p className="sub">
        Answered only from {paperTitle.length > 60 ? "this paper" : paperTitle}, with the
        passages behind each answer. If the paper does not say, it says so.
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
                x.answered && (
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
