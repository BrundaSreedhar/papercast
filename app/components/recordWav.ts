/**
 * Recording the microphone as 16 kHz mono WAV, in the browser.
 *
 * `MediaRecorder` is the obvious tool and the wrong one here: it produces
 * webm/opus, whisper.cpp reads uncompressed 16 kHz mono WAV, and converting
 * between them means ffmpeg on the server, which is a dependency this project
 * does not have and does not want. Capturing raw samples and writing the WAV
 * header here removes the conversion entirely.
 *
 * The audio context is *asked* for 16 kHz, which Chrome honours and some
 * browsers quietly ignore, so the samples are resampled on the way out rather
 * than trusted. Getting that wrong does not fail loudly — it produces audio at
 * the wrong speed, which transcribes as confident nonsense.
 */

const TARGET_RATE = 16_000;

export interface Recorder {
  /** Stop capturing and return the recording as a WAV blob. */
  stop(): Promise<Blob>;
  /** Abandon the recording and release the microphone. */
  cancel(): void;
}

export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const context = new AudioContext({ sampleRate: TARGET_RATE });
  const source = context.createMediaStreamSource(stream);

  // An AudioWorklet rather than the deprecated ScriptProcessor, loaded from a
  // blob so it needs no separate file served alongside the app.
  const workletSource = `
    class Capture extends AudioWorkletProcessor {
      process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) this.port.postMessage(channel.slice(0));
        return true;
      }
    }
    registerProcessor("capture", Capture);
  `;
  const url = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const node = new AudioWorkletNode(context, "capture");
  const blocks: Float32Array[] = [];
  node.port.onmessage = (e: MessageEvent<Float32Array>) => blocks.push(e.data);
  source.connect(node);
  // Connecting to the destination would play the microphone back through the
  // speakers, which with an episode already playing is a feedback loop.
  node.connect(context.destination);
  node.disconnect(context.destination);

  const release = () => {
    node.port.onmessage = null;
    try {
      source.disconnect();
      node.disconnect();
    } catch {
      /* already torn down */
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };

  return {
    async stop(): Promise<Blob> {
      const rate = context.sampleRate;
      release();
      const samples = merge(blocks);
      return encodeWav(
        rate === TARGET_RATE ? samples : resample(samples, rate, TARGET_RATE),
      );
    },
    cancel: release,
  };
}

function merge(blocks: Float32Array[]): Float32Array {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** Linear resampling. Speech at 16 kHz does not need anything cleverer. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    const t = at - low;
    out[i] = input[low]! * (1 - t) + input[high]! * t;
  }
  return out;
}

/** 16-bit PCM mono WAV — the one format whisper.cpp takes without complaint. */
function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample past ±1 wraps rather than clips, and a
    // wrapped sample is a loud click in the middle of the question.
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}
