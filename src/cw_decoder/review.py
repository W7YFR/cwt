"""Build the payload behind the `--web-review` canvas.

The page is a pure function of this payload, and the payload is deliberately
*raw*: segments are shipped in seconds rather than pre-divided into target
units, and the expected text is shipped as text. That lets the browser re-derive
the whole grading — target speed, Farnsworth spacing, tolerance, even a
different intended message — from the same bytes, with no server round-trip.
The only thing it can't change client-side is the DSP that produced the
segments (tone, bandwidth, threshold, debounce).

Keeping the numbers raw is also what makes a future `--web-serve` a drop-in:
the page would fetch this same object from an endpoint instead of reading it
inline.
"""

from __future__ import annotations

import base64
import io
import shutil
import subprocess
from datetime import datetime, timezone

import numpy as np

from . import core

PAYLOAD_VERSION = 1

# Ceiling on the embedded playback rate — a backstop against an absurd source,
# not a quality decision. Set above every common device rate (44.1/48/96 kHz)
# on purpose: resampling for playback would re-introduce exactly the artifact
# that forcing a capture rate used to cause. Use --capture-rate to record
# smaller if the page size matters.
PLAYBACK_RATE_CAP = 96000


def encode_wav(sig: np.ndarray, rate: int) -> str:
    """Encode a normalized mono signal as a base64 WAV data URI.

    The signal is the decoder's own 8 kHz mono view of the audio, not the
    original file, so the waveform the browser plays lines up sample-for-sample
    with the timeline drawn over it.
    """
    from scipy.io import wavfile

    buf = io.BytesIO()
    # Round (not truncate) and scale by 32768 so a signal that came from int16
    # round-trips exactly instead of drifting a bit toward zero.
    pcm = np.clip(np.round(np.asarray(sig, dtype=np.float64) * 32768.0),
                  -32768, 32767).astype(np.int16)
    wavfile.write(buf, rate, pcm)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:audio/wav;base64,{b64}"


def _source_rate(path: str) -> int | None:
    """The sample rate of `path`, or None if it can't be read cheaply."""
    if path.lower().endswith(".wav"):
        import wave
        try:
            with wave.open(path, "rb") as w:
                return w.getframerate()
        except Exception:
            return None
    if shutil.which("ffprobe") is None:
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate", "-of",
             "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip()) or None
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def playback_audio(res: core.Result, path: str | None = None):
    """Return (signal, rate) to embed for playback.

    The decoder works at 8 kHz — ample to *decode* a sub-1 kHz tone, but thin
    to listen back to. When the source is higher-rate, re-read it at its own
    rate so the page plays what was actually recorded. Block timings are in
    seconds, so the timeline lines up at any rate.
    """
    if res.signal is None:
        raise ValueError("review payload needs the audio; "
                         "decode with keep_signal=True")
    # res.signal came from the decode, which peak-normalizes; re-read the
    # source unnormalized so playback and the download are the recording at the
    # level it was made, not a ~30 dB boost of it.
    if not path:
        return res.signal, res.rate
    rate = min(_source_rate(path) or res.rate, PLAYBACK_RATE_CAP)
    rate = max(rate, res.rate)
    try:
        return core.load_audio(path, rate, normalize=False), rate
    except Exception:
        return res.signal, res.rate      # fall back rather than fail the page


def build_payload(res: core.Result, source: str,
                  expected: str | None = None,
                  expected_source: str | None = None,
                  tolerance: float = 0.30,
                  audio_path: str | None = None) -> dict:
    """Assemble the review payload from a decode result.

    `res` must carry `segments` and `signal` (use `keep_signal=True` on
    `decode_file`). When no intended text is known, the target track falls back
    to the decoded text: character grading is meaningless then, but spacing
    grading — the point of the exercise — still works.
    """
    play, play_rate = playback_audio(res, audio_path)

    t = res.timing
    # Default the target to whatever was graded against, else to the sender's
    # own measured speed — "what you sent, keyed perfectly".
    if res.analysis is not None:
        tgt_char = res.analysis.ref.char_wpm
        tgt_farns = res.analysis.ref.farnsworth_wpm
    else:
        tgt_char = round(t.char_wpm)
        tgt_farns = min(round(t.farnsworth_wpm), tgt_char)

    return {
        "version": PAYLOAD_VERSION,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "tone_hz": round(res.tone_hz, 1),
        "rate": res.rate,               # the rate the segments were measured at
        "audio_rate": play_rate,        # the rate of the embedded playback audio
        # The recording's true peak, kept so the page can pick a listening gain
        # at playback instead of the payload having to bake one into the samples.
        "audio_peak": round(float(np.max(np.abs(play))) if play.size else 0.0, 5),
        "duration_sec": round(res.signal.size / res.rate, 3),
        # (state, seconds); 5 decimals is well under the 8 kHz sample period.
        "segments": [[int(s), round(d, 5)] for s, d in res.segments],
        "expected": (expected or "").strip() or None,
        "expected_source": expected_source,
        "decoded": res.text,
        "target": {"char_wpm": float(tgt_char),
                   "farnsworth_wpm": float(tgt_farns),
                   "explicit": res.analysis is not None},
        "measured": {"char_wpm": round(t.char_wpm, 2),
                     "farnsworth_wpm": round(t.farnsworth_wpm, 2),
                     "unit_ms": round(t.unit_sec * 1000, 2)},
        "tolerance": tolerance,
        "audio": encode_wav(play, play_rate),
    }
