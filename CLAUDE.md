# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm test                      # vitest, ~3s, no network and no filesystem
npm test -- lib/pdf           # one directory
npm test -- lib/pdf/locate.test.ts        # one file
npm test -- -t "never cites text that extraction stripped"   # one test by name
npm run typecheck             # tsc over lib/ + src/ only
npm run lint                  # eslint
npm run format                # prettier --write

npm run dev                   # Next.js app on :3000
TRACE_LOG=1 npm run dev       # ...and print every model call as it finishes
npm run build:web             # next build — the only thing that typechecks app/
npm run serve                 # the same pipeline behind Express, on :8000
npm run generate -- paper.pdf --minutes 4 [--solo|--eli5] [--provider anthropic|openai|gemini|open] [--revise] [--trace]

npm run audio -- ep.episode.json      # re-voice an existing transcript, no generation
npm run learn                         # print the study ledger
npm run learn -- record ep.episode.json --paper aurora.pdf
npm run demo:papers                   # fetch the demo shelf into demo/papers
```

`npm run audio` and `npm run learn -- record` both work on an episode JSON that
already exists, so a transcript can be re-voiced or recorded without paying to
generate it again.

There are **two TypeScript programs**. `npm run typecheck` covers `lib/` and
`src/` and explicitly excludes `app/`; the web app is only typechecked by
`npm run build:web`. A change to a route handler or a component is unverified
until that runs.

Evals (`npm run eval`, `npm run eval:validate`) are covered under "Do not run
evals on every change" below.

Every environment variable is read in `lib/config/env.ts` and nowhere else;
`.env.example` is the annotated catalogue, including the local RAM each open
model needs.

## Architecture

The pipeline is **PDF → transcript → audio**, and it lives entirely in `lib/`.
`app/` (Next.js route handlers and React) and `src/` (a CLI and an Express
server) are transports over the same code — which is what keeps `lib/`
framework-free and testable without a network or a filesystem.

**Four model interfaces carry the system**: `LLMProvider` (`lib/llm/types.ts`),
`VisionProvider`, `TTSProvider`, `ASRProvider`. Each is one method reached
through one factory, so a local voice, a hosted API and a frontier model are
interchangeable. `getProvider()` in `lib/llm/index.ts` is the _only_ place an
LLM provider is constructed, which is why wrapping it in `traced()` instruments
every inference call in the project without touching a call site.

**Zod is the contract.** `EpisodeSchema` in `lib/llm/schema.ts` is the single
source of truth, and each provider reaches it differently: Claude via a forced
`tool_choice` then validation, OpenAI via strict `json_schema`, and
OpenAI-compatible endpoints (Ollama, Gemini's compatibility layer) via
schema-in-prompt plus JSON mode, Zod validation, and a retry that feeds the parse
error back. Gemini is not a separate adapter — it is `OpenCompatibleProvider`
with a different name and config.

**Nothing under `lib/` prints.** Progress leaves through injected callbacks,
failures leave as typed errors or as state written into a store. The one place
that prints is `src/entry.ts`, which also flushes tracing — `process.exit()`
discards buffered spans, so the exit path lives there once.

**Jobs.** `lib/jobs/pipeline.ts` runs the stages and reports into a `JobStore`
(`lib/jobs/store.ts`), an async interface whose only implementation is in
memory. Because a job outlives the request that starts it and lives in the
process that started it, the app must run on a long-lived server rather than
serverless functions — `app/api/store.ts` says so where the decision is
implemented. Progress reaches a browser over SSE, but the job record is
authoritative: the page polls and reconciles, because a dropped stream must not
read as a job still running.

**Citations** (`lib/ground/`, `lib/pdf/locate.ts`) anchor each turn to a section
and page by lexical matching — no model call, no API key. They resolve against
the _rendered_ paper (`renderPaper` in `lib/pdf/extract.ts`), never the raw PDF
text, because the raw text still holds the reference list and a quote matching
inside a bibliography would produce a confident citation to a page nobody read.
A match below the confidence floor returns nothing: a wrong page is worse than
no page.

**Extraction** is section-aware rather than chunked. `PaperSection.content` is
rebuilt from filtered lines, not sliced, so provenance is tracked per line
(`SourceLine.at`) to make page lookup possible.

**Generation and answering treat the paper differently, on purpose.** Writing an
episode gets the whole paper: a four-minute summary assembled from retrieved
fragments would miss most of what the paper argues, and coverage is what stops
faithfulness rewarding silence. Answering a question retrieves
(`lib/chat/retrieve.ts`) when the provider is `open`. That is not an
optimisation — the stock `qwen2:7b` defaults to a 4,096-token window and a
17k-token paper fails against it outright, while the same question answers
correctly from retrieved sections. Hosted providers keep the whole paper, since
they cache the prefix and more context is strictly better.

Retrieval is **hybrid, and asymmetrically so**. BM25 over sections needs no
model, no key and no endpoint, so it alone decides _whether_ to retrieve: a
question with no lexical purchase on the paper falls back to the whole text.
Dense scoring (`lib/embed/`, a local embedding model over the same
OpenAI-compatible endpoint) then reorders and supplements, fused by reciprocal
rank. It is never allowed to start a retrieval BM25 declined, because cosine has
no way to say "none of these" — measured, an off-topic probe scored 0.497
against a genuine best of 0.506 on one paper, which no threshold separates. When
no embedding endpoint is reachable, retrieval is silently the lexical ranking it
always was; `Retrieved.method` reports which actually happened.

**Where state lives: files, not a database.** There is no Postgres, no vector
store and no object storage. Finished episodes are one JSON file each in
`data/episodes/` (`lib/library/store.ts`), the study ledger is `learning.json`
(`lib/learning/store.ts`), embeddings are cached per-string in
`data/embeddings/`, and audio is a WAV in `public/audio/`. Both stores write
through a temp file and a rename, because a record is the only surviving copy of
something that cost minutes and money. The library interface is deliberately the
shape a database-backed one would have — `list`/`get`/`save`/`remove` — so
swapping it touches nothing above it. An `EpisodeRecord` also carries the paper
it was made from, so a citation resolved today and a question answered next week
run against byte-identical text.

**Two subsystems are derived, not stored.** `lib/concepts/` builds the concept
map at render time from episodes' key points, keeping only terms the paper
itself uses and ranking them by frequency here against rarity across the shelf.
It is deliberately _not_ extracted from the paper directly: starting from ten key
points is what stops one paper producing two thousand concepts. `lib/learning/`
records what episodes covered and derives what is left — a gap is an annotated
contribution no episode conveyed, a suggested reading is a work the studied
papers actually cite. Neither asks a model what the reader knows; both would be
unfalsifiable if they did.

**Length is budgeted in characters, not words.** All of it lives in
`lib/llm/length.ts`. Words per minute was the obvious unit and is the wrong one:
measured across six finished episodes it ranged 149–204 (a 37% spread), because
register drives word length — an ELI5 episode gets through 200 short words a
minute where a solo episode manages 150 long ones. Characters per minute over
the same episodes ranged 1,070–1,140, a 6% spread, indifferent to format. So
`CHARS_PER_MINUTE = 1100` is the budget, `wordTargetFor(minutes, format)`
converts it back into something a prompt can ask for (a four-minute ELI5 needs
786 words where solo needs 629), and `measureLength` predicts duration from
characters — within 4% of real audio on every stored episode.

Two thresholds, deliberately different. `CONTINUE_BELOW` (0.85) is when
`generateEpisode` spends one bounded continuation call
(`lib/llm/continueEpisode.ts`) to finish the episode; `MIN_LENGTH_RATIO` (0.7)
is the eval harness's line for calling an episode collapsed. They were briefly
the same constant, and at 0.7 a four-minute request could deliver 2.9 minutes
and be waved through.

Two rules about the continuation. It appends turns only — the summary and key
points were written against the whole paper, and asking again invites a second,
different one — and `appendTurns` drops a turn on the wrong speaker, because
strict host/guest alternation is an error-level check where length is only a
warning. Its prompt shares `FAITHFULNESS` and `NO_HYPE` from
`lib/llm/promptShared.ts` **verbatim**: written without the second of those, the
first real continuation closed an episode by calling the paper "a paradigm
shift". Add shared prompt text there rather than restating it.

**Demo mode changes what the app will do.** With `DEMO_MODE=1`
(`lib/demo/`, configured by `demoConfig()`), uploads are refused and a fixed
shelf of fetched papers is offered instead, episode length is capped, and two
limits apply: concurrency protects the machine, since synthesis holds a neural
voice in memory, and a rolling daily count protects the bill. Both refuse
explicitly with the ceiling that was hit — a demo that silently queues looks
broken and one that silently degrades teaches the visitor nothing.

## The judge is not part of the main flow

`lib/eval/` is the eval harness. It exists to measure the pipeline, not to run
it. The dependency points one way: the harness may read production code, and
production code must not reach into the harness for anything a normal run
depends on.

The one exception is deliberate and opt-in: `--revise` (the `reviewing` stage)
runs `refineEpisode`, which uses the judge to fact-check and repair a script. It
is **off by default** in both the CLI and the web app, and a plain run never
touches it. Do not add anything that makes an ordinary generation depend on the
judge — citations, references and progress reporting must all work with review
switched off.

Known layering debt, partly paid: `lib/jobs/pipeline.ts` still imports
`runAudioChecks`, `verifyPerTurn` and `estimateCost` from `lib/eval/`. Those are
production concerns living in the wrong folder. Transcription has already moved
out to `lib/asr/` — it gained a second production caller when a listener could
ask a question out loud, and a third import in that direction was the wrong way
to answer it. Move the remaining three the same way rather than adding more.

## Tracing and the detailed log

Spans follow the OpenTelemetry GenAI conventions and every model call is
instrumented by `traced()` wrapping the one factory, so nothing has a call site
to change. Three destinations, and they answer different questions:
`TRACE_LOG=1` prints a line per span beside a dev server, `--trace` renders a
waterfall when a command ends, and an OTLP endpoint takes the whole tree.

**LangSmith is an exporter, not an integration.** It accepts OTLP and reads the
GenAI conventions, so `LANGSMITH_API_KEY` is all it takes — no SDK, no second
instrumentation path, no wrapper at any call site. `lib/trace/langsmith.ts`
holds the endpoint, the headers and its tag vocabulary, and is the **only** file
allowed to know those names; everything else emits spec attributes and stays
free of any one vendor. It runs alongside a local endpoint rather than instead
of one.

Setting any destination is now enough to start tracing —
`tracingDestinationConfigured()`. Both entrypoints used to test for an OTLP
endpoint by hand, so a LangSmith key did nothing without also passing `--trace`.

**`TRACE_DETAIL_FILE` writes every span in full**, one JSON object per line
(`lib/trace/detail.ts`), which is the thing to read when the question is "what
exactly did we send it". JSONL because the useful thing to do with it is `jq`.

**Content is opt-in, everywhere.** Prompts, responses, the transcript, the
retrieved section text and each chunk handed to the voice appear only under
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (or `--trace-payloads`).
Shape always travels — counts, sizes, durations, section _headings_, which
model, which voice — because none of that is anybody's document. Keep new
attributes on that side of the line: a trace must not quietly become a copy of
a paper somebody gave you in confidence.

## Do not run evals on every change

`npm run eval` and `npm run eval:validate` cost real money and minutes, and they
are not a feedback loop for ordinary code changes. Use them when the question is
actually "did quality change", not "does this compile". The everyday loop is
`npm test`, `npm run typecheck`, `npm run lint`.

Revisit the eval runs from **2026-09-09** — that date has arrived; the hold has
expired rather than been lifted, so confirm with the user before spending on a
run.

## Current focus: making it demoable

Priority is a smooth end-to-end demo — generate, listen, see where each claim
came from — over breadth. Prefer changes that work on every run and every
provider, with no API key and no extra model calls, to ones that need a
particular provider or a paid pass.

## Speech backends

`piper` (local neural), `say` (macOS), `openai` and `gemini`, all behind
`TTSProvider`. `resolveTTSProvider` still prefers Piper and falls back to `say`
when nothing is named — the default stays free and local, and a hosted voice is
opted into with `TTS_PROVIDER`, never assumed.

`gemini` (`lib/tts/geminiTts.ts`) is the one real adapter among the hosted
options. Google's OpenAI compatibility layer carries chat and embeddings but not
speech, so unlike the LLM path this cannot be `OpenCompatibleProvider` with
different config: TTS goes through `generateContent` with an AUDIO response
modality and a `speechConfig`. It returns headerless PCM (`audio/l16;
rate=24000`), wrapped into RIFF here so every segment joins on the same path as
every other backend.

A hosted primary gets a **local backup**. `resolveFallbackTTS` hands
`synthesizeEpisode` a fallback (Piper, else `say`, or whatever `TTS_FALLBACK`
names; "none" disables it), and a failure remakes the **whole episode** rather
than resuming. Resuming is wrong twice: the voice would change mid-episode, and
the backends emit different sample rates — Piper follows its voice model at
22,050 Hz where Gemini returns 24,000 — which `joinWavs` refuses outright, so
half-finished audio would become a hard failure one stage later. The result
carries `fellBackFrom` and `fallbackReason`, and the job says so, because audio
in a voice nobody chose should not quietly differ from the episode before it.

**A spoken answer sounds like the episode it is about.** Two things make that
true, and both were once false. The record stores `ttsProvider` and `voices`
(`lib/library/types.ts`), so the answer route resolves the backend that actually
voiced the episode instead of whatever `TTS_PROVIDER` says today — otherwise
changing that setting silently re-narrates every past episode. And
`answerVoiceFor` (`lib/tts/speak.ts`) picks the speaker from the episode's
format: `narrator` for solo and ELI5, `host` for a dialogue. Answering a
two-host episode as `narrator` gave a hosted backend a _third_ voice the
listener had never heard.

Two more decisions worth keeping. It synthesizes **one turn per call**, not with
Gemini's multi-speaker mode — per-turn timings drive transcript highlighting,
citation anchors and ASR verification, and they are computed from each segment's
own sample count, which a single two-voice blob has no way to provide. And it
**retries** 429/500/503/504: the TTS models are preview models that answer "this
model is currently experiencing high demand" under load, and an episode is a
dozen or more calls in a row.

## Formats

`dialogue` (two hosts, the default), `solo` and `eli5` are one option on
`generateEpisode`. The faithfulness rules are shared between all three verbatim,
with a test asserting the block is byte-identical — a second format must not
mean a second standard. Solo and ELI5 episodes are consecutive `narrator` turns,
so `checkAlternation` reads the format from the speakers rather than a flag,
which keeps it catching a _collapsed dialogue_ (still `host`) as the failure it
was written for.
