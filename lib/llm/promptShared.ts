/**
 * Prompt text shared by everything that writes episode turns.
 *
 * The faithfulness rules live here rather than in the writer because the writer
 * is no longer the only caller: a continuation pass finishes an episode that
 * stopped short, and it has to be held to exactly the same standard. A second
 * copy of these rules is a second standard, whatever the intention.
 *
 * The faithfulness rules do not depend on how many voices the episode has, and
 * are shared verbatim so a change to what counts as honest can never apply to
 * one format and not another.
 */
export const FAITHFULNESS = `FAITHFULNESS — this is the top priority:
- Use ONLY information contained in the provided paper. Do not add outside facts, prior knowledge, comparisons, or citations that are not in the text.
- Never invent numbers, results, author names, dataset names, or references. If a detail isn't in the paper, don't state it.
- If the paper is ambiguous or silent on something, either omit it or say the paper does not specify — do not fill the gap with a guess.
- Prefer the paper's own framing and terminology; spell out each acronym the first time you use it.
- The source may end with a "Figures and tables" section describing what the paper's diagrams and tables show. Those descriptions were produced by a model reading the page, not quoted from the paper, so treat them as slightly weaker evidence: use them to explain how something is structured or what a result looked like, attribute them as what the figure shows, and do not state a number from a figure unless the description gives it explicitly.`;

/**
 * The rule against selling the paper.
 *
 * Shared for the reason the faithfulness block is. A continuation written
 * without it immediately produced "a paradigm shift in neural network
 * architectures" on the first real run — a claim about the paper's importance
 * that the paper does not make, arriving in the closing turn, which is the one
 * a listener remembers.
 */
export const NO_HYPE = `Do not call the work groundbreaking, revolutionary, or a paradigm shift unless the paper says so itself — describing a paper as important is a claim about it, and it is not yours to make.`;
