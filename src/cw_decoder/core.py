"""Core CW decoding pipeline: load audio -> envelope -> timing -> text.

The pipeline is:
  1. load_audio   : any format (via ffmpeg) or WAV directly -> mono float @ target rate
  2. detect_tone  : find the CW carrier frequency via FFT
  3. envelope     : bandpass around the tone + Hilbert magnitude -> key on/off power
  4. binarize     : adaptive (Otsu) threshold -> on/off timeline
  5. run_length   : (state, duration) segments, with spike debounce
  6. estimate_timing : cluster marks (dit/dah) and gaps (element/char/word);
                       derive character WPM and Farnsworth overall WPM
  7. decode       : map elements through the Morse table -> text
"""

from __future__ import annotations

import difflib
import re
import shutil
import subprocess
from dataclasses import dataclass, field

import numpy as np
from scipy.signal import butter, filtfilt, hilbert

from .morse import decode_pattern

TARGET_RATE = 8000  # Hz; plenty for a sub-1 kHz CW tone.


# --------------------------------------------------------------------------- #
# Text comparison against an intended message
# --------------------------------------------------------------------------- #
_SYMBOL = re.compile(r"<[A-Z]+>|.")


def _tokenize(text: str) -> list:
    """Split text into comparable symbols: prosigns (<..>) are one token, spaces
    are single tokens (so word-spacing errors show up), case is normalized."""
    collapsed = " ".join(text.upper().split())
    return _SYMBOL.findall(collapsed)


@dataclass
class Comparison:
    expected: str
    decoded: str
    accuracy: float          # matched symbols / expected symbols
    n_expected: int
    substitutions: int
    insertions: int          # extra symbols the decode had (not in target)
    deletions: int           # target symbols the decode missed
    diff: str                # inline annotated diff


def _align(a: list, b: list):
    """Levenshtein alignment (minimal edits) of token lists a -> b.

    Returns a list of (op, a_tok, b_tok) with op in equal/sub/del/ins. Unlike
    difflib's ratcheting match, this is optimal, which matters for the repetitive
    text common in CW practice (e.g. a call sent five times)."""
    n, m = len(a), len(b)
    if n * m > 4_000_000:  # pathologically long; fall back to difflib opcodes
        ops = []
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
                a=a, b=b, autojunk=False).get_opcodes():
            if tag == "equal":
                ops += [("equal", a[k], a[k]) for k in range(i1, i2)]
            elif tag == "replace":
                ops += [("sub", a[i1 + k] if i1 + k < i2 else None,
                         b[j1 + k] if j1 + k < j2 else None)
                        for k in range(max(i2 - i1, j2 - j1))]
            elif tag == "delete":
                ops += [("del", a[k], None) for k in range(i1, i2)]
            else:
                ops += [("ins", None, b[k]) for k in range(j1, j2)]
        return ops

    d = np.zeros((n + 1, m + 1), dtype=np.int32)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        ai = a[i - 1]
        for j in range(1, m + 1):
            sub = d[i - 1, j - 1] + (0 if ai == b[j - 1] else 1)
            d[i, j] = min(sub, d[i - 1, j] + 1, d[i, j - 1] + 1)

    i, j, ops = n, m, []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (
                0 if a[i - 1] == b[j - 1] else 1):
            ops.append(("equal" if a[i - 1] == b[j - 1] else "sub",
                        a[i - 1], b[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and d[i, j] == d[i - 1, j] + 1:
            ops.append(("del", a[i - 1], None))
            i -= 1
        else:
            ops.append(("ins", None, b[j - 1]))
            j -= 1
    ops.reverse()
    return ops


def compare_text(expected: str, decoded: str) -> Comparison:
    """Align the decoded text against the intended text and score accuracy."""
    exp, got = _tokenize(expected), _tokenize(decoded)
    ops = _align(exp, got)

    matches = subs = ins = dels = 0
    # Group consecutive same-op runs into a compact annotated diff.
    out, run_op, run_e, run_g = [], None, [], []

    def flush_run():
        if run_op is None:
            return
        e, g = "".join(run_e), "".join(run_g)
        if run_op == "equal":
            out.append(e)
        elif run_op == "sub":
            out.append(f"[{e}→{g}]")
        elif run_op == "del":
            out.append(f"[-{e}]")
        elif run_op == "ins":
            out.append(f"[+{g}]")

    for op, e, g in ops:
        if op == "equal":
            matches += 1
        elif op == "sub":
            subs += 1
        elif op == "del":
            dels += 1
        else:
            ins += 1
        if op != run_op:
            flush_run()
            run_op, run_e[:], run_g[:] = op, [], []
        if e is not None:
            run_e.append(e)
        if g is not None:
            run_g.append(g)
    flush_run()

    accuracy = matches / len(exp) if exp else 1.0
    return Comparison(
        expected=" ".join(expected.upper().split()),
        decoded=" ".join(decoded.upper().split()),
        accuracy=accuracy, n_expected=len(exp),
        substitutions=subs, insertions=ins, deletions=dels,
        diff="".join(out),
    )


# --------------------------------------------------------------------------- #
# 1. Audio loading
# --------------------------------------------------------------------------- #
def load_audio(path: str, target_rate: int = TARGET_RATE) -> np.ndarray:
    """Load `path` as a mono float32 signal at `target_rate`.

    WAV files are read directly with scipy; anything else is decoded via ffmpeg,
    so mp3/flac/m4a/aiff/ogg/opus all work as long as ffmpeg is installed.
    """
    if path.lower().endswith(".wav"):
        try:
            return _load_wav_scipy(path, target_rate)
        except Exception:
            pass  # fall through to ffmpeg (e.g. exotic WAV codecs)
    return _load_ffmpeg(path, target_rate)


def _load_wav_scipy(path: str, target_rate: int) -> np.ndarray:
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    rate, data = wavfile.read(path)
    data = np.asarray(data)
    if data.ndim > 1:          # stereo -> mono
        data = data.mean(axis=1)
    data = data.astype(np.float64)
    # Normalize integer PCM to [-1, 1].
    if np.issubdtype(np.asarray(data).dtype, np.floating) is False:
        pass
    peak = np.max(np.abs(data)) or 1.0
    data = data / peak
    if rate != target_rate:
        from math import gcd
        g = gcd(int(rate), int(target_rate))
        data = resample_poly(data, target_rate // g, rate // g)
    return data.astype(np.float32)


def _load_ffmpeg(path: str, target_rate: int) -> np.ndarray:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg not found on PATH and input is not a .wav file. "
            "Install ffmpeg or provide a WAV file."
        )
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error",
        "-i", path,
        "-ac", "1", "-ar", str(target_rate),
        "-f", "f32le", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{proc.stderr.decode(errors='replace')}")
    data = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)
    if data.size == 0:
        raise RuntimeError("ffmpeg produced no audio samples.")
    peak = float(np.max(np.abs(data))) or 1.0
    return data / peak


# --------------------------------------------------------------------------- #
# 2. Tone detection
# --------------------------------------------------------------------------- #
def detect_tone(sig: np.ndarray, rate: int, fmin: float = 200.0,
                fmax: float = 1500.0) -> float:
    """Return the dominant frequency (Hz) within [fmin, fmax]."""
    n = sig.size
    # Use a magnitude spectrum over the whole clip; CW energy piles up at f0.
    window = np.hanning(n) if n < 2_000_000 else 1.0
    spec = np.abs(np.fft.rfft(sig * window))
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    band = (freqs >= fmin) & (freqs <= fmax)
    if not np.any(band):
        band = slice(None)
    idx = np.argmax(spec[band])
    return float(freqs[band][idx])


# --------------------------------------------------------------------------- #
# 3. Envelope
# --------------------------------------------------------------------------- #
def envelope(sig: np.ndarray, rate: int, tone: float,
             bw: float = 200.0) -> np.ndarray:
    """Bandpass around `tone`, then take the smoothed analytic-signal magnitude."""
    low = max(tone - bw, 20.0)
    high = min(tone + bw, rate / 2.0 - 20.0)
    b, a = butter(4, [low / (rate / 2), high / (rate / 2)], btype="band")
    filtered = filtfilt(b, a, sig)
    env = np.abs(hilbert(filtered))
    # Smooth with a short moving average (~5 ms) to remove ripple.
    win = max(1, int(0.005 * rate))
    kernel = np.ones(win) / win
    env = np.convolve(env, kernel, mode="same")
    return env


# --------------------------------------------------------------------------- #
# 4. Adaptive threshold (Otsu)
# --------------------------------------------------------------------------- #
def otsu_threshold(env: np.ndarray) -> float:
    """Otsu's method on the envelope amplitude histogram."""
    x = env[np.isfinite(env)]
    if x.size == 0:
        return 0.0
    hist, edges = np.histogram(x, bins=256)
    centers = (edges[:-1] + edges[1:]) / 2
    total = hist.sum()
    if total == 0:
        return float(x.mean())
    w = np.cumsum(hist)
    mu = np.cumsum(hist * centers)
    mu_t = mu[-1]
    w = w.astype(np.float64)
    denom = w * (total - w)
    denom[denom == 0] = np.nan
    between = (mu_t * w - mu) ** 2 / denom
    k = np.nanargmax(between)
    return float(centers[k])


def keying_threshold(env: np.ndarray) -> float:
    """Threshold for key-down detection.

    Otsu finds the boundary between the noise/off class and the tone/on class,
    but that boundary sits high on the on-plateau and biases every mark short.
    We instead take the midpoint of the two class *means*, which lands near the
    50% amplitude crossing — unbiased for raised-cosine keying and robust to
    noise (the off class mean tracks the noise floor).
    """
    x = env[np.isfinite(env)]
    if x.size == 0:
        return 0.0
    boundary = otsu_threshold(x)
    off = x[x <= boundary]
    on = x[x > boundary]
    if off.size == 0 or on.size == 0:
        return boundary
    return float((off.mean() + on.mean()) / 2.0)


# --------------------------------------------------------------------------- #
# 5. Run-length encode + debounce
# --------------------------------------------------------------------------- #
def run_lengths(binary: np.ndarray, rate: int):
    """Return list of (state:int(0/1), duration_seconds:float)."""
    if binary.size == 0:
        return []
    change = np.diff(binary.astype(np.int8))
    idx = np.flatnonzero(change) + 1
    bounds = np.concatenate(([0], idx, [binary.size]))
    segs = []
    for start, end in zip(bounds[:-1], bounds[1:]):
        segs.append((int(binary[start]), (end - start) / rate))
    return segs


def debounce(segs, min_dur: float):
    """Drop runs shorter than `min_dur` by merging them into their neighbours."""
    if not segs:
        return segs
    # Repeatedly remove the shortest sub-threshold segment and merge across.
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, (state, dur) in enumerate(segs):
            if dur < min_dur:
                # Merge this segment away: combine surrounding same-state runs.
                left = segs[i - 1] if i > 0 else None
                right = segs[i + 1] if i + 1 < len(segs) else None
                if left and right:
                    merged = (left[0], left[1] + dur + right[1])
                    segs = segs[: i - 1] + [merged] + segs[i + 2 :]
                elif left:
                    segs = segs[: i - 1] + [(left[0], left[1] + dur)]
                elif right:
                    segs = [(right[0], right[1] + dur)] + segs[i + 2 :]
                else:
                    segs = segs[:i] + segs[i + 1 :]
                changed = True
                break
    return segs


# --------------------------------------------------------------------------- #
# 6. Timing estimation
# --------------------------------------------------------------------------- #
def _kmeans_1d(values, k, iters=50):
    """Tiny deterministic 1-D k-means. Returns sorted cluster centers."""
    values = np.asarray(values, dtype=np.float64)
    if values.size == 0:
        return np.array([])
    k = min(k, values.size)
    # Initialize centers spread across the sorted range (deterministic).
    lo, hi = values.min(), values.max()
    if lo == hi:
        return np.array([lo])
    centers = np.linspace(lo, hi, k)
    for _ in range(iters):
        d = np.abs(values[:, None] - centers[None, :])
        labels = d.argmin(axis=1)
        new = np.array([
            values[labels == j].mean() if np.any(labels == j) else centers[j]
            for j in range(k)
        ])
        if np.allclose(new, centers):
            break
        centers = new
    return np.sort(centers)


def _dominant_gap(inter) -> float:
    """Estimate the character-gap length from inter-character/word/pause gaps.

    Character gaps usually outnumber word gaps, which outnumber inter-transmission
    pauses, so the character gap is normally the *most populous* cluster — not
    simply the shortest, since a few spurious short gaps can form a small low
    cluster (as in heavy-Farnsworth recordings). But when the text is made of
    very short words the word gaps can outnumber the character gaps, so if the
    lowest cluster holds a substantial share of the gaps we treat *it* as the
    character gap. We cluster in log space so long pauses don't distort the means.
    """
    inter = np.asarray(inter, dtype=np.float64)
    if inter.size <= 2:
        return float(np.median(inter))
    log = np.log(inter)
    k = 3 if inter.size >= 6 else 2
    centers = _kmeans_1d(log, k)
    labels = np.abs(log[:, None] - centers[None, :]).argmin(axis=1)
    counts = np.array([np.sum(labels == j) for j in range(centers.size)])

    # Scan clusters shortest-first and take the first "real" one: the character
    # gap is the shortest gap class that occurs often. This skips both a handful
    # of spurious short gaps (heavy-Farnsworth recordings) and a couple of
    # intra-character gaps that leaked past the element/character split, while
    # still preferring character gaps over word gaps when words are short.
    bar = max(3, 0.2 * inter.size)
    chosen = int(counts.argmax())            # fallback: most populous
    for j in np.argsort(centers):            # low -> high
        if counts[j] >= bar:
            chosen = int(j)
            break
    members = inter[labels == chosen]
    return float(np.median(members)) if members.size else float(np.exp(centers[chosen]))


@dataclass
class Timing:
    unit_sec: float                 # dit length in seconds
    char_wpm: float                 # character speed (element speed)
    farnsworth_wpm: float           # overall speed (<= char_wpm)
    dit_dah_split: float            # mark threshold (sec)
    element_char_split: float       # gap: element vs character (sec)
    char_word_split: float          # gap: character vs word (sec)
    char_gap_sec: float = 0.0       # nominal inter-character gap (sec)
    word_gap_sec: float = 0.0       # nominal inter-word gap (sec)
    notes: list = field(default_factory=list)


def target_timing(char_wpm: float, farnsworth_wpm: float | None = None) -> Timing:
    """Build the *ideal* timing for a target character/Farnsworth speed.

    Uses the standard PARIS + KE3Z Farnsworth model, so the resulting thresholds
    and nominal gap lengths are exactly what a machine sender would produce.
    """
    if farnsworth_wpm is None:
        farnsworth_wpm = char_wpm
    farnsworth_wpm = min(farnsworth_wpm, char_wpm)
    unit = 1.2 / char_wpm
    # Farnsworth delay unit: distribute the extra spacing over PARIS's 19 spacing
    # units. Ta = 60/S - 37.2/C seconds per word; degenerates to 1 unit when S=C.
    ta = 60.0 / farnsworth_wpm - 37.2 / char_wpm
    fw_unit = max(ta / 19.0, unit)
    char_gap = 3.0 * fw_unit
    word_gap = 7.0 * fw_unit
    return Timing(
        unit_sec=unit,
        char_wpm=char_wpm,
        farnsworth_wpm=farnsworth_wpm,
        dit_dah_split=2.0 * unit,
        element_char_split=2.0 * unit,
        char_word_split=5.0 * fw_unit,
        char_gap_sec=char_gap,
        word_gap_sec=word_gap,
    )


def estimate_timing(segs) -> Timing:
    """Derive dit length, speeds, and classification thresholds from segments."""
    marks = [d for s, d in segs if s == 1]
    gaps = [d for s, d in segs if s == 0]
    if not marks:
        raise RuntimeError("No keyed tone detected — check tone frequency / input.")

    # --- Marks: cluster into dit and dah. --------------------------------- #
    mark_centers = _kmeans_1d(marks, 2)
    if mark_centers.size == 2:
        dit_c, dah_c = mark_centers
        # Combine both estimates of the unit (dah ~ 3 units).
        unit = (dit_c + dah_c / 3.0) / 2.0
        dit_dah_split = (dit_c + dah_c) / 2.0
    else:
        unit = float(mark_centers[0])
        dit_dah_split = unit * 2.0

    char_wpm = 1.2 / unit

    # --- Gaps: element (~unit) vs character vs word. ---------------------- #
    # Element (intra-character) gaps stay ~1 unit even under Farnsworth, so we
    # can split element-vs-character at a fixed 2 units. Character and word gaps
    # both stretch under Farnsworth but keep the standard 3:7 ratio, so once we
    # know the character-gap length the word split is char_gap * 5/3.
    element_char_split = unit * 2.0
    inter = [g for g in gaps if g >= element_char_split]  # char + word + pauses

    char_gap = unit * 3.0
    if inter:
        char_gap = _dominant_gap(inter)
    word_gap = char_gap * (7.0 / 3.0)
    char_word_split = char_gap * (5.0 / 3.0)

    # --- Farnsworth overall speed. ---------------------------------------- #
    # KE3Z model: with element speed C and overall speed S, the inter-character
    # gap Tc = 3*Ta/19 where Ta = 60/S - 37.2/C (seconds per PARIS word).
    # Invert using the measured character gap: Ta = 19*char_gap/3.
    ta = 19.0 * char_gap / 3.0
    denom = ta + 37.2 / char_wpm
    farns = 60.0 / denom if denom > 0 else char_wpm
    farns = min(farns, char_wpm)  # overall can't exceed character speed

    notes = []
    if farns < char_wpm * 0.95:
        notes.append(
            f"Farnsworth spacing detected (~{char_wpm:.0f} wpm characters, "
            f"~{farns:.0f} wpm overall)."
        )
    return Timing(
        unit_sec=unit,
        char_wpm=char_wpm,
        farnsworth_wpm=farns,
        dit_dah_split=dit_dah_split,
        element_char_split=element_char_split,
        char_word_split=char_word_split,
        char_gap_sec=char_gap,
        word_gap_sec=word_gap,
        notes=notes,
    )


# --------------------------------------------------------------------------- #
# 7. Decode
# --------------------------------------------------------------------------- #
def decode_segments(segs, timing: Timing) -> str:
    """Turn (state,duration) segments + timing thresholds into text."""
    text = []
    current = []  # accumulating dit/dah for the current character

    def flush_char():
        if current:
            text.append(decode_pattern("".join(current)))
            current.clear()

    # Skip leading/trailing silence when iterating.
    for i, (state, dur) in enumerate(segs):
        if state == 1:  # mark
            current.append("." if dur < timing.dit_dah_split else "-")
        else:  # gap
            # Ignore the very first/last silence.
            is_edge = i == 0 or i == len(segs) - 1
            if is_edge:
                continue
            if dur < timing.element_char_split:
                pass  # intra-character gap
            elif dur < timing.char_word_split:
                flush_char()
            else:
                flush_char()
                text.append(" ")
    flush_char()
    return "".join(text)


# --------------------------------------------------------------------------- #
# Analysis against a target
# --------------------------------------------------------------------------- #
def _decode_and_events(segs, timing: Timing):
    """Decode against `timing` and record every mark/gap as a timed event.

    Returns (text, events) where each event is
    (time_sec, kind, value_units, target_units, context).
    """
    u = timing.unit_sec
    char_gap_u = (timing.char_gap_sec / u) if timing.char_gap_sec else 3.0
    word_gap_u = (timing.word_gap_sec / u) if timing.word_gap_sec else 7.0

    text, current, events = [], [], []
    t = 0.0
    n = len(segs)

    def flush():
        if current:
            text.append(decode_pattern("".join(current)))
            current.clear()

    def tail():
        return "".join(text)[-10:].strip()

    for i, (state, dur) in enumerate(segs):
        start, t = t, t + dur
        vu = dur / u
        if state == 1:
            is_dit = dur < timing.dit_dah_split
            current.append("." if is_dit else "-")
            events.append((start, "dit" if is_dit else "dah",
                           vu, 1.0 if is_dit else 3.0, ""))
        else:
            if i == 0 or i == n - 1:
                continue
            if dur < timing.element_char_split:
                events.append((start, "element-gap", vu, 1.0, ""))
            elif dur < timing.char_word_split:
                flush()
                events.append((start, "char-gap", vu, char_gap_u, tail()))
            else:
                flush()
                events.append((start, "word-gap", vu, word_gap_u, tail()))
                text.append(" ")
    flush()
    return "".join(text), events


@dataclass
class ClassStat:
    name: str
    n: int
    mean_units: float
    std_units: float
    target_units: float


@dataclass
class Deviation:
    time_sec: float
    kind: str
    value_units: float
    target_units: float
    context: str


@dataclass
class Analysis:
    ref: Timing                 # the target timing decoded against
    measured: Timing            # auto-estimated timing, for headline comparison
    stats: list                 # list[ClassStat]
    deviations: list            # list[Deviation], worst first
    within_tol_frac: float      # fraction of elements/gaps within tolerance
    tolerance: float            # relative tolerance used (e.g. 0.30)
    n_pauses: int = 0           # inter-transmission pauses excluded from grading


_CLASS_ORDER = ["dit", "dah", "element-gap", "char-gap", "word-gap"]


def analyze(segs, ref: Timing, measured: Timing, tolerance: float = 0.30) -> Analysis:
    """Compare the actual keying against the ideal `ref` timing.

    Word gaps far longer than the target (the sender pausing between repetitions
    or transmissions) are treated as intentional pauses, not spacing errors, so
    they're excluded from the grading and counted separately.
    """
    _, events = _decode_and_events(segs, ref)

    # Reclassify very long word gaps as intentional pauses.
    pause_floor = 2.0 * (ref.word_gap_sec / ref.unit_sec if ref.word_gap_sec else 7.0)
    n_pauses = 0
    kept = []
    for ev in events:
        start, kind, vu, tu, ctx = ev
        if kind == "word-gap" and vu > pause_floor:
            n_pauses += 1
            continue
        kept.append(ev)
    events = kept

    groups = {}
    for start, kind, vu, tu, _ctx in events:
        g = groups.setdefault(kind, {"vals": [], "target": tu})
        g["vals"].append(vu)

    stats = []
    for kind in _CLASS_ORDER:
        if kind in groups:
            vals = np.asarray(groups[kind]["vals"])
            stats.append(ClassStat(kind, vals.size, float(vals.mean()),
                                    float(vals.std()), groups[kind]["target"]))

    devs, within, total = [], 0, 0
    for start, kind, vu, tu, ctx in events:
        if tu <= 0:
            continue
        total += 1
        rel = abs(vu - tu) / tu
        if rel <= tolerance:
            within += 1
        # Flag a deviation only if it's both proportionally and absolutely off,
        # so 1-unit elements aren't flagged for tiny wobble.
        elif abs(vu - tu) >= 0.4:
            devs.append(Deviation(start, kind, vu, tu, ctx))

    devs.sort(key=lambda d: abs(d.value_units - d.target_units) / d.target_units,
              reverse=True)
    frac = within / total if total else 1.0
    return Analysis(ref, measured, stats, devs[:12], frac, tolerance, n_pauses)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
@dataclass
class Result:
    text: str
    tone_hz: float
    timing: Timing              # measured (auto-estimated) timing
    rate: int
    analysis: Analysis | None = None  # present when a target was supplied


def decode_file(path: str, tone: float | None = None,
                target_rate: int = TARGET_RATE,
                bandwidth: float = 200.0,
                target_wpm: float | None = None,
                target_farnsworth: float | None = None,
                tolerance: float = 0.30) -> Result:
    sig = load_audio(path, target_rate)
    tone_hz = tone if tone is not None else detect_tone(sig, target_rate)
    env = envelope(sig, target_rate, tone_hz, bw=bandwidth)
    thr = keying_threshold(env)
    binary = env > thr
    segs = run_lengths(binary, target_rate)

    # First-pass unit estimate for debounce, then re-segment. Use a low
    # percentile of mark lengths (~ the dit) rather than the median, which can
    # land on a dah and wrongly delete real dits.
    marks = [d for s, d in segs if s == 1]
    if marks:
        rough_unit = float(np.percentile(marks, 20))
        segs = debounce(segs, min_dur=0.35 * rough_unit)

    measured = estimate_timing(segs)
    analysis = None
    if target_wpm is not None:
        # Decode against the target's ideal timing and grade the sending.
        ref = target_timing(target_wpm, target_farnsworth)
        text = decode_segments(segs, ref)
        analysis = analyze(segs, ref, measured, tolerance=tolerance)
    else:
        text = decode_segments(segs, measured)
    return Result(text=text, tone_hz=tone_hz, timing=measured, rate=target_rate,
                  analysis=analysis)
