/**
 * Deliberate corruption of synthesized audio, mirroring the text mutations.
 *
 * These reproduce the ways synthesis actually goes wrong: a call returning an
 * empty buffer, a chunk being dropped so a turn is cut short, or a timeline
 * drifting out of step with the file it describes. Each is silent on playback —
 * the episode still plays — which is exactly why they need a machine to notice.
 */
import { buildWav, parseWav } from "../tts/wav";
import type { EpisodeAudio } from "../tts/types";

export type AudioMutationKind =
  | "silence-turn"
  | "truncate-audio"
  | "desync-timeline"
  | "overlap-turns"
  | "drop-turn-timing"
  | "change-voice";

export interface AudioMutation {
  kind: AudioMutationKind;
  expectedCheck: string;
  description: string;
}

export const AUDIO_MUTATIONS: AudioMutation[] = [
  {
    kind: "silence-turn",
    expectedCheck: "silent-turns",
    description: "A synthesis call returned an empty buffer, so one turn is silent",
  },
  {
    kind: "truncate-audio",
    expectedCheck: "timeline-matches-audio",
    description: "The file is shorter than the timeline claims, as if a chunk were lost",
  },
  {
    kind: "desync-timeline",
    expectedCheck: "timeline-matches-audio",
    description: "Timings drift past the end of the audio they describe",
  },
  {
    kind: "overlap-turns",
    expectedCheck: "timeline-order",
    description: "Two turns overlap on the timeline",
  },
  {
    kind: "drop-turn-timing",
    expectedCheck: "turns-voiced",
    description: "A turn has no entry on the timeline at all",
  },
  {
    kind: "change-voice",
    expectedCheck: "voice-consistency",
    description:
      "One turn comes out in a lower voice than the rest, as a regenerated voice drifted",
  },
];

function clone(audio: EpisodeAudio): EpisodeAudio {
  return {
    ...audio,
    audio: Buffer.from(audio.audio),
    timings: audio.timings.map((t) => ({ ...t })),
  };
}

/** Zero the PCM belonging to one turn, leaving its timing in place. */
function silenceRange(buf: Buffer, startMs: number, endMs: number): Buffer {
  const parsed = parseWav(buf);
  const { format, data } = parsed;
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const start = Math.floor((startMs / 1000) * format.sampleRate) * bytesPerFrame;
  const end = Math.min(
    data.length,
    Math.ceil((endMs / 1000) * format.sampleRate) * bytesPerFrame,
  );
  const copy = Buffer.from(data);
  copy.fill(0, Math.max(0, start), Math.max(0, end));
  return buildWav(format, copy);
}

/**
 * Lower the pitch of one turn by a quarter, keeping its length.
 *
 * Resampling stretches the turn as it lowers it, so the stretched audio is cut
 * back to the turn's own span: the timeline stays true, and the only thing that
 * changed is who seems to be speaking.
 */
function lowerVoice(buf: Buffer, startMs: number, endMs: number, factor = 0.75): Buffer {
  const parsed = parseWav(buf);
  const { format, data } = parsed;
  const frameBytes = (format.bitsPerSample / 8) * format.channels;
  const start = Math.floor((startMs / 1000) * format.sampleRate);
  const end = Math.min(
    Math.floor(data.length / frameBytes),
    Math.ceil((endMs / 1000) * format.sampleRate),
  );
  const copy = Buffer.from(data);
  for (let f = start; f < end; f++) {
    // Read the original at a slower rate: frame f takes the sample that was
    // at start + (f - start) * factor, which lowers every frequency by factor.
    const src = start + Math.floor((f - start) * factor);
    for (let c = 0; c < format.channels; c++) {
      copy.writeInt16LE(
        data.readInt16LE(src * frameBytes + c * 2),
        f * frameBytes + c * 2,
      );
    }
  }
  return buildWav(format, copy);
}

export function applyAudioMutation(
  audio: EpisodeAudio,
  kind: AudioMutationKind,
): EpisodeAudio {
  const out = clone(audio);
  if (out.timings.length === 0) return out;
  const target = Math.min(1, out.timings.length - 1);

  switch (kind) {
    case "silence-turn": {
      const t = out.timings[target]!;
      out.audio = silenceRange(out.audio, t.startMs, t.endMs);
      break;
    }
    case "truncate-audio": {
      // Drop the final third of the samples without adjusting the timeline.
      const parsed = parseWav(out.audio);
      const keep = Math.floor(parsed.data.length * 0.66);
      out.audio = buildWav(parsed.format, parsed.data.subarray(0, keep));
      break;
    }
    case "desync-timeline": {
      // Shift everything later, as an accumulated offset would.
      const shift = 5_000;
      out.timings = out.timings.map((t) => ({
        ...t,
        startMs: t.startMs + shift,
        endMs: t.endMs + shift,
      }));
      out.totalMs += shift;
      break;
    }
    case "overlap-turns": {
      if (out.timings.length >= 2) {
        out.timings[1] = {
          ...out.timings[1]!,
          startMs: Math.max(0, out.timings[0]!.endMs - 1_000),
        };
      }
      break;
    }
    case "drop-turn-timing":
      out.timings = out.timings.filter((_, i) => i !== target);
      break;
    case "change-voice": {
      const t = out.timings[target]!;
      out.audio = lowerVoice(out.audio, t.startMs, t.endMs);
      break;
    }
  }
  return out;
}
