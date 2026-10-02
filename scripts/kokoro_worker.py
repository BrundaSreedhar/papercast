"""
Kokoro speech, served to the Node process one request at a time.

Loading the model takes about a second, and an episode is a dozen or more
synthesis calls in a row. A process per call — the way Piper is run — would
spend a second of every turn loading the same weights again, so this loads
once and answers JSON lines on stdin:

    {"id": 1, "text": "…", "voice": "af_heart", "speed": 1.0, "out": "/tmp/x.wav"}

and replies on stdout with {"id": 1, "ok": true} or {"id": 1, "error": "…"}.
The first line it prints is {"ready": true, "voices": [...]}, once the model is
loaded. Audio goes to the file named in the request as 16-bit mono WAV at the
model's own rate (24 kHz), which is what every other backend's output joins
with.

    .venv-tts/bin/python scripts/kokoro_worker.py MODEL.onnx VOICES.bin
"""

import json
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro


def main() -> None:
    model, voices = sys.argv[1], sys.argv[2]
    kokoro = Kokoro(model, voices)
    print(json.dumps({"ready": True, "voices": kokoro.get_voices()}), flush=True)

    for line in sys.stdin:
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            samples, rate = kokoro.create(
                request["text"],
                voice=request["voice"],
                speed=float(request.get("speed", 1.0)),
                lang=request.get("lang", "en-us"),
            )
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
            with wave.open(request["out"], "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(pcm)
            print(json.dumps({"id": request["id"], "ok": True}), flush=True)
        except Exception as err:  # reported back, never fatal to the worker
            print(json.dumps({"id": request.get("id"), "error": str(err)}), flush=True)


if __name__ == "__main__":
    main()
