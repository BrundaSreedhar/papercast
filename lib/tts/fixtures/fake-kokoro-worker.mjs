// A stand-in for scripts/kokoro_worker.py, speaking the same protocol, so the
// adapter can be tested without Python or the model. Text containing "FAIL"
// is refused; text containing "DIE" kills the worker mid-request.
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

function wav(samples) {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

process.stdout.write(
  `${JSON.stringify({ ready: true, voices: ["af_heart", "am_michael"] })}\n`,
);
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.text.includes("DIE")) process.exit(3);
  if (req.text.includes("FAIL")) {
    process.stdout.write(
      `${JSON.stringify({ id: req.id, error: `no voice ${req.voice}` })}\n`,
    );
    return;
  }
  // One sample per character, so a test can tell which text produced which file.
  writeFileSync(req.out, wav(req.text.length));
  process.stdout.write(`${JSON.stringify({ id: req.id, ok: true })}\n`);
});
