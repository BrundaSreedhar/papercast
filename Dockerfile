# syntax=docker/dockerfile:1
#
# The whole pipeline in one container: the Next.js app, a neural voice, and the
# papers the public demo is allowed to run.
#
# It is a long-lived server rather than a set of functions, and that is a
# property of the work, not a preference. Jobs live in process memory and
# outlast the request that starts them by minutes, so a platform that hands each
# request its own instance would lose every job the moment it returned an id.
#
# The voices are fetched here rather than installed from a package, because the
# free local voice is the project's default and a deployment that quietly
# swapped it for a paid API would be advertising something it does not do.
#
# Kokoro is the voice the image speaks in, with Piper kept behind it. That is
# the same order `resolveTTSProvider` falls through locally, and it is worth the
# extra weight: Piper alone is what made the first deployed episodes sound flat,
# which is the one thing a demo of a podcast generator cannot afford.

# ---- dependencies -----------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:web

# ---- voices and papers ------------------------------------------------------
# A stage of its own so that changing a line of code does not re-download
# half a gigabyte of model weights and PDFs.
FROM node:20-bookworm-slim AS assets
ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICES=v1.0.0
ARG KOKORO_FILES=model-files-v1.0
WORKDIR /assets
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Kokoro: 82M parameters, Apache-2.0, fixed voice presets. Pinned to a release
# tag rather than a branch, so an image built next month sounds like this one.
RUN mkdir -p /opt/voices/kokoro \
 && base="https://github.com/thewh1teagle/kokoro-onnx/releases/download/${KOKORO_FILES}" \
 && curl -fsSL -o /opt/voices/kokoro/kokoro-v1.0.onnx "${base}/kokoro-v1.0.onnx" \
 && curl -fsSL -o /opt/voices/kokoro/voices-v1.0.bin  "${base}/voices-v1.0.bin"

RUN case "${TARGETARCH}" in \
      amd64) piper_arch=x86_64 ;; \
      arm64) piper_arch=aarch64 ;; \
      *) echo "no Piper build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${piper_arch}.tar.gz" \
 && mkdir -p /opt && tar -xzf piper.tar.gz -C /opt && rm piper.tar.gz \
 && /opt/piper/piper --help > /dev/null 2>&1 || true

# Two Piper voices, one per speaker, so that if the fallback is ever reached the
# hosts are still told apart by sound and not only by a label in the transcript.
RUN base="https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES}/en/en_US" \
 && for v in lessac ryan; do \
      curl -fsSL -o "/opt/voices/en_US-${v}-medium.onnx" "${base}/${v}/medium/en_US-${v}-medium.onnx"; \
      curl -fsSL -o "/opt/voices/en_US-${v}-medium.onnx.json" "${base}/${v}/medium/en_US-${v}-medium.onnx.json"; \
    done

# The demo shelf, fetched from the manifest rather than committed to the repo.
COPY demo/papers.json ./demo/papers.json
COPY scripts/fetch-demo-papers.mjs ./scripts/fetch-demo-papers.mjs
RUN node scripts/fetch-demo-papers.mjs

# ---- speech runtime ---------------------------------------------------------
# Kokoro runs through onnxruntime in Python, in a virtualenv of its own. Its own
# stage because the wheels are large and change far less often than the app.
FROM node:20-bookworm-slim AS speech
ARG KOKORO_ONNX=0.6.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# No PyTorch: the ONNX build is the whole reason this fits in a small container.
RUN python3 -m venv /opt/tts \
 && /opt/tts/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/tts/bin/pip install --no-cache-dir "kokoro-onnx==${KOKORO_ONNX}" \
 && find /opt/tts -name '__pycache__' -type d -prune -exec rm -rf {} +

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TTS_PROVIDER=kokoro \
    KOKORO_PYTHON=/opt/tts/bin/python \
    KOKORO_MODEL=/opt/voices/kokoro/kokoro-v1.0.onnx \
    KOKORO_VOICES=/opt/voices/kokoro/voices-v1.0.bin \
    PIPER_BIN=/opt/piper/piper \
    PIPER_HOST_VOICE=/opt/voices/en_US-lessac-medium.onnx \
    PIPER_GUEST_VOICE=/opt/voices/en_US-ryan-medium.onnx \
    LD_LIBRARY_PATH=/opt/piper

# poppler for the figure-reading path; libgomp for the ONNX runtime both voices
# use; python3 for the Kokoro worker, whose virtualenv is copied in below and
# needs an interpreter of the same version the wheels were built against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       poppler-utils libgomp1 python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=speech /opt/tts /opt/tts
COPY --from=assets /opt/piper /opt/piper
COPY --from=assets /opt/voices /opt/voices
COPY --from=assets /assets/demo /app/demo

# The standalone build carries only the dependencies the server actually
# reaches; static assets and `public/` are copied beside it, as it expects.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The Kokoro provider spawns this by path rather than importing it. The
# standalone output happens to carry it today, but a file reached that way is
# invisible to dependency tracing on purpose, so it is copied explicitly rather
# than left to be incidental — a silent loss here would take the voice with it.
COPY --from=build /app/scripts/kokoro_worker.py ./scripts/kokoro_worker.py

# Episodes are written under data/ and public/audio and read back from there, so
# the unprivileged user the server runs as has to own both — including the
# directories themselves, since the server creates what is missing and cannot
# make a directory inside one that root owns.
RUN mkdir -p /app/public/audio /app/data/episodes /app/data/embeddings

# Episodes made in advance by `npm run seed:demo`, so the demo opens on
# something to listen to rather than asking the first visitor to spend four
# minutes and somebody's quota before anything happens. The directory is
# tracked but its contents are not, so on a checkout that has not been seeded
# these copy nothing and the shelf is simply empty — a deployment that works
# either way beats a build that fails when the episodes are missing.
COPY --from=build /app/demo/seed/episodes/ /app/data/episodes/
COPY --from=build /app/demo/seed/audio/ /app/public/audio/

RUN chown -R node:node /app/public /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
