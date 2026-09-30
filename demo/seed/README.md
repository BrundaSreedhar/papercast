# Pre-made shelf episodes

`npm run seed:demo` writes an episode per demo paper here — the record in
`episodes/`, the recording in `audio/` — and the Dockerfile copies both into
the image, so a deployed demo opens on something to listen to instead of on an
empty shelf.

The contents are ignored by git: three four-minute WAVs are tens of megabytes,
and one command rebuilds them. This directory is tracked (and this file exists)
only so the Dockerfile's `COPY` has something to find on a clean checkout.
