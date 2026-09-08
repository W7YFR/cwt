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


def run_live(device: int, timing: core.Timing, rate: int = capture.RATE,
             tone: float | None = None, max_seconds: float = 30.0,
             on_update=None):
    """Capture and live-decode until Enter, EOF, or `max_seconds`.

    Returns (samples, tone) — the full captured signal and the tone used — so the
    caller can save it and run the authoritative batch decode/grade.
    """
    proc = capture.open_stream(device, rate)
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
                if detected is None and sig.size >= _MIN_TONE_SECONDS * rate:
                    try:
                        detected = core.detect_tone(sig, rate)
                    except Exception:
                        detected = None
                if detected:
                    on_update(core.quick_decode(sig, rate, detected, timing))
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
    return sig, detected
