# Paper → Podcast

Drop in a research paper, get a podcast episode that says **only what the paper says**, with every line traced back to its page.

---

## What you get

- **An episode from any PDF.** Two hosts, a solo narrator, or explained simply; a 5-minute summary or a 10-minute deep dive.
- **Nothing made up.** Each line is linked to the page it came from, and an eval harness measures how faithful the script is.
- **Ask the paper.** Type or speak a question; an agent searches and reads the paper, then answers with page citations.
- **A map of ideas.** Concepts across all your episodes, how they relate, and links to the moment each one is discussed.
- **Runs free and local.** Local models for the script (Ollama) and the voice (Kokoro). Claude, OpenAI and Gemini are one setting away.

---

## Quick start

**You need:** Node 20+, and [uv](https://docs.astral.sh/uv/) for the local voice.

```bash
npm install
cp .env.example .env        # add any API keys you have
npm run dev                 # open http://localhost:3000
```

### Local voice: Kokoro (recommended)

A small, natural-sounding speech model that runs on your CPU. One-time setup, about 350 MB:

```bash
uv venv .venv-tts --python 3.12
uv pip install --python .venv-tts/bin/python kokoro-onnx

mkdir -p .voices/kokoro
curl -L -o .voices/kokoro/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o .voices/kokoro/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Then set `TTS_PROVIDER=kokoro` in `.env`, or leave it unset and the best local voice installed is used automatically.

| Setting                 | Default      |                                             |
| ----------------------- | ------------ | ------------------------------------------- |
| `KOKORO_NARRATOR_VOICE` | `af_heart`   | American female                             |
| `KOKORO_HOST_VOICE`     | `af_heart`   |                                             |
| `KOKORO_GUEST_VOICE`    | `am_michael` | American male, so two hosts sound different |
| `KOKORO_SPEED`          | `1`          |                                             |

<details>
<summary>Other voices: Gemini, OpenAI, Piper, macOS</summary>

| `TTS_PROVIDER` | Needs            | Notes                                                                            |
| -------------- | ---------------- | -------------------------------------------------------------------------------- |
| `kokoro`       | the setup above  | Local, free, natural                                                             |
| `gemini`       | `GEMINI_API_KEY` | Hosted; best-sounding when quota allows. Falls back to a local voice if it fails |
| `openai`       | `OPENAI_API_KEY` | Hosted, about $0.09 an episode                                                   |
| `piper`        | the setup below  | Local, free, flatter; kept as the last-resort backup                             |
| `say`          | macOS            | Built in, no setup                                                               |

Piper, as a backup voice:

```bash
uv pip install --python .venv-tts/bin/python piper-tts
base=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US
for v in lessac ryan; do
  curl -L -o .voices/en_US-$v-medium.onnx      $base/$v/medium/en_US-$v-medium.onnx
  curl -L -o .voices/en_US-$v-medium.onnx.json $base/$v/medium/en_US-$v-medium.onnx.json
done
```

</details>

<details>
<summary>Local script model: Ollama</summary>

```bash
ollama pull qwen2:7b
ollama create qwen2:7b-32k -f ollama/qwen2-32k.Modelfile   # a context window big enough for a paper
```

Set `LLM_PROVIDER=open` and `OPEN_MODEL=qwen2:7b-32k` in `.env`. A 7B model writes a decent episode; the fact-checking judge wants a stronger hosted model.

</details>

<details>
<summary>Checking audio against the script: whisper.cpp (optional)</summary>

```bash
brew install whisper-cpp
mkdir -p .models && curl -L -o .models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

</details>

---

## Commands

|                                 |                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                   | The web app                                                                             |
| `npm run generate -- paper.pdf` | Make an episode from the command line (`--minutes 5`, `--solo`, `--eli5`, `--provider`) |
| `npm run rerecord -- latest`    | Record an episode again in the current voice                                            |
| `npm run concepts`              | Name the key concepts of existing episodes                                              |
| `npm run reparse`               | Rebuild episodes' sections after an extraction change                                   |
| `npm run eval`                  | Generate and score episodes across providers                                            |
| `npm run eval:validate`         | Check the judge against known-bad episodes                                              |
| `npm test`                      | 739 tests, no network needed                                                            |

---

## How it works

```
PDF ─► extract sections ─► write the script ─► check it ─► record it ─► web app
       (tables, refs,       (Claude · OpenAI ·  (claim by    (Kokoro ·     (player, transcript,
        bibliography         Gemini · local)     claim, and   Gemini ·      Ask the paper,
        stripped)                                every line   Piper)        concept map)
                                                 traced to
                                                 a page)
```

Every model sits behind one small interface (`LLMProvider`, `TTSProvider`, …), so switching providers is a config change and the test suite runs with fakes.

---

## Measured

|                                                               |             |
| ------------------------------------------------------------- | ----------: |
| Faithfulness of a clean episode, scored claim by claim        |     **93%** |
| Faithfulness of a known-hallucinated episode (must be caught) |     **13%** |
| Injected script corruptions detected                          | **12 / 12** |
| Injected audio corruptions detected                           |   **6 / 6** |
| Script wording found in the audio, by transcription           |     **96%** |
| Judge variance across repeat runs                             |  **±2 pts** |

Reproduce with `npm run eval`, `npm run eval:validate` and `npm test`. How the harness works, and why these numbers can be trusted: [docs/design.md](docs/design.md).

---

## Deploy

```bash
docker build -t papercast .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-... papercast
```

`DEMO_MODE=1` makes a safe public demo: no uploads, a fixed shelf of papers, and daily limits. Details in [docs/design.md](docs/design.md#deployment).

---

## Learn more

- [Design notes](docs/design.md): architecture, evaluation, tracing, and the key decisions
- [Evaluation design](docs/evaluation-design.md)
