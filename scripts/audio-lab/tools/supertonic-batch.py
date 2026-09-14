#!/usr/bin/env python3
"""Batch Supertonic synthesis for the audio lab's fixture corpus.

One process for the whole corpus: loading the ONNX model costs seconds, and
loading it once per sentence would dominate the runtime of a routine loop.

Input (argv[1]) is a JSON file:
    {"voice": "M1", "steps": 8, "speed": 1.05, "silence": 0.05,
     "outDir": "/abs/dir", "texts": [{"id": "chunk-00", "text": "..."}, ...]}

Output: one `<outDir>/<id>.wav` per text (44.1 kHz mono PCM16) plus
`<outDir>/result.json` with per-item sample counts and durations. Errors are
reported per item so one bad sentence cannot silently vanish from the corpus.

This is a LAB-OWNED tool (see scripts/audio-lab/), not a skill asset: the
text-to-speech skill's own script stays the shared, documented entrypoint for
general synthesis.
"""

import json
import sys
import traceback
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: supertonic-batch.py <job.json>", file=sys.stderr)
        return 2
    job_path = Path(sys.argv[1])
    job = json.loads(job_path.read_text())
    out_dir = Path(job["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    from supertonic import TTS
    import soundfile as sf

    tts = TTS(model=job.get("model", "supertonic-3"))
    style = tts.get_voice_style(job.get("voice", "M1"))
    steps = int(job.get("steps", 8))
    speed = float(job.get("speed", 1.05))
    silence = float(job.get("silence", 0.05))

    results = []
    for item in job["texts"]:
        entry = {"id": item["id"], "text": item["text"]}
        try:
            audio, duration = tts.synthesize(
                item["text"],
                voice_style=style,
                total_steps=steps,
                speed=speed,
                silence_duration=silence,
                lang=job.get("lang"),
            )
            path = out_dir / (item["id"] + ".wav")
            samples = audio.squeeze()
            sf.write(str(path), samples, tts.sample_rate)
            # Derive the duration from what was actually written. The library's
            # reported duration is not a plain scalar in every version, and the
            # file's own frame count is the authoritative value anyway.
            frames = int(samples.shape[0]) if hasattr(samples, "shape") else int(len(samples))
            entry.update(
                {
                    "ok": True,
                    "wavPath": str(path),
                    "sampleRate": int(tts.sample_rate),
                    "frames": frames,
                    "seconds": frames / float(tts.sample_rate),
                    "reported": str(duration),
                }
            )
        except Exception as exc:  # noqa: BLE001 - reported per item, never fatal
            entry.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            traceback.print_exc(file=sys.stderr)
        results.append(entry)

    (out_dir / "result.json").write_text(json.dumps({"results": results}, indent=2) + "\n")
    failures = [entry for entry in results if not entry.get("ok")]
    print(
        json.dumps(
            {
                "items": len(results),
                "failures": len(failures),
                "failedIds": [entry["id"] for entry in failures],
            }
        )
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
