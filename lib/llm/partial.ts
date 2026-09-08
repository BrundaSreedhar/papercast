/**
 * Reading one string field out of JSON that has not finished arriving.
 *
 * Structured output and streaming pull against each other: the answer is a
 * field inside an object, so the tokens arriving are `{"kind":"from-paper",
 * "answer":"The paper pro` and not prose. Showing that raw would be worse than
 * showing nothing.
 *
 * Rather than a streaming JSON parser, this looks for one known key and reads
 * its value as far as it goes. That is enough for the only thing worth showing
 * live — the prose — and it cannot half-apply a structural change, because the
 * complete response is still parsed and validated normally when it lands. If
 * this returns nothing, the reader simply waits as they did before.
 */

/**
 * The value of `field` so far, or undefined if it has not started arriving.
 *
 * Escapes are resolved as they are read, and a trailing backslash is held back
 * rather than emitted, so a partial `é` never shows up as stray
 * characters that then disappear.
 */
export function partialString(json: string, field: string): string | undefined {
  const key = `"${field}"`;
  const at = json.indexOf(key);
  if (at === -1) return undefined;

  // Step over the key, any whitespace, the colon, then to the opening quote.
  let i = at + key.length;
  while (i < json.length && /\s/.test(json[i]!)) i++;
  if (json[i] !== ":") return undefined;
  i++;
  while (i < json.length && /\s/.test(json[i]!)) i++;
  if (json[i] !== '"') return undefined;
  i++;

  let out = "";
  while (i < json.length) {
    const ch = json[i]!;

    if (ch === "\\") {
      const next = json[i + 1];
      // An escape that is still arriving: stop rather than guess at it.
      if (next === undefined) return out;
      if (next === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) return out;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += UNESCAPE[next] ?? next;
      i += 2;
      continue;
    }

    // The closing quote: the field is complete.
    if (ch === '"') return out;

    out += ch;
    i++;
  }

  return out;
}

const UNESCAPE: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};
