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
# Piper is fetched here rather than installed from a package, because the free
# local voice is the project's default and a deployment that quietly swapped it
# for a paid API would be advertising something it does not do.

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
# 150 MB of model weights and PDFs.
FROM node:20-bookworm-slim AS assets
ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICES=v1.0.0
WORKDIR /assets
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) piper_arch=x86_64 ;; \
      arm64) piper_arch=aarch64 ;; \
      *) echo "no Piper build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${piper_arch}.tar.gz" \
 && mkdir -p /opt && tar -xzf piper.tar.gz -C /opt && rm piper.tar.gz \
 && /opt/piper/piper --help > /dev/null 2>&1 || true

# Two voices, one per speaker, so the hosts are told apart by sound and not only
# by a label in the transcript.
RUN mkdir -p /opt/voices \
 && base="https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES}/en/en_US" \
 && for v in lessac ryan; do \
      curl -fsSL -o "/opt/voices/en_US-${v}-medium.onnx" "${base}/${v}/medium/en_US-${v}-medium.onnx"; \
      curl -fsSL -o "/opt/voices/en_US-${v}-medium.onnx.json" "${base}/${v}/medium/en_US-${v}-medium.onnx.json"; \
    done

# The demo shelf, fetched from the manifest rather than committed to the repo.
COPY demo/papers.json ./demo/papers.json
COPY scripts/fetch-demo-papers.mjs ./scripts/fetch-demo-papers.mjs
RUN node scripts/fetch-demo-papers.mjs

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TTS_PROVIDER=piper \
    PIPER_BIN=/opt/piper/piper \
    PIPER_HOST_VOICE=/opt/voices/en_US-lessac-medium.onnx \
    PIPER_GUEST_VOICE=/opt/voices/en_US-ryan-medium.onnx \
    LD_LIBRARY_PATH=/opt/piper

# poppler for the figure-reading path, libgomp for the ONNX runtime Piper ships.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils libgomp1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=assets /opt/piper /opt/piper
COPY --from=assets /opt/voices /opt/voices
COPY --from=assets /assets/demo /app/demo

# The standalone build carries only the dependencies the server actually
# reaches; static assets and `public/` are copied beside it, as it expects.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Episodes are written under public/audio and streamed back from there, so the
# unprivileged user the server runs as has to own it.
RUN mkdir -p /app/public/audio && chown -R node:node /app/public
USER node

EXPOSE 3000
CMD ["node", "server.js"]
