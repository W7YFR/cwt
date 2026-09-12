"""Hand a decoded recording to the browser app.

The CLI does its own DSP — that half of the Python implementation is production
code, not an oracle, and it is what makes `cw-decode` work with no browser open.
Everything from the segments onward lives in exactly one place, in TypeScript,
so the CLI hands over the *segments* and lets the app do the grading. A session
reviewed from the terminal and one recorded in the browser are graded by the
same code, and cannot disagree.

The bundle is deliberately raw — segments in seconds, intended text as text —
so the review can re-grade at any speed, Farnsworth spacing, tolerance or
intended message without going near the audio again.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone

import numpy as np

from . import core

BUNDLE_VERSION = 1
BUNDLE_NAME = "take.json"
AUDIO_NAME = "audio.wav"


def timing_json(t: core.Timing) -> dict:
    """A `Timing`, in the shape app/src/types calls one."""
    return {
        "unitSec": t.unit_sec,
        "charWpm": t.char_wpm,
        "farnsworthWpm": t.farnsworth_wpm,
        "ditDahSplit": t.dit_dah_split,
        "elementCharSplit": t.element_char_split,
        "charWordSplit": t.char_word_split,
        "charGapSec": t.char_gap_sec,
        "wordGapSec": t.word_gap_sec,
        "notes": list(t.notes),
    }


def take_json(res: core.Result, source: str,
              expected: str | None = None,
              expected_source: str | None = None,
              target_wpm: float | None = None,
              target_farnsworth: float | None = None,
              pad_sec: float = core.TRIM_PAD,
              take_id: str | None = None,
              peak: float | None = None) -> dict:
    """Build the `Take` the app reads.

    Field names are camelCase to match the TypeScript interface exactly. That
    is not a style choice: the app validates the shape on load, and a snake_case
    key here would be a take the browser refuses rather than one it
    misinterprets — which is the failure mode worth having.
    """
    t = res.timing
    explicit = target_wpm is not None
    char_wpm = float(target_wpm) if explicit else float(round(t.char_wpm))
    farns = (float(target_farnsworth if target_farnsworth is not None else char_wpm)
             if explicit else float(min(round(t.farnsworth_wpm), char_wpm)))

    stamp = datetime.now(timezone.utc)
    return {
        "id": take_id or stamp.strftime("%Y%m%d%H%M%S") + "-cli",
        "recordedAt": stamp.isoformat(timespec="seconds"),
        "source": source,
        "toneHz": round(res.tone_hz, 1),
        "rate": res.rate,
        "durationSec": round(res.signal.size / res.rate, 3)
                       if res.signal is not None else 0.0,
        "peak": round(float(peak), 5) if peak is not None else 1.0,
        # 5 decimals is well under the sample period at any rate we handle.
        "segments": [[int(s), round(d, 5)] for s, d in res.segments],
        "decoded": res.text,
        "expected": (expected or "").strip() or None,
        "expectedSource": expected_source,
        "measured": timing_json(t),
        "target": {"charWpm": char_wpm, "farnsworthWpm": farns,
                   "explicit": explicit},
        "padSec": round(float(pad_sec), 3),
    }


def write(out_dir: str, res: core.Result, source: str,
          audio_path: str | None = None, **kwargs) -> str:
    """Write a bundle (and its audio) into `out_dir`; returns the JSON path.

    The audio is copied rather than re-encoded when we have the original file,
    so what plays back in the browser is the recording, not a round trip
    through our own decoder.
    """
    os.makedirs(out_dir, exist_ok=True)

    peak = None
    audio_out = os.path.join(out_dir, AUDIO_NAME)
    if audio_path and os.path.exists(audio_path):
        name = AUDIO_NAME
        if not audio_path.lower().endswith(".wav"):
            # Keep the real extension so the browser sniffs the format right.
            name = "audio" + os.path.splitext(audio_path)[1].lower()
            audio_out = os.path.join(out_dir, name)
        shutil.copyfile(audio_path, audio_out)
        try:
            unnormalized = core.load_audio(audio_path, res.rate, normalize=False)
            peak = float(np.max(np.abs(unnormalized))) if unnormalized.size else 0.0
        except Exception:
            peak = None
        audio_name = name
    else:
        if res.signal is None:
            raise ValueError("no audio to bundle; decode with keep_signal=True")
        _write_wav(audio_out, res.signal, res.rate)
        peak = float(np.max(np.abs(res.signal))) if res.signal.size else 0.0
        audio_name = AUDIO_NAME

    payload = {
        "version": BUNDLE_VERSION,
        "audioUrl": audio_name,
        "take": take_json(res, source, peak=peak, **kwargs),
    }
    path = os.path.join(out_dir, BUNDLE_NAME)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    return path


def _write_wav(path: str, sig: np.ndarray, rate: int) -> None:
    """16-bit PCM, the one format every browser decodes without question."""
    import wave

    pcm = np.clip(np.round(np.asarray(sig, dtype=np.float64) * 32767.0),
                  -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())
