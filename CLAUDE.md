@AGENTS.md

# Working on this project

## The judge is not part of the main flow

The production path is **PDF → transcript → audio**. Nothing in it requires an
evaluator, and nothing new should.

`lib/eval/` is the eval harness. It exists to measure the pipeline, not to run
it. The dependency points one way: the harness may read production code, and
production code must not reach into the harness for anything a normal run
depends on.

The one exception is deliberate and opt-in: `--revise` (the `reviewing` stage)
runs `refineEpisode`, which uses the judge to fact-check and repair a script.
It is **off by default** in both the CLI and the web app, and a plain run never
touches it. Do not add anything that makes an ordinary generation depend on the
judge — citations, references, and progress reporting must all work with review
switched off.

Known layering debt, not yet fixed: `lib/jobs/pipeline.ts` imports
`runAudioChecks`, `WhisperCppProvider`, `verifyPerTurn` and `estimateCost` from
`lib/eval/`. Those are production concerns living in the wrong folder. Moving
them out is a planned refactor — don't add more imports in that direction.

## Do not run evals on every change

`npm run eval` and `npm run eval:validate` cost real money and minutes, and they
are not a feedback loop for ordinary code changes. Use them when the question is
actually "did quality change", not "does this compile".

For everyday work the loop is:

```bash
npm test          # ~3s, no network, no filesystem
npm run typecheck
npm run lint
```

Revisit the eval runs from **2026-09-09**.

## Current focus: making it demoable

Priority is a smooth end-to-end demo — generate, listen, see where each claim
came from — over breadth. Prefer changes that work on every run and every
provider, with no API key and no extra model calls, to ones that need a
particular provider or a paid pass.
