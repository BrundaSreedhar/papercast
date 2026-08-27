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
| Unit tests                                                               |    **345** |

Every number is reproducible from this repo: `npm run eval`, `npm run eval:validate`, `npm test`.

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

## Key decisions

### Faithfulness is measured, not asserted

An LLM judge decomposes each episode into atomic claims and marks every one `supported`, `unsupported`, or `contradicted` against a quoted passage. A single score out of ten cannot be argued with. A list of verdicts with evidence can be read line by line.

Deterministic checks run first, free and instantly, on every commit: schema, speaker alternation, length targets, show name, honorifics, claimed expertise, author impersonation, naming, and whether proper nouns trace back to the paper. Most fabrication is decidable without a model, and sending a language model to do a regex's job is slow and expensive.

### The grader is itself validated

An eval is only worth its output if the grader is sound, so the judge runs against captured episodes with known verdicts before any comparison is trusted.

| Fixture                  | Faithfulness | Hallucination | Coverage |
| ------------------------ | -----------: | ------------: | -------: |
| `clean-claude`           |          93% |            4% |     100% |
| `fabricated-personas`    |          91% |            0% |      80% |
| `hallucinated-mapreduce` |      **13%** |           47% |       0% |

The most useful fixture is not synthetic. It is a real episode about _MapReduce frequent-itemset mining_ that a local model produced from the Amazon Aurora paper after its context window silently truncated the input. A judge that rates that row as faithful is broken. This one places it seven times below the faithful episodes.

Mutation testing covers sensitivity in general rather than only the failures already seen: a clean episode is corrupted one fault at a time, and each corruption names the check that must catch it. All nine injected corruptions are detected, with no false positives on the uncorrupted control.

Variance is measured too, so a three-point difference is never reported as a result.

### Coverage is what stops faithfulness from rewarding silence

Amazon Aurora paper, 4-minute episode, judged by `claude-sonnet-5`:

| Generator              | Faithful | Halluc. | Coverage |   Cost | Time |
| ---------------------- | -------: | ------: | -------: | -----: | ---: |
| `claude-sonnet-5`      |      91% |      4% | **100%** | $0.245 |  48s |
| `qwen2:7b-32k` (local) |      94% |      4% |      80% |   free | 174s |

Read carefully, because the headline number is the misleading one. The open model's three-point faithfulness lead sits inside the judge's two-point noise band and should be treated as a tie. The real difference is coverage: the local model omitted one of the paper's five key contributions, while Claude conveyed all five.

That is the trap in scoring faithfulness alone. **An episode that says less has less to be wrong about**, and a model that says nothing at all scores perfectly. Coverage and faithfulness belong in the same table.

Reports also flag when the judge and the generator are the same model. Models favour their own output, so a self-judged score is an upper bound, not a neutral measurement.

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

### Traces follow a standard, for the same reason providers do

Model calls emit OpenTelemetry spans using the GenAI semantic conventions, so a run is inspectable in Jaeger, Grafana Tempo, Arize Phoenix, or Langfuse without the pipeline knowing which. Each provider retry is its own child span carrying the reason it was rejected, because a retry count tells you that a call struggled and never why.

Prompt and response text is not recorded by default. Spans carry model, tokens, cost, latency, retries, and the _size_ of each prompt. Content is opt-in, because the paper rides along as reusable context on every judge call, and because a trace should not quietly become a copy of a document somebody gave you in confidence.

### It runs free

Local Ollama for the script, Piper for the voices, whisper.cpp for verification: a complete episode with no account anywhere. Hosted providers are a config change.

Worth knowing where that ends. A 7B model can write a serviceable episode but generally cannot hold the judge's schema, so the fact-checking layer wants a stronger model. When the check cannot run, the episode is still delivered and reported plainly as unchecked rather than silently passing.
