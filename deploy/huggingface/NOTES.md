# Putting the demo on Hugging Face Spaces

Spaces runs the container as it is, which is what this deployment needs: the
app is a long-lived server, not a set of functions, because a job outlives the
request that starts it. Docker Spaces require a paid plan. Fly.io is the
alternative and its config is in [`fly.toml`](../../fly.toml).

## Why the config lives here and not in the repository README

A Space is itself a git repository, and Spaces reads its settings from a YAML
header at the top of _that_ repository's `README.md` — the title, the emoji,
and `app_port: 3000`, without which Spaces looks for the app on port 7860 and
finds nothing. Those settings belong to the Space, not to this project, so the
`README.md` here is the one to copy over and the project's own README is left
alone.

## The part that is easy to get wrong

**Spaces builds the image from the pushed repository.** It does not take an
image built on your machine. So anything the build needs has to be in git —
and the pre-made episodes in `demo/seed/` are ignored by default, because they
are large and rebuildable. Push without them and the Space builds a working app
with an empty shelf.

They are also too big for plain git: the Hub refuses files over 10 MB, and four
minutes of 24 kHz mono is about 12 MB. They go through Git LFS, which the
repository's [`.gitattributes`](../../.gitattributes) already configures.

```bash
brew install git-lfs && git lfs install
```

## Once

Stage the episodes you want on the shelf, if you have not already:

```bash
npm run seed:demo -- --from-library
```

That lists what is on this machine; pass the ids you want back to it. Then
create a **Docker** Space on the Hub and push to it from a branch that carries
both the Space metadata and the episodes:

```bash
git checkout -b space
```

```bash
cp deploy/huggingface/README.md README.md && git add -f README.md demo/seed && git commit -m "Space metadata and seeded episodes"
```

```bash
git remote add space https://huggingface.co/spaces/<you>/papercast && git push space space:main
```

`-f` is doing real work in that middle command: it overrides `.gitignore` for
`demo/seed`, which is exactly what this branch is for and what `main` should
never do. Keeping it on its own branch means the project README and the
ignored audio stay as they are on `main`, and later changes come across with
`git rebase space onto main`.

## The key

In the Space's **Settings → Variables and secrets**, add the API key as a
_secret_ (not a variable — variables are visible):

|                  |                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| `GEMINI_API_KEY` | from [Google AI Studio](https://aistudio.google.com/apikey); free tier, no card |

and as _variables_:

|                |          |
| -------------- | -------- |
| `LLM_PROVIDER` | `gemini` |
| `DEMO_MODE`    | `1`      |

Everything else — the voice, the limits, the shelf — has a working default in
the image. `TTS_PROVIDER` is already `kokoro`, so the Space speaks in the local
voice and the speech side costs nothing however many people open it.

Use a key made for this Space rather than the one on your own machine. The
demo's ceilings bound what visitors can spend, but a key they share with your
own work still means their traffic and yours draw on the same free tier.

## What the limits are

`DEMO_MODE=1` is the difference between a portfolio link and an open tap:

- **No uploads.** Visitors pick from the shelf of papers baked into the image
  (`demo/papers.json`), so the deployment never accepts an arbitrary file.
- **Episodes:** one at a time, 25 a day, 4 minutes at most.
- **Questions:** two at a time, 200 a day.

The two allowances are separate, so a day's episodes running out still leaves
the shelf listenable and askable — which is most of what there is to see.

`GET /api/health` reports what the gate is holding, and is the first thing to
read when the demo refuses something.

## Keeping what the running Space writes

A Space's own disk is ephemeral: episodes made on the deployment land in
`data/episodes` and `public/audio` inside the container, and a restart, a
rebuild or a wake from sleep takes them. That is why the shelf is seeded into
the image instead — an image cannot be wiped.

If episodes made _on_ the deployment should also survive, attach a **Storage
Bucket** as a volume in the Space settings. Two mounts cover it, and neither
needs a code change, because both paths are already where the app reads and
writes:

| Mount path          | Holds                       |
| ------------------- | --------------------------- |
| `/app/data`         | episode records, embeddings |
| `/app/public/audio` | recordings                  |

Two things to check when doing this. The container runs as uid 1000 (`node`),
so a volume mounted owned by root leaves the server unable to write to it. And
a mount over `/app/public/audio` hides the seeded recordings copied there at
build time, so the seed has to be copied onto the volume once, or moved to a
path the mount does not cover.

Uploading on the deployment is a separate matter: `DEMO_MODE=1` refuses uploads
from everyone, the owner included. An owner-only path would need a token check
that is not written yet.

## Things worth knowing

- **The first request after a sleep is slow.** Spaces stops the container when
  idle and starts it again on the next visit; the Kokoro worker then loads its
  weights once, about a second, and stays loaded.
- **Build it for amd64.** That is what Spaces runs, and what the `onnxruntime`
  and `espeakng-loader` wheels the voice needs are surest on.
- **The image is about 1 GB.** Most of it is the Kokoro weights and the Python
  runtime, both fixed costs that do not grow with the shelf.
