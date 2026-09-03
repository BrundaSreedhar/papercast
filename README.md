# Paper → Podcast

Turn an academic paper into a two-host podcast episode that says **only what the paper actually says**, and prove it.

```bash
npm run dev     # drop a PDF at localhost:3000
```

The interesting problem here is not generating audio. It is that a language model asked to explain a paper will produce something fluent, confident, and partly invented, and nobody re-reads the source to catch it. So this project treats faithfulness as the thing to engineer and measure, at every stage from PDF to waveform.

---

## What it does, measured

|                                                                          |            |
| ------------------------------------------------------------------------ | ---------: |
| Faithfulness of a clean episode, scored claim by claim                   |    **93%** |
| Faithfulness of a known-hallucinated episode (the harness must catch it) |    **13%** |
| Injected text corruptions detected                                       |  **9 / 9** |
| Injected audio corruptions detected                                      |  **5 / 5** |
| Script wording verified present in the audio, by transcription           |    **96%** |
| Judge variance across repeat runs, the noise floor for any claim above   | **±2 pts** |
| Unit tests                                                               |    **354** |

Every number is reproducible from this repo: `npm run eval`, `npm run eval:validate`, `npm test`.

---

## Tech stack

| Area            | Choice                                                              | Why                                                                                     |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Language        | TypeScript, strict, with `noUncheckedIndexedAccess`                 | The whole pipeline is data shaping, and the schema is the contract                      |
| Schema          | Zod, with `zod-to-json-schema`                                      | One definition drives validation, tool definitions, and JSON Schema for three providers |
| Frontier models | `@anthropic-ai/sdk`, `openai`                                       | Native structured output on both, by different mechanisms                               |
| Open models     | Any OpenAI-compatible endpoint (Ollama, Together, Groq, OpenRouter) | Lets the whole thing run with no account anywhere                                       |
| PDF             | `pdf-parse` for text; poppler (`pdftotext`, `pdftoppm`) for figures | Text extraction is the only part that wants a battle-tested library                     |
| Speech          | Piper (local neural), macOS `say`, OpenAI TTS                       | Behind one interface, so the free path is the default and not an afterthought           |
| Transcription   | whisper.cpp, local, CPU                                             | Used to check the audio against the script, so it must be free to run often             |
| Observability   | OpenTelemetry, GenAI semantic conventions                           | Portable to any OTLP backend rather than to one vendor's UI                             |
| Web             | Next.js 16, React 19                                                | Route handlers stream job progress; the app is a thin shell over `lib/`                 |
| API             | Express                                                             | The same pipeline behind a second transport, which is what proved it was framework-free |
| Tests           | Vitest, no network, no filesystem                                   | Providers are faked through their interfaces, so the suite runs in about three seconds  |

---

## System architecture

```
   PDF
    │
    ▼
 extract ──────────────► sections, references and appendices stripped
    │
    ▼
 LLMProvider ─────────► Claude · OpenAI · open   (one interface, three routes
    │                                             to the same guaranteed shape)
    ▼
  Episode ────────────► summary · key points · host/guest turns
    │                          │
    │                          └──► Layer 1  deterministic checks   free, every commit
    │                          └──► Layer 2  LLM judge              faithfulness · coverage
    │                                   │
    │  ┌────────────────────────────────┘
    │  ▼
 refine ──────────────► rewrite the turns that failed, re-judge, keep the better
    │                   one   (opt-in)
    ▼
 TTSProvider ─────────► Piper · macOS say · OpenAI
    │
    ▼
  Audio ──────────────► one file + exact per-turn timings
    │                          │
    │                          └──► audio checks      timeline · silence · speech rate
    │                          └──► ASR round-trip     what the audio actually says
    ▼
  Web app ────────────► streamed progress, transcript synced to playback
```

### Everything is behind an interface

Four model interfaces carry the whole system: `LLMProvider`, `VisionProvider`, `TTSProvider`, and `ASRProvider`. Each is one method reached through one factory. The rest of the application depends on the interface alone, so a local voice, a hosted API, and a frontier model are interchangeable.

The LLM interface is a single method:

```ts
interface LLMProvider {
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
```

Each provider reaches the same guaranteed shape by a different route:

| Provider        | Mechanism                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude**      | Schema registered as a tool, `tool_choice` forcing the call, then Zod validation with failures returned as a `tool_result` for in-place correction |
| **OpenAI**      | Strict `response_format: json_schema`, enforced server-side                                                                                        |
| **Open models** | Schema embedded in the prompt plus JSON mode, then Zod validation with the parse error fed back for self-correction                                |

That single chokepoint is also what makes the system observable. Wrapping the two model factories instruments every inference call in the project, with no change to any call site and no change to any function signature.

### Nothing in the library layer prints

Progress leaves a library through injected callbacks, never `console`. Failures leave as typed errors or as structured state written into a store. The one place that prints is the entrypoint. This is why the same pipeline runs unchanged behind a CLI, an Express server, and Next.js route handlers, and why it can be tested without a filesystem or a network.

---

## Evaluation

```bash
npm run eval                          # generate and score on every provider with credentials
npm run eval:validate                 # check the judge itself against known-bad episodes
npm run eval:validate -- --repeat 3   # measure judge variance
```

### Two layers, cheapest first

**Deterministic checks** run first, free and instantly, on every commit: schema, speaker alternation, length targets, show name, honorifics, claimed expertise, author impersonation, naming, and whether proper nouns trace back to the paper. Most fabrication is decidable without a model, and sending a language model to do a regex's job is slow and expensive.

**An LLM judge** handles what genuinely needs judgement. Faithfulness is scored by decomposition, not by asking a model for a rating out of ten: the transcript is split into atomic claims, and each is marked `supported`, `unsupported`, or `contradicted` against a quoted passage. A single number cannot be argued with. A list of verdicts with evidence can be read line by line.

Only claim verification needs the full paper, so it is passed as cacheable context. Judging several providers against one paper pays for the paper once.

### The grader is itself validated

An eval is only worth its output if the grader is sound, so the judge runs against captured episodes with known verdicts before any comparison is trusted.

| Fixture                  | Faithfulness | Hallucination | Coverage |
| ------------------------ | -----------: | ------------: | -------: |
| `clean-claude`           |          93% |            4% |     100% |
| `fabricated-personas`    |          91% |            0% |      80% |
| `hallucinated-mapreduce` |      **13%** |           47% |       0% |

The most useful fixture is not synthetic. It is a real episode about _MapReduce frequent-itemset mining_ that a local model produced from the Amazon Aurora paper after its context window silently truncated the input. A judge that rates that row as faithful is broken. This one places it seven times below the faithful episodes.

Reading individual verdicts also caught a bug in the harness rather than the model. Decomposing _"the old bottleneck goes away, but the cost moves to the network"_ into its first half alone produced a claim the paper genuinely contradicts, an artifact of splitting rather than a hallucination. Extraction now keeps contrastive and qualified statements intact, which moved the clean episode from 88% to 93%.

### Sensitivity, by mutation testing

Fixtures prove the checks catch failures already seen. They say nothing about sensitivity in general, and hand-writing more cases only tests the failures somebody already thought of. So a clean episode is corrupted one fault at a time: a figure swapped for one the paper never states, a fabricated system introduced, a doctorate handed out, authorship claimed, the show renamed, alternation broken, the dialogue truncated. Each corruption names the check that must catch it.

All nine injected corruptions are detected, with no false positives on the uncorrupted control. The suite reports that as a rate, so a regression in a regex shows up as a number rather than a mysteriously passing build. It needs no API key and runs in CI.

### Judge variance

Repeated grading of the same episode by `claude-sonnet-5`, three runs each:

| Fixture                  | Mean |  Spread |
| ------------------------ | ---: | ------: |
| `clean-claude`           |  94% | 2.0 pts |
| `fabricated-personas`    |  91% | 0.0 pts |
| `hallucinated-mapreduce` |  12% | 8.2 pts |

**A gap of two or three points between models is noise.** Differences are only reported as real when they exceed it.

### Results, and why the headline number misleads

Amazon Aurora paper, 4-minute episode, judged by `claude-sonnet-5`:

| Generator              | Faithful | Halluc. | Coverage | Compliance |   Cost | Time |
| ---------------------- | -------: | ------: | -------: | ---------: | -----: | ---: |
| `claude-sonnet-5`      |      91% |      4% | **100%** |       100% | $0.245 |  48s |
| `qwen2:7b-32k` (local) |      94% |      4% |      80% |       100% |   free | 174s |

The open model's three-point faithfulness lead sits inside the judge's two-point noise band and should be treated as a tie. The real difference is coverage: the local model omitted one of the paper's five key contributions, that an asynchronous scheme based on log sequence numbers replaces two-phase commit, while Claude conveyed all five.

That is the trap in scoring faithfulness alone. **An episode that says less has less to be wrong about**, and a model that says nothing at all scores perfectly. Coverage is what stops faithfulness from rewarding silence, and the two belong in the same table.

Reports also flag when the judge and the generator are the same model. Models favour their own output, so a self-judged score is an upper bound rather than a neutral measurement.

---

## Tracing

Every model call emits an OpenTelemetry span. `--trace` prints the tree when a run finishes:

```
── TRACE ──────────────────────────────────────────────────────────
invoke_workflow paper-to-podcast            255ms  89,292 in → 5,880 out  85,248 cached  $0.126
├─ chat claude-sonnet-5  episode            41ms   14,882 in → 980 out    14,208 cached  $0.021
└─ invoke_agent refine                      212ms  74,410 in → 4,900 out  71,040 cached  $0.105
   ├─ round 0                               83ms   29,764 in → 1,960 out  28,416 cached  $0.042
   │  └─ judge                              83ms   29,764 in → 1,960 out  28,416 cached  $0.042
   │     ├─ chat claude-sonnet-5  claims    41ms   14,882 in → 980 out    14,208 cached  $0.021
   │     └─ chat claude-sonnet-5  verdicts  41ms   14,882 in → 980 out    14,208 cached  $0.021
   └─ round 1                               130ms  44,646 in → 2,940 out  42,624 cached  $0.063
      ├─ chat claude-sonnet-5  revisions    45ms   14,882 in → 980 out    14,208 cached  $0.021
      └─ judge                              83ms   29,764 in → 1,960 out  28,416 cached  $0.042
```

That shape is the point. The repair loop is two rounds of judge and rewrite, and without this the only evidence of it was a progress message. Token and cost columns are summed over each subtree, so a round reports what everything under it consumed. The `cached` column is the one that pays for the exercise: the paper travels as roughly 120k characters of reusable context on every judge call, and this is the first time it is visible being served from cache rather than re-billed.

### It exports anywhere

Spans follow the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so the same run opens in any OTLP backend. Set the standard endpoint variable and both outputs happen at once:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run generate -- paper.pdf --revise --trace
```

Tracing is inert unless asked for. With no flag and no endpoint configured, the provider decorators return the provider unchanged and nothing is allocated.

### Retries are visible attempt by attempt

Both the Claude and open-model paths retry internally when a model returns input that fails schema validation. Each attempt gets its own child span with the reason it was rejected:

```
chat qwen2:7b-32k  claims  42.5s  2,632 in → 772 out
├─ attempt 1               8.8s  ✗ rejected: claims: Required
└─ attempt 2               33.8s
```

With payload capture on, each rejected attempt also carries what the model actually sent, which is usually the only thing that explains the failure. The case that motivated it: qwen2:7b replying to claim extraction with **the JSON Schema itself** rather than data matching it. It parses as valid JSON and has no `claims` key, so the error reads `claims: Required` and says nothing about the cause.

That failure also had a fix. The old correction, "reply again with a JSON object conforming to the schema", reads as agreement to a model that believes it already did, so all four attempts returned byte-identical output. The retry now names the mistake when it detects a schema echo, and the same call that used to fail outright recovers on the second attempt.

### Prompts and responses are opt-in

Spans always carry model, tokens, cost, latency, retries, and the _size_ of each prompt, never its content. To see the actual text:

```bash
npm run generate -- paper.pdf --revise --trace --trace-payloads
```

That adds `gen_ai.system_instructions`, `gen_ai.input.messages`, and `gen_ai.output.messages`, truncated, in the shape the conventions define. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` does the same and is the standard name, so it works for the server and web app too, which have no flags to pass.

It is off by default because the paper rides along on every judge call, and because a trace should not quietly become a copy of a document somebody gave you in confidence.

---

## Deployment

The whole thing is one container, and that is a property of the work rather than a preference. A job outlives by minutes the request that starts it, and lives in the process that started it, so a platform handing every request its own instance would lose each job the moment it returned an id. [`app/api/store.ts`](app/api/store.ts) says so where the decision is implemented.

```bash
docker build -t papercast .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-... papercast
```

Piper and its two voices are baked into the image. The free local voice is the project's default, and a deployment that quietly swapped it for a paid API would advertise something it does not do.

### The public demo is a shelf, not an upload box

A URL anyone can open, spending an API key on any file they choose, is a bill with no ceiling. `DEMO_MODE=1` turns off uploads and offers three arXiv papers instead, fetched into the image from a manifest rather than committed here — the repository has no right to redistribute other people's documents, and the manifest records where each came from.

Two limits sit behind it, for two different failures. One episode at a time protects the machine, since synthesis holds a neural voice model in memory beside the server. Twenty-five a day protects the bill, and is the one that matters once a link is passed around. Both refuse in the open: a message naming the limit and when it lifts, because a demo that silently queues looks broken and one that silently degrades teaches the visitor nothing.

The shelf also fixed something the local path never noticed. Extraction takes the first text on page one as the title, and arXiv's copy of _Attention Is All You Need_ opens with Google's permission to reproduce its figures — which then travelled into the prompt as the subject of the episode. A caller that knows the title for certain now says so.

```bash
fly launch --no-deploy --copy-config     # once
fly secrets set ANTHROPIC_API_KEY=sk-...
fly deploy
```

One machine, stopped when nobody is looking, and a job holds its progress stream open for its whole life so a machine is never stopped out from under an episode.

---

## Key decisions

### The grader feeds back into the writer

A verdict that only lands in a report cannot fix anything. Every claim the judge marks `contradicted`, or `unsupported` and specific, goes back to the model together with the passage that contradicts it, and only the turns carrying those claims are rewritten.

Three properties make this a control loop rather than a gesture:

- **The repair is narrow.** Only the text of flagged turns changes. Speakers, ordering, and turn count are untouched, because strict alternation is an error-level check and a rewrite that dropped a turn would trade a faithfulness failure for a structural one.
- **Every round is re-judged in full**, not just the turns that changed, because a rewrite can introduce a new error that a partial re-check would miss.
- **The better script wins, not the later one.** If no revision beats the original, the original is what you get and the report says so. Without that, self-correction would be exactly the unfalsifiable claim this project exists to avoid.

Vague unsupported statements are deliberately left alone. They are conversational framing, they already do not count toward the hallucination rate, and rewriting them churns the script for no measurable gain.

### The pipeline fails loudly on context overflow

Self-hosted endpoints cap the context window well below the model's real limit and do not error when a prompt exceeds it. They quietly drop the overflow. Ollama, for instance, defaults to 4,096 tokens no matter what the model supports, and ignores `num_ctx` over its OpenAI-compatible route.

This was found the hard way. Running the Amazon Aurora paper (roughly 17k tokens) through a local 7B model produced a fluent, well-structured episode about a topic found nowhere in the paper. The model had seen about a quarter of the input and confabulated the rest, with no error anywhere in the stack.

The pipeline now compares the tokens sent against the tokens the server reports processing and aborts on a large shortfall. For a faithfulness-first system, a hard failure with remediation steps is strictly better than a confident, plausible, wrong answer.

### Structured output instead of parsing text

The original prototype asked for one blob of prose and split it with a regex, which needed a second model call whenever the markers did not appear. A schema removes the failure mode entirely.

Forcing `tool_choice` guarantees Claude _calls_ the tool, not that its input matches the schema. Unlike OpenAI's strict mode, tool input is validated loosely and a field occasionally comes back mistyped, so validation and retry belong on the Claude path too, not only the open-model one.

### Section-aware extraction, not map-reduce chunking

Modern context windows swallow most papers whole, so chunking a typical paper would be engineering theatre. The real quality win is _what_ you send, not how you split it. Dropping the reference list and appendix measurably reduces fabricated citations. Papers that genuinely exceed the budget are truncated and flagged rather than silently cut.

### Fabrication is not only about facts

Left unconstrained, models name the show, hand the speakers doctorates, and slip into "our approach" as though the presenters wrote the paper. All three are forbidden in the prompt and checked deterministically afterwards.

### It runs free

Local Ollama for the script, Piper for the voices, whisper.cpp for verification: a complete episode with no account anywhere. Hosted providers are a config change.

Worth knowing where that ends. A 7B model can write a serviceable episode but generally cannot hold the judge's schema, so the fact-checking layer wants a stronger model. When the check cannot run, the episode is still delivered and reported plainly as unchecked rather than silently passing.
