"""Generate synthetic CW audio for testing and demos."""

from __future__ import annotations

import re

import numpy as np

from .morse import CHAR_TO_MORSE

_TOKEN = re.compile(r"<[A-Z]+>|.")


def _symbols(word: str):
    """Split a word into keyable symbols, treating <XX> as one prosign."""
    return [t for t in _TOKEN.findall(word) if t in CHAR_TO_MORSE]


def generate(text: str, wpm: float = 20.0, farnsworth_wpm: float | None = None,
             tone: float = 600.0, rate: int = 8000, noise: float = 0.0,
             ramp_ms: float = 5.0) -> np.ndarray:
    """Render `text` as a CW audio waveform.

    wpm            : character (element) speed.
    farnsworth_wpm : overall speed; if < wpm, inter-character/word gaps stretch.
    noise          : std-dev of additive white gaussian noise (0 = clean).
    """
    unit = 1.2 / wpm  # dit length, seconds
    if farnsworth_wpm and farnsworth_wpm < wpm:
        # KE3Z: distribute extra spacing time Ta across the 19 spacing units.
        ta = 60.0 / farnsworth_wpm - 37.2 / wpm  # seconds per PARIS word
        fw_unit = ta / 19.0
        char_gap = 3 * fw_unit
        word_gap = 7 * fw_unit
    else:
        char_gap = 3 * unit
        word_gap = 7 * unit

    # Build an on/off envelope timeline in samples.
    on = []   # list of (is_on, duration_sec)
    words = text.upper().split(" ")
    for wi, word in enumerate(words):
        if wi > 0:
            on.append((False, word_gap))
        letters = _symbols(word)
        for li, ch in enumerate(letters):
            if li > 0:
                on.append((False, char_gap))
            pattern = CHAR_TO_MORSE[ch]
            for ei, el in enumerate(pattern):
                if ei > 0:
                    on.append((False, unit))            # intra-char gap
                on.append((True, unit if el == "." else 3 * unit))

    # Leading/trailing silence.
    on = [(False, 0.1)] + on + [(False, 0.1)]

    total = sum(d for _, d in on)
    n = int(total * rate)
    env = np.zeros(n)
    t_idx = 0
    for is_on, dur in on:
        span = int(dur * rate)
        if is_on and span > 0:
            env[t_idx : t_idx + span] = 1.0
        t_idx += span

    # Raised-cosine edges to avoid key clicks.
    ramp = int(ramp_ms / 1000.0 * rate)
    if ramp > 1:
        edges = np.diff(np.concatenate(([0], env, [0])))
        rise = np.flatnonzero(edges > 0)
        fall = np.flatnonzero(edges < 0)
        shape = (1 - np.cos(np.linspace(0, np.pi, ramp))) / 2
        for r in rise:
            seg = env[r : r + ramp]
            env[r : r + len(seg)] = shape[: len(seg)]
        for f in fall:
            s = max(f - ramp, 0)
            seg = env[s:f]
            env[s:f] = shape[: len(seg)][::-1] if len(seg) else seg

    t = np.arange(n) / rate
    sig = env * np.sin(2 * np.pi * tone * t)
    if noise > 0:
        rng = np.random.default_rng(1234)
        sig = sig + rng.normal(0, noise, n)
    peak = np.max(np.abs(sig)) or 1.0
    return (sig / peak).astype(np.float32)


def write_wav(path: str, sig: np.ndarray, rate: int = 8000) -> None:
    from scipy.io import wavfile

    # Round rather than truncate, and scale by 32768, so audio that came from
    # int16 (a capture) survives the round trip exactly.
    pcm = np.clip(np.round(np.asarray(sig, dtype=np.float64) * 32768.0),
                  -32768, 32767).astype(np.int16)
    wavfile.write(path, rate, pcm)
