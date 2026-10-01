/**
 * Deciding which bytes of a recording to send.
 *
 * Pure, and here rather than beside the route, because this is the part worth
 * testing: a player that cannot seek looks broken halfway through a
 * four-minute episode, and the failure is silent.
 *
 * Range requests have to be honoured rather than merely advertised. The first
 * version of the audio route sent `Accept-Ranges: bytes` and then ignored the
 * header, handing back the whole file from the start whatever was asked for.
 */

/** Ids reach this over HTTP and become a path, so they are checked, not trusted. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeAudioId(id: string): boolean {
  return ID.test(id);
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The bytes a `Range` header asks for, or what to do instead.
 *
 * `null` means "none asked for, send the whole thing"; `"unsatisfiable"` means
 * it named bytes that do not exist, which is a 416 rather than a silent full
 * response.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multipart or malformed: fall back to the whole file
  const [, rawStart, rawEnd] = match;

  // "bytes=-500" means the last 500 bytes, not "from 0 to 500".
  if (rawStart === "") {
    const wanted = Number(rawEnd);
    if (!rawEnd || !Number.isFinite(wanted) || wanted <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}
