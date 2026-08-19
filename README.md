# Paper → Podcast

Turn an academic paper into a two-host podcast episode that says **only what the paper actually says** — and prove it.

```bash
npm run dev     # drop a PDF at localhost:3000
```

The interesting problem here is not generating audio. It is that a language model asked to explain a paper will produce something fluent, confident, and partly invented, and nobody re-reads the source to catch it. So this project treats faithfulness as the thing to engineer and measure, at every stage from PDF to waveform.

---

## What it does, measured

| | |
|---|--:|
| Faithfulness of a clean episode, scored claim by claim | **93%** |
| Faithfulness of a known-hallucinated episode (the harness must catch it) | **13%** |
| Injected text corruptions detected | **9 / 9** |
| Injected audio corruptions detected | **5 / 5** |
| Script wording verified present in the audio, by transcription | **96%** |
| Judge variance across repeat runs — the noise floor for any claim above | **±2 pts** |
| Unit tests | **265** |

Every number is reproducible from this repo: `npm run eval`, `npm run eval:validate`, `npm test`.

---

## Why it is not just an API call

**Faithfulness is measured, not asserted.** An [LLM judge](#evaluation) decomposes each episode into atomic claims and marks every one `supported`, `unsupported`, or `contradicted` against a quoted passage. A single score out of ten cannot be argued with; a list of verdicts with evidence can be read line by line.

**The grader is itself validated.** Known-bad fixtures, [mutation testing](#sensitivity-mutation-testing) for sensitivity, and [measured variance](#judge-variance) so a three-point difference is never reported as a result. The most useful fixture is a real failure: an episode about MapReduce itemset mining that a local model produced from the Amazon Aurora paper after its context window silently truncated.

**Silent failure is designed against.** The pipeline refuses to generate when the model did not receive the whole paper, refuses to trust audio it has not checked, and [transcribes the finished episode back](#verifying-what-the-audio-actually-says) to confirm the words are really there. Each of those guards exists because the failure happened.

**Fabrication is not only about facts.** Left unconstrained, models name the show, hand the speakers doctorates, and slip into "our approach" as though the presenters wrote the paper. All three are [forbidden and checked](#two-layers).

**Model-agnostic, and it earns the abstraction.** Claude via forced tool-use, OpenAI via strict `json_schema`, and open models via JSON coercion with validation-retry — because open endpoints often have neither. Claude turned out to need the retry path too: forcing `tool_choice` guarantees the tool is *called*, not that its input matches the schema.

**It runs free.** Local Ollama for the script, [Piper](#installing-piper) for the voices, whisper.cpp for verification — a complete episode with no account anywhere. Hosted providers are a config change.

---

## Architecture

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

Everything under `lib/` is plain TypeScript with no framework dependency, which is why the same pipeline runs behind a CLI, an Express server, and Next.js route handlers unchanged.

---

## Status

| Phase | Scope | State |
|---|---|---|
| **P0** | Foundations, secrets hygiene, toolchain | ✅ Done |
| **P1** | Extraction → provider abstraction → dialogue → CLI | ✅ Done |
| **P2** | LLM-judge evals + frontier-vs-open comparison | ✅ Done |
| **P3** | Audio: chunked per-speaker TTS with exact timings | ✅ Done |
| **P4** | Async job model + streamed progress | ✅ Done |
| **P5** | Web app with a transcript synced to playback | ✅ Done |
| **P6** | CI on the web build, deployed URL | ⬜ Planned |

**The pipeline runs end to end — drop in a PDF, watch it work, listen with a transcript that follows along.** Covered by 265 unit tests. A deployed URL lands in P6.

---

## Quick start

### 1. Install

```bash
npm install
```

Requires Node 18+ (developed on Node 24).

### 2. Configure

```bash
cp .env.example .env
```

Then edit `.env` and set `LLM_PROVIDER` plus the credentials for whichever provider you want:

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `open` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Claude credentials and model id |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI credentials and model id |
| `OPEN_BASE_URL` / `OPEN_API_KEY` / `OPEN_MODEL` | Any OpenAI-compatible endpoint |

`.env` is gitignored; `.env.example` is the committed template.

### 3. Generate an episode

```bash
npm run generate -- path/to/paper.pdf
```

The CLI prints the summary, key points, and the first few dialogue turns, then writes the complete episode as JSON.

### 4. Turn it into audio

```bash
npm run audio -- paper.episode.json --m4a
```

Two voices, one file, plus a per-turn timing map. On macOS this needs no API key and no ffmpeg — see [Audio](#audio).

### 5. Or use the web app

```bash
npm run dev
```

Drop a PDF at `localhost:3000`, watch each stage as it happens, then listen with a transcript that highlights the line being spoken. See [Web app](#web-app).

---

## Usage

```bash
# Default provider from .env, 10-minute target
npm run generate -- paper.pdf

# Shorter episode, explicit provider, custom output path
npm run generate -- paper.pdf --minutes 6 --provider anthropic --out episode.json
```

| Flag | Default | Description |
|---|---|---|
| `--minutes N` | `10` | Target spoken length; drives the word and token budget |
| `--provider` | `LLM_PROVIDER` from `.env` | `anthropic` \| `openai` \| `open` |
| `--out FILE` | `<paper>.episode.json` | Where to write the full result |
| `--figures` | off | Have a vision model read the paper's diagrams and tables |

### Running fully free and offline

With [Ollama](https://ollama.com) installed locally, no API key is needed. `qwen2:7b` is the default open model, so this works with no further configuration:

```bash
ollama pull qwen2:7b
```

```bash
npm run generate -- paper.pdf --provider open --minutes 4
```

**Choosing an open model.** Set `OPEN_MODEL` to anything your host can run — the constraint is local RAM:

| Model | Approx. RAM | Notes |
|---|---|---|
| `qwen2:7b` | ~5 GB | Default; small but capable, fine for smoke tests |
| `qwen2.5:14b` | ~9 GB | Better quality; comfortable on a 16–18 GB machine |
| `llama3.3:70b` | ~40 GB+ | Needs a large workstation |

A hosted OpenAI-compatible tier (Together, Groq, OpenRouter) removes the RAM constraint entirely — point `OPEN_BASE_URL` at it and set `OPEN_API_KEY`. That is the better route for the P2 eval comparison, where a stronger open model makes the frontier-vs-open result more meaningful.

> **Raise Ollama's context window before using it on full papers.** Ollama gives every model a 4,096-token context regardless of its real capacity — far too small for a typical paper, and it ignores `num_ctx` sent over the OpenAI-compatible API. Bake the larger context into a derived model instead:
>
> ```bash
> ollama create qwen2:7b-32k -f ollama/qwen2-32k.Modelfile
> ```
>
> Then set `OPEN_MODEL=qwen2:7b-32k`. Measured effect on this repo's own runs: **4,096 → 25,025** input tokens actually processed.
>
> Setting `OLLAMA_CONTEXT_LENGTH` and restarting the server is the commonly suggested fix, but it does **not** work on macOS — the menu-bar app supervises `ollama serve` and respawns it without that variable. The derived model needs no service restart, survives reboots, reuses the base weights (no extra disk), and leaves your other models untouched.
>
> Without this the run aborts with a `ContextTruncationError` rather than producing an episode about the wrong subject.

### Output shape

```jsonc
{
  "episode": {
    "summary": "…",
    "keyPoints": ["…"],
    "turns": [
      { "speaker": "host",  "text": "…" },
      { "speaker": "guest", "text": "…" }
    ]
  },
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "retries": 0,
  "truncatedInput": false
}
```

---

## Code layout

```
lib/
├── config/env.ts          Typed env loading and provider selection
├── pdf/
│   ├── extract.ts         PDF → { title, abstract, sections[] }, noise stripped
│   └── render.ts          Figure-page detection and rasterisation
├── vision/
│   ├── describe.ts        Figure pages → descriptions, labelled as derived
│   ├── prompt.ts          Transcribe, do not interpret
│   ├── anthropic.ts       Claude vision
│   └── openaiCompatible.ts  GPT-4o or a local model via Ollama
├── tts/
│   ├── wav.ts             RIFF parsing, joining, exact durations
│   ├── chunk.ts           Sentence-aware splitting for input limits
│   ├── macSay.ts          macOS `say` backend
│   ├── piper.ts           Piper open-source neural backend (default)
│   ├── openaiTts.ts       OpenAI speech backend
│   └── synthesize.ts      Turns → one file + per-turn timings
├── llm/
│   ├── schema.ts          The Zod episode schema — single source of truth
│   ├── types.ts           LLMProvider interface
│   ├── anthropic.ts       Claude, via forced tool-use
│   ├── openai.ts          OpenAI, via strict json_schema
│   ├── openCompatible.ts  Open models, via JSON coercion + validation-retry
│   ├── contextGuard.ts    Aborts when the server silently drops input
│   ├── index.ts           Provider factory
│   └── generateEpisode.ts Prompt construction and orchestration
└── eval/
    ├── checks.ts           Deterministic checks (Layer 1)
    ├── judge.ts            Claim extraction, verification, coverage (Layer 2)
    ├── judgeSchema.ts      Strict-mode-safe schemas for the judge passes
    ├── dataset.ts          Paper discovery, annotations, fixture loading
    ├── audioChecks.ts      Deterministic checks on synthesized audio
    ├── asr.ts              Speech recognition behind an interface
    ├── transcriptFidelity.ts  What the audio says vs what the script said
    ├── mutate.ts           Deliberate corruptions for sensitivity testing
    ├── mutateAudio.ts      Audio corruptions for the same
    ├── report.ts           Markdown comparison report and cost estimates
    └── fixtures/           Captured episodes with known verdicts

├── jobs/
│   ├── types.ts           Stage machine and progress weighting
│   ├── store.ts           In-memory jobs with subscriptions
│   ├── errors.ts          Internal failures → user-safe messages
│   └── pipeline.ts        Paper → episode → audio, reporting as it goes

src/cli.ts                 Generate a single episode
src/server.ts              HTTP API with server-sent progress
src/audio.ts               Synthesize an episode into audio
src/eval.ts                Generate + score across providers
src/validate-judge.ts      Validate the judge before trusting it
```

### The provider interface

One method is all the rest of the application depends on:

```ts
interface LLMProvider {
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
```

Each provider reaches the same guaranteed shape by a different route:

| Provider | Mechanism |
|---|---|
| **Claude** | Schema registered as a tool, `tool_choice` forcing the call, then Zod validation with failures returned as a `tool_result` for in-place correction |
| **OpenAI** | Strict `response_format: json_schema`, enforced server-side |
| **Open models** | Schema embedded in the prompt + JSON mode, then Zod validation with the parse error fed back for self-correction |

Forcing `tool_choice` guarantees Claude *calls* the tool, not that the input matches the schema — unlike OpenAI's `strict` mode, tool input is validated loosely, and a field occasionally comes back mistyped. Validation and retry therefore belong on the Claude path too, not only the open-model one.

---

## Figures

Text extraction discards everything a paper *draws* rather than writes. Optionally, a vision model reads them back:

```bash
npm run generate -- paper.pdf --figures
```

Pages carrying a figure or table caption are rendered with `pdftoppm` and described one page at a time, and the descriptions join the source text the writer and the judge both read.

```bash
brew install poppler
```

| Variable | Purpose |
|---|---|
| `VISION_PROVIDER` | `anthropic` (default) · `openai` · `open` |
| `VISION_MODEL` | Override the model; `open` defaults to `llava:7b` via Ollama |

**Whole pages are rendered, not embedded images.** A figure pulled out of its page loses its caption, axis labels, and the sentence around it — exactly what makes it interpretable.

**Descriptions are marked as derived.** They are model-generated, so they are a second fabrication surface: a vision model inventing a trend line is indistinguishable downstream from a language model inventing a result. They enter the source labelled *"produced by a vision model reading page N, not text quoted from the paper"*, the writer is told to treat them as weaker evidence and never to state a figure's number unless the description gives it explicitly, and the prompt demands transcription over interpretation with an explicit `NONE` for a page with nothing on it.

Because they flow through the same `paperToText` everything else reads, the grounding checks and the LLM judge cover them with no special case: a claim about a diagram is verified by the same machinery as a claim about a paragraph.

### What it is actually worth

Measured on the Amazon Aurora paper, honestly:

- The vision model transcribed Table 1 **exactly** — `Mirrored MySQL 780,000 / 7.4`, `Aurora with Replicas 27,378,000 / 0.95`.
- But those numbers were **already in the extracted text**, since it is a text-based table. No gain there.
- The real gap is diagram content: `Primary Instance`, `Replica Instance`, `EBS mirror`, `AZ 1` appear nowhere in the extracted text, and the *relationships* a diagram encodes are unrecoverable from flattened text at any quality of extraction.
- Even so, an episode generated with figures enabled did not visibly draw on that content. A spoken summary operates above the level of box labels, which is arguably correct.

So on this paper it costs roughly 16k extra input tokens for a marginal gain. It should pay off where results live in charts rather than prose — ablation plots, accuracy curves, papers whose text says "see Figure 4" — and on scanned or image-heavy PDFs. **The eval harness can settle that rather than intuition**: run `npm run eval` with and without figures and compare coverage. That comparison has not been run.

---

## Audio

```bash
npm run audio -- paper.episode.json               # WAV + timings
npm run audio -- paper.episode.json --m4a         # also compressed
npm run audio -- paper.episode.json --provider openai --gap 500
```

| Flag | Default | Description |
|---|---|---|
| `--provider` | auto | `piper` (open source), `say` (macOS), or `openai` |
| `--gap MS` | `350` | Silence between turns |
| `--out FILE` | input path | Output stem for `.wav` / `.timings.json` |
| `--m4a` | off | Also emit AAC via `afconvert` |
| `--verify` | off | Transcribe the audio back and check it against the script |
| `--target N` | — | Requested minutes, to check the episode actually lasts that long |

Three backends, all behind one interface:

| Backend | Voices | Cost | Setup |
|---|---|---|---|
| **`piper`** | Open-source neural (lessac / ryan) | free | one-time model download |
| `say` | macOS built-in (Samantha / Daniel) | free | none |
| `openai` | `gpt-4o-mini-tts` (nova / onyx) | ~$0.09/episode | API key |

With no `--provider` and no `TTS_PROVIDER`, the runner **prefers Piper when its models are installed and falls back to `say`** — so a fresh checkout still produces audio, and an installed Piper is used without remembering a flag.

Measured on the Aurora episode: **5:32 via Piper in 34s**, or **6:04 via `say` in 22s**. Both entirely local, no account anywhere, no ffmpeg.

### Installing Piper

[Piper](https://github.com/rhasspy/piper) is MIT-licensed and runs on CPU. It needs a Python environment and two voice models (~60 MB each), both kept out of the repository:

```bash
uv venv --python 3.12 .venv-tts && uv pip install --python .venv-tts piper-tts
```

```bash
.venv-tts/bin/python -m piper.download_voices en_US-lessac-medium --data-dir .voices
```

```bash
.venv-tts/bin/python -m piper.download_voices en_US-ryan-medium --data-dir .voices
```

Override paths with `PIPER_BIN`, `PIPER_HOST_VOICE`, and `PIPER_GUEST_VOICE`. Piper emits 22.05 kHz 16-bit mono — the same format as `say` — so it lands on the existing joining and timing path unchanged.

Segments are joined in pure TypeScript by parsing RIFF chunks and concatenating PCM. That avoids an ffmpeg dependency and buys something better: **exact per-turn timings derived from sample counts** rather than probed. The computed total matches macOS `afinfo` to the millisecond (364.004s), and those timings are what will drive transcript highlighting in P5.

Each **turn** is a synthesis call, chunked further at sentence boundaries when it exceeds the backend's input limit. This is the fix for the original bug: the first version sent an entire script in one call, was rejected past 4,096 characters, swallowed the error, and returned a transcript with `audioUrl: null` — the headline feature missing for exactly the long episodes it existed to serve. Exceeding the limit is now impossible by construction rather than caught.

Sentence splitting is decimal-aware, since a naive split treats the period in "5.38 milliseconds" as a sentence end and cuts mid-figure — audible as an unnatural break, because the halves are synthesized with independent prosody.

Joining rejects mismatched sample rates rather than concatenating them, which would otherwise play back at the wrong speed and sound like corruption rather than a bug.

### Checking the audio

Synthesis has one failure mode that matters and is easy to miss: **text silently going missing**. A call that drops a chunk or returns an empty buffer still yields a file that plays perfectly, and nobody re-reads a transcript against a waveform. So every run is checked before it is announced as finished:

| Check | Catches |
|---|---|
| `audio-parses` | Unreadable or empty output |
| `turns-voiced` | A turn with no audio at all |
| `timeline-order` | Overlapping or out-of-order turns |
| `timeline-matches-audio` | Timings drifting from the file's real length |
| `silent-turns` | A turn with text but no audible speech (RMS) |
| `speech-rate` | **Dropped text** — fifty words in two seconds |
| `episode-duration` | An episode far shorter than requested |

`speech-rate` is the cheap proxy for the ASR round-trip: if a turn's audio is far too short for its word count, content did not survive synthesis. That is invisible on playback and undetectable from the file alone.

Sensitivity is measured the same way as the text layer — the audio is deliberately corrupted (silence a turn, truncate the file, desync the timeline, overlap turns, drop a timing) and each corruption names the check that must catch it. **5 of 5 detected, no false positives on the control.** The real Aurora episode scores 100% with no errors or warnings, which also calibrates the speech-rate thresholds against genuine speech rather than a synthetic tone.

What is deliberately *not* checked: prosody, naturalness, and pronunciation. Those need a human or a speech model, and asserting them cheaply would be theatre.

### Verifying what the audio actually says

`speech-rate` *infers* text loss from a turn being too short. `--verify` **measures** it: the audio is transcribed back with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and compared to the script, word for word.

```bash
brew install whisper-cpp
curl -L -o .models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

```bash
npm run audio -- paper.episode.json --verify
```

Measured on the Aurora episode: **96% of the script recognized in the audio**, no turns flagged. The remaining 4% is recognition noise — "MySQL" heard as "My SQL" — not missing speech.

Verification runs **per turn**, using the timings synthesis already produced, and splits any turn longer than 20 seconds. Both details are load-bearing, and both were found by disbelieving a bad number rather than reasoning:

- Transcribing the whole episode in one pass reported **61%** and flagged three turns. Extracting those turns and transcribing them individually showed the audio was word-perfect. Recognizers skip material on long recordings.
- Per-turn transcription then flagged a single turn at **11%** — a 31-second turn that crossed Whisper's 30-second window, returning its first sentence and last three words. Split in half, the same audio transcribed verbatim.

So the checker needed calibrating before it could be trusted, exactly as the LLM judge did. The per-turn timings from P3 are what make it possible at all: without exact boundaries there are no short clips to hand the recognizer.

---

## Web app

```bash
npm run dev
```

Upload a paper, watch the stages stream past, then play the episode with a transcript that follows along. Clicking any line seeks to it.

The transcript sync uses the **exact per-turn boundaries recorded during synthesis** — nothing is estimated or force-aligned after the fact. Measured on a live run: the last turn ends at 127.9 s and the audio is 127.9 s long, and clicking a line seeks to within a tenth of a second of where that line begins.

Progress arrives over server-sent events rather than polling, and reloading mid-episode replays the whole history rather than showing an empty bar.

**Why it is not serverless.** A job takes around eighty seconds — longer than a serverless function may run — and the job store is process memory, which separate invocations would not share. The app therefore wants a long-lived Node process (Render, Railway, Fly, a container) rather than Vercel's default. `lib/jobs` is storage-agnostic, so moving the store to Redis is what would unlock a serverless deploy; the constraint is stated rather than discovered at deploy time.

---

## API

```bash
npm run serve
```

```bash
curl -F pdf=@paper.pdf -F minutes=4 localhost:8000/api/jobs
curl -N localhost:8000/api/jobs/<id>/stream
```

| Route | Purpose |
|---|---|
| `POST /api/jobs` | Start a job; returns an id immediately |
| `GET /api/jobs/:id/stream` | Progress as server-sent events |
| `GET /api/jobs/:id` | Current state, cost, and events |
| `GET /api/jobs/:id/audio` | Finished audio |
| `GET /api/jobs/:id/transcript` | Episode plus per-turn timings |

Generation and synthesis each take tens of seconds, and a minute of silence is indistinguishable from a hang — so the work is a job with a timeline rather than a request that blocks. A live run:

```
    0%  parsing       Reading the paper
    4%  parsing       Parsed 49 sections, 9435 words
    4%  scripting     Writing the episode
   50%  scripting     Wrote 19 turns
   52%  synthesizing  Recording turn 1 of 19
   …
   85%  synthesizing  Recorded 3.6 minutes · 0 audio errors
  100%  done          Episode ready
```

Percentages are weighted by how long each stage actually takes, measured from real runs — scripting is roughly half the wall clock, so finishing it lands at 50% rather than at an equal-thirds 33%.

**A late subscriber gets the whole story.** Connecting after work has started replays every event first, so a page refresh mid-job does not leave the user staring at a blank progress bar.

**Errors are translated before they reach a client.** A raw provider message can carry request details and tells the reader nothing actionable, so each known failure maps to a stable code, a plain description, and a remedy: `context_truncated`, `output_truncated`, `auth_failed`, `rate_limited`, `provider_unreachable`, `unreadable_input`. Anything unrecognized becomes `internal` and the detail stays in the server log.

Everything above lives in `lib/jobs/` and knows nothing about HTTP; `src/server.ts` is transport only, so the same pipeline runs unchanged behind a Next.js route handler in P5.

**Known limit:** jobs are held in memory and lost on restart. The store is three methods behind an interface, so Redis or a database is a drop-in — but the demo does not pretend otherwise.

---

## Evaluation

```bash
npm run eval                  # generate + score on every provider with credentials
npm run eval:validate         # check the judge itself against known-bad episodes
npm run eval:validate -- --repeat 3   # measure judge variance
```

### Two layers

**Deterministic checks** run first, free and instantly, on every commit: schema, speaker alternation, length targets, show name, honorifics, claimed expertise, author impersonation, naming, and whether proper nouns and figures trace back to the paper. Most fabrication is decidable without a model, and sending an LLM to do a regex's job is slow and expensive.

**An LLM judge** handles what genuinely needs judgement. Faithfulness is scored by decomposition, not by asking a model for a rating out of ten: the transcript is split into atomic claims, and each is marked `supported`, `unsupported`, or `contradicted` against a quoted passage. A list of verdicts with evidence can be read and argued with; a single number cannot.

Only claim verification needs the full paper, so it is passed as cacheable context. Judging several providers on one paper pays for the paper once — measured at 25,762 tokens written to cache, then served from it twice.

### Validating the judge

An eval is only worth its output if the grader is sound, so `eval:validate` runs against captured episodes with known verdicts before any comparison is trusted. The most useful case is not synthetic: it is a real episode about *MapReduce frequent-itemset mining* that a local model produced from the Amazon Aurora paper after its context window silently truncated the input.

| Fixture | Faithfulness | Hallucination | Coverage |
|---|--:|--:|--:|
| `clean-claude` | 93% | 4% | 100% |
| `fabricated-personas` | 91% | 0% | 80% |
| `hallucinated-mapreduce` | **13%** | 47% | 0% |

A judge that rates that last row as faithful is broken. This one places it seven times below the faithful episodes.

Inspecting individual verdicts also caught a bug in the harness rather than the model. Decomposing *"the old bottleneck goes away, but the cost moves to the network"* into its first half alone produced a claim the paper genuinely contradicts — an artifact of splitting, not a hallucination. Extraction now keeps contrastive and qualified statements intact, which moved the clean episode from 88% to 93%.

### Sensitivity: mutation testing

Fixtures prove the checks catch the failures already seen. They say nothing about sensitivity in general, and hand-writing more cases only tests the failures one already thought of. So a clean episode is corrupted one fault at a time — a figure swapped for one the paper never states, a fabricated system introduced, a doctorate handed out, authorship claimed, the show renamed, alternation broken, the dialogue truncated — and each corruption names the check that must catch it.

**All 9 injected corruptions are detected, with no false positives on the uncorrupted control.** The suite reports that as a rate, so a regression in a regex shows up as a number rather than a mysteriously passing build. It needs no API key and runs in CI.

### Judge variance

Repeated grading of the same episode, `claude-sonnet-5`, three runs each:

| Fixture | Mean | Spread |
|---|--:|--:|
| `clean-claude` | 94% | 2.0 pts |
| `fabricated-personas` | 91% | 0.0 pts |
| `hallucinated-mapreduce` | 12% | 8.2 pts |

**A gap of two or three points between models is noise.** Differences are only reported as real when they exceed this.

### Results

Amazon Aurora paper, 4-minute episode, judged by `claude-sonnet-5`:

| Generator | Faithful | Halluc. | Coverage | Compliance | Cost | Time |
|---|--:|--:|--:|--:|--:|--:|
| `claude-sonnet-5` | 91% | 4% | **100%** | 100% | $0.245 | 48s |
| `qwen2:7b-32k` (local) | 94% | 4% | 80% | 100% | free | 174s |

Read carefully, because the headline number is the misleading one. The open model's 3-point faithfulness lead sits inside the judge's 2-point noise band and should be treated as a tie. The real difference is **coverage**: the local model omitted one of the paper's five key contributions — that an asynchronous scheme based on log sequence numbers replaces two-phase commit — while Claude conveyed all five in roughly four times the output.

That is the trap in scoring faithfulness alone. **An episode that says less has less to be wrong about**, and a model that says nothing at all scores perfectly. Coverage is what stops faithfulness from rewarding silence, and the two belong in the same table.

Both `results/*.md` reports flag when the judge and generator are the same model. Models favour their own output, so a self-judged score is an upper bound, not a neutral measurement; `JUDGE_PROVIDER` exists to break that tie once a second provider is available.

### Adding a paper

Drop a PDF into `sample_papers/` — it is discovered automatically — then add its key contributions to `ANNOTATIONS` in [`lib/eval/dataset.ts`](lib/eval/dataset.ts).

Without annotations, coverage is reported as **not measured** rather than 0%. That distinction matters: scoring an unannotated paper 0% would read as "the episode covered nothing" and quietly condemn every newly added paper. The runner warns when annotations are missing.

### Known limits

- One paper. A comparison across a single document shows the harness works, not which model is better; more papers are the obvious next step.
- Claude currently judges its own output on the frontier row, flagged in every report.
- Coverage depends on hand-annotated contributions, so it exists only for annotated papers.
- Mutation testing currently exercises the deterministic layer only; the judge's own detection rate is not yet measured.

**Full design rationale:** [docs/evaluation-design.md](docs/evaluation-design.md).

---

## Design decisions

**Why a provider abstraction rather than one SDK.** With only Claude and GPT the abstraction would be a formality — both support structured output natively. Adding an open model forces it to earn its keep: many OSS endpoints have no reliable tool-use or JSON-schema support, so the adapter has to coerce and validate. That coercion path is the part worth reading in `openCompatible.ts`.

**Why section-aware extraction and not full map-reduce chunking.** Modern context windows swallow most papers whole, so chunking a typical paper would be engineering theater. The real quality win is *what* you send, not how you split it — dropping the reference list and appendix measurably reduces fabricated citations. Papers that genuinely exceed the budget are truncated and flagged (`truncatedInput`) rather than silently cut.

**Why structured output instead of parsing text.** The original prototype asked for one blob of prose and split it with regex, which needed a second model call whenever the markers didn't appear. A schema removes the failure mode entirely.

**Why the pipeline fails loudly on context overflow.** Self-hosted endpoints cap the context window well below the model's real limit and do not error when a prompt exceeds it — they quietly drop the overflow. Ollama, for instance, defaults to 4,096 tokens no matter what the model supports, and ignores `num_ctx` over its OpenAI-compatible route.

This was found the hard way. Running the Amazon Aurora paper (~17k tokens) through a local 7B model produced a fluent, well-structured episode about *frequent itemset mining with MapReduce* — a topic found nowhere in the paper. The model had seen roughly a quarter of the input and confabulated the rest, with no error anywhere in the stack.

`lib/llm/contextGuard.ts` now compares the tokens sent against the tokens the server reports processing and aborts on a large shortfall. For a faithfulness-first system, a hard failure with remediation steps is strictly better than a confident, plausible, wrong answer.

---

## Development

```bash
npm test          # Vitest — 265 tests
npm run typecheck # tsc --noEmit
npm run lint      # ESLint
npm run format    # Prettier
```

Tests are deliberately network-free: PDF parsing runs against a flattened-paper fixture, providers are exercised through a stub, and the open-model JSON coercion is tested directly against malformed model output.

---

## What is next

- **P6 — Ship.** CI covering the web build, and a deployed URL. The app needs a long-lived Node process rather than serverless: a job runs about eighty seconds and the store is process memory. Moving the store to Redis is what would change that, and `lib/jobs` is storage-agnostic so it can.
- **More papers.** The provider comparison currently runs on one. It demonstrates the harness works, not which model is better.
- **An independent judge.** Claude grades its own output on the frontier row, flagged in every report. A second provider breaks the tie; `JUDGE_PROVIDER` exists for it.
- **Judge sensitivity.** Mutation testing covers the deterministic layers. Running the same corruptions through the LLM judge would give a detection rate for the expensive layer too.
