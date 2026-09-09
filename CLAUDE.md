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
npm run build:web             # next build — the only thing that typechecks app/
npm run serve                 # the same pipeline behind Express, on :8000
npm run generate -- paper.pdf --minutes 4 [--solo|--eli5] [--provider anthropic|openai|gemini|open] [--revise] [--trace]
```

There are **two TypeScript programs**. `npm run typecheck` covers `lib/` and
`src/` and explicitly excludes `app/`; the web app is only typechecked by
`npm run build:web`. A change to a route handler or a component is unverified
until that runs.

Evals (`npm run eval`, `npm run eval:validate`) are covered under "Do not run
evals on every change" below.

## Architecture

The pipeline is **PDF → transcript → audio**, and it lives entirely in `lib/`.
`app/` (Next.js route handlers and React) and `src/` (a CLI and an Express
server) are transports over the same code — which is what keeps `lib/`
framework-free and testable without a network or a filesystem.

**Four model interfaces carry the system**: `LLMProvider` (`lib/llm/types.ts`),
`VisionProvider`, `TTSProvider`, `ASRProvider`. Each is one method reached
through one factory, so a local voice, a hosted API and a frontier model are
interchangeable. `getProvider()` in `lib/llm/index.ts` is the *only* place an
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
the *rendered* paper (`renderPaper` in `lib/pdf/extract.ts`), never the raw PDF
text, because the raw text still holds the reference list and a quote matching
inside a bibliography would produce a confident citation to a page nobody read.
A match below the confidence floor returns nothing: a wrong page is worse than
no page.

**Extraction** is section-aware rather than chunked — modern context windows
swallow most papers whole. `PaperSection.content` is rebuilt from filtered
lines, not sliced, so provenance is tracked per line (`SourceLine.at`) to make
page lookup possible.

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

## Do not run evals on every change

`npm run eval` and `npm run eval:validate` cost real money and minutes, and they
are not a feedback loop for ordinary code changes. Use them when the question is
actually "did quality change", not "does this compile". The everyday loop is
`npm test`, `npm run typecheck`, `npm run lint`.

Revisit the eval runs from **2026-09-09**.

## Current focus: making it demoable

Priority is a smooth end-to-end demo — generate, listen, see where each claim
came from — over breadth. Prefer changes that work on every run and every
provider, with no API key and no extra model calls, to ones that need a
particular provider or a paid pass.

## Formats

`dialogue` (two hosts, the default), `solo` and `eli5` are one option on
`generateEpisode`. The faithfulness rules are shared between all three verbatim,
with a test asserting the block is byte-identical — a second format must not
mean a second standard. Solo and ELI5 episodes are consecutive `narrator` turns,
so `checkAlternation` reads the format from the speakers rather than a flag,
which keeps it catching a *collapsed dialogue* (still `host`) as the failure it
was written for.
