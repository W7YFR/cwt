"""Live (real-time) CW decode.

Periodically re-decodes the growing capture buffer with a fixed target timing,
so characters appear on screen shortly after you key them. The full, accurate
decode + grading is done once at the end on the complete buffer (by the
caller), so the live view is feedback and the final report is the authority.
This reuses the batch pipeline rather than a separate causal decoder.
"""

from __future__ import annotations

import numpy as np

from . import capture, core

TICK_SECONDS = 0.4          # how often the live line is refreshed
_MIN_TONE_SECONDS = 0.8     # audio needed before attempting tone detection


def _for_dsp(sig: np.ndarray, rate: int, dsp_rate: int) -> np.ndarray:
    """Decimate the captured audio down to the decode rate.

    Capture runs at the device's own rate for fidelity, but the preview
    re-decodes the whole buffer several times a second, and the envelope
    detection costs ~5x more at 48 kHz than at 8 kHz. Decimating the
    accumulated buffer first is far cheaper than that (~20 ms for two minutes
    of audio) and avoids the chunk-boundary transients that per-chunk
    resampling would inject.
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
             on_update=None, dsp_rate: int = core.TARGET_RATE,
             backend: str = "auto"):
    """Capture and live-decode until Enter, end of stream, or `max_seconds`.

    Returns (samples, tone, rate, backend, problems) — the full captured mono
    signal at the device's rate — so the caller can save it and run the
    authoritative batch decode/grade. `rate=None` captures at the device's
    native rate (no resampling). The live preview decodes a decimated copy at
    `dsp_rate`; the returned audio is always full-rate.
    """
    state = {"tone": tone, "next_tick": 0.0, "seen": 0}

    def on_block(chunks, cap_rate, channels):
        if on_update is None:
            return
        total = sum(c.size for c in chunks)
        # Tick on captured-sample count rather than wall clock: it's the same
        # cadence without needing a second clock, and it can't run away if the
        # device stalls.
        frames = total // max(channels, 1)
        if frames < state["next_tick"]:
            return
        state["next_tick"] = frames + TICK_SECONDS * cap_rate
        sig = np.concatenate(chunks)
        if frames < _MIN_TONE_SECONDS * cap_rate and state["tone"] is None:
            return
        dsp = _for_dsp(capture.to_mono(sig, channels), cap_rate, dsp_rate)
        if state["tone"] is None:
            try:
                state["tone"] = core.detect_tone(dsp, dsp_rate)
            except Exception:
                state["tone"] = None
        if state["tone"]:
            on_update(core.quick_decode(dsp, dsp_rate, state["tone"], timing))

    sig, cap_rate, backend_used, problems = capture.capture_samples(
        device, rate=rate, max_seconds=max_seconds, backend=backend,
        on_block=on_block)
    return sig, state["tone"], cap_rate, backend_used, problems
