/** @type {import('next').NextConfig} */
export default {
  // The pipeline shells out to Piper and whisper.cpp and reads voice models
  // from disk, so these routes must run on Node rather than the edge runtime.
  serverExternalPackages: ["pdf-parse", "@anthropic-ai/sdk", "openai"],
  // Emit a server that carries only the dependencies actually reached, so the
  // deployed image holds a traced subset of node_modules rather than all of it.
  output: "standalone",
};
