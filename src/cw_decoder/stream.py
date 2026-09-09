"""Live (real-time) CW decode.

Streams raw PCM from ffmpeg into a growing buffer and periodically re-decodes it
with a fixed target timing, so characters appear on screen shortly after you key
them. The full, accurate decode + grading is done once at the end on the complete
buffer (by the caller), so the live view is feedback and the final report is the
authority. This reuses the batch pipeline rather than a separate causal decoder.
"""

from __future__ import annotations

import os
import select
import sys
import time

import numpy as np

from . import capture, core

TICK_SECONDS = 0.4          # how often the live line is refreshed
_MIN_TONE_SECONDS = 0.8     # audio needed before attempting tone detection


def _to_mono(sig: np.ndarray, channels: int) -> np.ndarray:
    """Fold interleaved frames to mono. A no-op for a mono device."""
    if channels <= 1 or sig.size < channels:
        return sig
    usable = sig.size // channels * channels
    return sig[:usable].reshape(-1, channels).mean(axis=1).astype(np.float32)


def _for_dsp(sig: np.ndarray, rate: int, dsp_rate: int) -> np.ndarray:
    """Decimate the captured audio down to the decode rate.

    Capture runs at a real audio rate for fidelity, but the preview re-decodes
    the whole buffer several times a second, and the envelope detection costs
    ~5x more at 44.1 kHz than at 8 kHz. Decimating the accumulated buffer first
    is far cheaper than that (~20 ms for two minutes of audio) and avoids the
    chunk-boundary transients that per-chunk resampling would inject.
    """
    if rate == dsp_rate or sig.size == 0:
        return sig
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(int(rate), int(dsp_rate))
    return resample_poly(sig, dsp_rate // g, rate // g).astype(np.float32)


def run_live(device: int, timing: core.Timing, rate: int | None = None,
             tone: float | None = None,
             max_seconds: float = capture.DEFAULT_MAX_SECONDS,
             on_update=None, dsp_rate: int = core.TARGET_RATE):
    """Capture and live-decode until Enter, EOF, or `max_seconds`.

    Returns (samples, tone, rate) — the full captured signal, the tone used,
    and the rate actually captured at — so the caller can save it and run the
    authoritative batch decode/grade. `rate=None` captures at the device's
    native rate (no resampling). The live preview decodes a decimated copy at
    `dsp_rate`; the returned audio is always full-rate.
    """
    proc, rate, channels = capture.open_stream(device, rate)
    watch = [proc.stdout]
    interactive = sys.stdin.isatty()
    if interactive:
        watch.append(sys.stdin)

    chunks: list[np.ndarray] = []
    detected = tone
    start = time.monotonic()
    last_tick = 0.0
    stop = False
    try:
        while not stop:
            ready, _, _ = select.select(watch, [], [], 0.2)
            if proc.stdout in ready:
                data = proc.stdout.read1(65536)
                if not data:
                    stop = True
                else:
                    chunks.append(np.frombuffer(data, dtype="<f4"))
            if interactive and sys.stdin in ready:
                try:
                    os.read(sys.stdin.fileno(), 4096)
                except OSError:
                    pass
                stop = True

            now = time.monotonic() - start
            if now >= max_seconds:
                stop = True
            if on_update is not None and now - last_tick >= TICK_SECONDS:
                last_tick = now
                sig = np.concatenate(chunks) if chunks else np.zeros(0, "float32")
                if sig.size < _MIN_TONE_SECONDS * rate * channels \
                        and detected is None:
                    continue
                dsp = _for_dsp(_to_mono(sig, channels), rate, dsp_rate)
                if detected is None:
                    try:
                        detected = core.detect_tone(dsp, dsp_rate)
                    except Exception:
                        detected = None
                if detected:
                    on_update(core.quick_decode(dsp, dsp_rate, detected, timing))
    finally:
        capture._quit_ffmpeg(proc)
        try:
            while True:                        # keep the remaining tail audio
                data = proc.stdout.read1(65536)
                if not data:
                    break
                chunks.append(np.frombuffer(data, dtype="<f4"))
        except (OSError, ValueError):
            pass
        proc.wait()

    sig = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    # The device streams interleaved at its own channel count; fold to mono
    # here rather than making ffmpeg do it mid-capture.
    return _to_mono(sig, channels), detected, rate
