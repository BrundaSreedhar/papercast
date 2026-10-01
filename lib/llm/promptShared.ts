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
- Never say the names of the paper's authors, anywhere in the episode, even though the paper lists them. Call them "the authors", or say where they work when you are told: "researchers at Google Brain and the University of Toronto". Never guess where they work.
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

/**
 * How the words should sound coming out of a speaker.
 *
 * The dialogue format had one line about this — "write spoken language" — and
 * produced episodes that opened "Welcome back to PaperCast, where we dive into
 * the latest breakthroughs", with every turn the same length and the abstract's
 * phrasing carried intact into speech. The solo format already banned several
 * of those exact words, which is how a rule meant for both formats came to
 * apply to one.
 *
 * The distinction that does the work is between a paper's *terms* and a
 * paper's *sentences*. FAITHFULNESS asks for the paper's own terminology, and
 * it should: renaming Detection Rate invents a thing. But a term is a noun,
 * not a clause, and lifting "systematically generate high-coverage,
 * discriminative test suites" into a conversation is not faithfulness, it is
 * reading the abstract aloud.
 *
 * Everything here pushes towards plainer and shorter, which is also the safer
 * direction: the longer and more ornamented an episode gets, the more of it is
 * the model's own invention.
 */
export const SPOKEN_VOICE = `VOICE — this is speech, not an article read aloud:
- Contractions throughout, and this one is literal: write "that's", "we're", "doesn't", "it's", "they've" — never "that is", "we are", "does not". A speech synthesizer reads "that is right" exactly as written, and it sounds like a form letter. A sentence you would not say out loud to someone sitting opposite you is a sentence to rewrite.
- Keep the paper's terms, not its sentences. A name the paper gives something stays as it is; its phrasing does not. "Formalize the task", "multi-dimensional metrics" and "systematically generate high-coverage test suites" are written English, and must be said in your own plain words.
- Vary the length. A one-sentence turn is as valid as a four-sentence one, and an episode where every turn is the same size sounds like a press release being read out.
- Reach for the concrete. A number, an example or a case the paper actually gives, in preference to an abstract restatement of it.
- None of the stock furniture: no "welcome back" — there is no previous episode and implying one is an invention like any other — no "dive into" or "deep dive", no "unpack", no "let's get into it", no "thanks for having me", no "great question", no "in today's episode", no "breakthrough", no "fascinating", no "it's worth noting", no "at the end of the day".
- Translate jargon the moment it appears, in a few plain words, and use the plain words from then on.`;

/**
 * What makes two voices a conversation rather than an interview.
 *
 * Without this the host becomes a prompt generator: every turn restates the
 * answer just given and asks the next question, which is the shape of an
 * interview transcript and the reason the result sounded like narration with
 * the questions left in. A listener believes two people are talking when one
 * of them reacts.
 */
export const CONVERSATION = `THE CONVERSATION — two people talking, not an interview:
- The host is in the conversation, not running it. They react, push back, say when something sounds surprising, and put an answer into plainer words before moving on. A host whose every turn summarises the last answer and then asks the next question has written an interview transcript.
- Let a turn be short. "Wait — so the tests were the problem, not the model?" does as much work as a paragraph, and the unevenness is what makes it sound like speech.
- Open in two sentences: what this paper is, and the question it takes on. No mission statement for the show, no preamble about the state of the field.
- Close on what the paper settles and what it leaves open. No sign-off flourish.`;
