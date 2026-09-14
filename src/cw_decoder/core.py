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

from .morse import CHAR_TO_MORSE, canonical_char, decode_pattern

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

    # Matched by what they sound like, not by how they are written: a handful
    # of patterns have two names, and calling that a substitution blames the
    # sender for keying exactly what was asked for. The ops still carry the
    # original spellings — the comparison is normalized, the report is not.
    ka = [canonical_char(t) for t in a]
    kb = [canonical_char(t) for t in b]

    d = np.zeros((n + 1, m + 1), dtype=np.int32)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        ai = ka[i - 1]
        for j in range(1, m + 1):
            sub = d[i - 1, j - 1] + (0 if ai == kb[j - 1] else 1)
            d[i, j] = min(sub, d[i - 1, j] + 1, d[i, j - 1] + 1)

    i, j, ops = n, m, []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (
                0 if ka[i - 1] == kb[j - 1] else 1):
            ops.append(("equal" if ka[i - 1] == kb[j - 1] else "sub",
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
def load_audio(path: str, target_rate: int = TARGET_RATE,
               normalize: bool = True) -> np.ndarray:
    """Load `path` as a mono float32 signal at `target_rate`.

    WAV files are read directly with scipy; anything else is decoded via ffmpeg,
    so mp3/flac/m4a/aiff/ogg/opus all work as long as ffmpeg is installed.

    `normalize` scales the clip so its peak is 1.0. The decoding pipeline wants
    that — the Otsu threshold works on absolute amplitude — but it is a
    ~30 dB boost on a quietly-recorded clip, so anything meant for *listening*
    (or for handing back to the user as a file) must pass normalize=False and
    keep the recording at the level it was made.
    """
    if path.lower().endswith(".wav"):
        try:
            return _load_wav_scipy(path, target_rate, normalize)
        except Exception:
            pass  # fall through to ffmpeg (e.g. exotic WAV codecs)
    return _load_ffmpeg(path, target_rate, normalize)


def _to_unit_scale(data: np.ndarray, dtype) -> np.ndarray:
    """Convert raw PCM to [-1, 1] by the *format's* full scale.

    Deliberately not by the clip's own peak: dividing by the peak would make
    every recording equally loud and throw away how loud it actually was.
    """
    if np.issubdtype(dtype, np.unsignedinteger):      # 8-bit WAV is unsigned
        mid = (float(np.iinfo(dtype).max) + 1.0) / 2.0
        return (data - mid) / mid
    if np.issubdtype(dtype, np.integer):
        return data / float(-np.iinfo(dtype).min)     # 32768 for int16
    return data                                       # already float


def _load_wav_scipy(path: str, target_rate: int,
                    normalize: bool = True) -> np.ndarray:
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    rate, data = wavfile.read(path)
    data = np.asarray(data)
    dtype = data.dtype                 # note before the float cast
    if data.ndim > 1:                  # stereo -> mono
        data = data.mean(axis=1)
    data = _to_unit_scale(data.astype(np.float64), dtype)
    if normalize:
        peak = np.max(np.abs(data)) or 1.0
        data = data / peak
    if rate != target_rate:
        from math import gcd
        g = gcd(int(rate), int(target_rate))
        data = resample_poly(data, target_rate // g, rate // g)
    return data.astype(np.float32)


def _load_ffmpeg(path: str, target_rate: int,
                 normalize: bool = True) -> np.ndarray:
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
    if not normalize:
        return data                    # ffmpeg's f32 output is already unit-scale
    peak = float(np.max(np.abs(data))) or 1.0
    return data / peak


# --------------------------------------------------------------------------- #
# Capture integrity
# --------------------------------------------------------------------------- #
TRIM_PAD = 0.5       # seconds of silence to keep either side of the keying


def trim_silence(sig: np.ndarray, rate: int, pad: float = TRIM_PAD,
                 tone: float | None = None, bandwidth: float = 200.0):
    """Trim dead air from both ends, keeping `pad` seconds of it.

    Returns (trimmed, lead_seconds) where `lead_seconds` is how much was cut
    from the front — the offset between the original recording's clock and the
    trimmed one.

    Detection runs through the same bandpass-and-threshold the decoder uses, so
    it keys off the *tone* rather than raw level: room noise or hum on an
    otherwise-idle input won't defeat it. Returns the input untouched when
    nothing was keyed, when the clip is already shorter than the padding, or
    when there's nothing to gain — trimming should never be able to eat audio
    it can't account for.
    """
    if sig.size == 0 or pad < 0:
        return sig, 0.0
    if sig.size <= int(2 * pad * rate):
        return sig, 0.0
    try:
        if tone is None:
            tone = detect_tone(sig, rate)
        env = envelope(sig, rate, tone, bw=bandwidth)
        thr = keying_threshold(env)
        on = np.flatnonzero(env > thr)
    except Exception:
        return sig, 0.0
    if on.size == 0:
        return sig, 0.0
    p = int(pad * rate)
    start = max(int(on[0]) - p, 0)
    end = min(int(on[-1]) + 1 + p, sig.size)
    if end - start < int(0.1 * rate) or (start == 0 and end == sig.size):
        return sig, 0.0
    return sig[start:end], start / float(rate)


def find_dropouts(sig: np.ndarray, rate: int, factor: float = 2.5) -> list:
    """Return the times (seconds) where the waveform appears to have been cut.

    A dropped capture buffer removes a block of samples, so the waveform
    resumes at an arbitrary phase. That leaves a single-sample jump far larger
    than anything the signal's own frequency content can produce — a click to
    the ear, a shortened dit or dah to the decoder.

    The threshold is relative to the signal's own 99.9th-percentile slew, so it
    adapts to level and tone frequency instead of assuming either. Measured
    against real captures, that ratio is ~1.04 for clean recordings and 1.5 at
    worst under heavy noise, against 4.1-5.2 for captures with dropped buffers
    — so `factor` sits between, with margin on both sides. Analyze at the
    file's own rate: resampling smooths the splice and hides it.
    """
    if sig.size < 64:
        return []
    dx = np.abs(np.diff(np.asarray(sig, dtype=np.float64)))
    ref = float(np.percentile(dx, 99.9))
    if ref <= 0:
        return []
    hits = np.flatnonzero(dx > factor * ref)
    if hits.size == 0:
        return []
    # One dropped buffer can trip several adjacent samples; count it once.
    keep = np.concatenate(([True], np.diff(hits) > rate // 100))
    return [float(i) / rate for i in hits[keep]]


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
    if np.all(np.isnan(between)):     # constant/silent input -> no split
        return float(np.median(x))
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
    """Drop runs shorter than `min_dur` by merging them into their neighbors."""
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
class Block:
    """One keyed mark or one gap, located in absolute time.

    `units` is the measured duration expressed in the reference timing's dit
    units; `target_units` is what a machine sender would have produced.

    `kind` is what the decoder *read* — it is inferred from duration alone, so a
    Farnsworth-spaced letter gap sent against a tighter target reads as a word
    gap. `target_kind` is what the gap was *meant* to be. Without an intended
    message the two are identical; `retarget` sets them apart once the intended
    text says which class each gap belongs to. Grading always uses
    `target_kind`/`target_units`; the decode and the word-boundary diff always
    use `kind`, since that is genuinely what came off the air.

    A `pause` (an inter-transmission silence, far longer than a word gap) has no
    meaningful target, so its `target_units` is 0 and it is excluded from
    grading — unless the intended text places a real gap there.
    """
    t0: float
    t1: float
    kind: str                       # dit|dah|element-gap|char-gap|word-gap|pause
    units: float
    target_units: float
    context: str = ""               # decoded text preceding a char/word gap
    target_kind: str = ""           # class graded against; defaults to `kind`

    def __post_init__(self) -> None:
        if not self.target_kind:
            self.target_kind = self.kind


@dataclass
class Char:
    """One decoded character and the blocks that produced it."""
    char: str                       # "L", "<SK>", or "?" if unrecognized
    pattern: str                    # ".-.."
    t0: float
    t1: float
    blocks: list                    # list[Block]: marks + intra-character gaps
    lead_gap: "Block | None" = None  # the char/word gap that preceded it


@dataclass
class Timeline:
    """A decode with its timing structure preserved."""
    text: str
    chars: list                     # list[Char]
    blocks: list                    # list[Block], every block in time order
    duration: float = 0.0           # keyed span; set for synthesized ideals


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


def _gap_classes(text: str) -> "tuple[int, int]":
    """How many character gaps and word gaps the intended text calls for."""
    words = [w for w in (_keyable_symbols(w) for w in text.upper().split()) if w]
    return (sum(max(len(w) - 1, 0) for w in words), max(len(words) - 1, 0))


def estimate_timing(segs, expected: str | None = None) -> Timing:
    """Derive dit length, speeds, and classification thresholds from segments.

    `expected` is the intended message, used only to settle what the dominant
    inter-character silence *is* — see the note where it's read below.
    """
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
        # _dominant_gap returns the most populous inter-character silence and
        # calls it the character gap, which holds for ordinary text. It does not
        # hold for a single-letter drill: "A B C D E F" has no character gaps at
        # all, so the dominant silence there is a *word* gap, and reading it as a
        # character gap puts `ta` out by 7/3 — an overall speed of 8 wpm for
        # sending that was 14, and a decode of "ABCDEF" with every word break
        # swallowed, because char_word_split lands above the gaps that made it.
        #
        # The audio can't settle this. Equal silences between single letters are
        # loose character gaps or word gaps depending only on what was meant, and
        # both readings fit the same recording. The intended text is the one
        # thing that knows, so use it when it's there: whichever class the text
        # has more of is the class the dominant cluster belongs to.
        if expected:
            n_char, n_word = _gap_classes(expected)
            if n_word > n_char:
                char_gap *= 3.0 / 7.0     # it was a word gap all along
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
PAUSE_FACTOR = 2.0
"""A silence shorter than this many nominal word gaps is always spacing, never
a rest — the floor under `REST_OUTLIER`, so a wide word gap in otherwise tight
sending can't be written off as a stop."""

REST_OUTLIER = 3.0
"""A silence longer than this many times the sender's own typical inter-character
gap is the sender resting between transmissions, not a spacing error.

Measured against the sender rather than the target because that's what actually
separates the two cases. Sending with the spacing wound out puts *every* gap
several times over the nominal one — consistently, and that is a spacing error
worth grading. Stopping to read the next exercise puts *one* gap far out of line
with all the others. A fixed multiple of the target's word gap cannot tell those
apart at any setting: measured that way, wide-but-even spacing and a genuine
stop overlap.
"""


def _median(values) -> float:
    return float(np.median(values)) if len(values) else 0.0


def build_timeline(segs, timing: Timing,
                   pause_factor: float = PAUSE_FACTOR) -> Timeline:
    """Turn (state,duration) segments + timing thresholds into a Timeline.

    This is the single source of truth for "what did the sender actually key":
    it produces the decoded text, the per-character grouping, and every mark and
    gap measured against `timing`. `decode_segments` and `analyze` are both thin
    layers over it, as is the web review payload.

    `pause_factor` is where a long silence stops being spacing and becomes a
    rest; pass `math.inf` to grade every silence as spacing, however long.
    """
    u = timing.unit_sec
    char_gap_u = (timing.char_gap_sec / u) if timing.char_gap_sec else 3.0
    word_gap_u = (timing.word_gap_sec / u) if timing.word_gap_sec else 7.0

    # What this sender's own between-character silences look like, so a rest can
    # be judged as an outlier against them. Median, not mean: one 200-unit stop
    # would drag a mean up far enough to hide itself.
    spacing = [d / u for i, (state, d) in enumerate(segs)
               if state == 0 and 0 < i < len(segs) - 1
               and d >= timing.element_char_split]
    pause_floor = max(pause_factor * word_gap_u, REST_OUTLIER * _median(spacing))

    text, chars, blocks = [], [], []
    pending, pattern = [], []     # blocks / elements of the character in progress
    lead = None                   # the char-or-word gap that preceded it
    t = 0.0
    n = len(segs)

    def flush() -> None:
        """Close out the character in progress.

        A character ends at its own last mark, never at the current cursor:
        `t` has already advanced past the gap that triggered the flush, and at
        the end of the loop it sits beyond the trailing silence. Reading the
        end off `pending` keeps that silence out of the character's span.
        """
        nonlocal pending, pattern, lead
        if not pattern:
            return
        pat = "".join(pattern)
        ch = decode_pattern(pat)
        text.append(ch)
        chars.append(Char(char=ch, pattern=pat, t0=pending[0].t0,
                          t1=pending[-1].t1, blocks=pending, lead_gap=lead))
        pending, pattern, lead = [], [], None

    def tail() -> str:
        return "".join(text)[-10:].strip()

    for i, (state, dur) in enumerate(segs):
        start, t = t, t + dur
        vu = dur / u
        if state == 1:  # mark
            is_dit = dur < timing.dit_dah_split
            pattern.append("." if is_dit else "-")
            block = Block(start, t, "dit" if is_dit else "dah", vu,
                          1.0 if is_dit else 3.0)
            pending.append(block)
            blocks.append(block)
        else:  # gap — the very first and last silences are not spacing
            if i == 0 or i == n - 1:
                continue
            if dur < timing.element_char_split:
                block = Block(start, t, "element-gap", vu, 1.0)
                pending.append(block)
                blocks.append(block)
            elif dur < timing.char_word_split:
                flush()
                lead = Block(start, t, "char-gap", vu, char_gap_u, tail())
                blocks.append(lead)
            else:
                flush()
                is_pause = vu > pause_floor
                lead = Block(start, t, "pause" if is_pause else "word-gap", vu,
                             0.0 if is_pause else word_gap_u, tail())
                blocks.append(lead)
                text.append(" ")
    flush()
    return Timeline(text="".join(text), chars=chars, blocks=blocks)


def decode_segments(segs, timing: Timing) -> str:
    """Turn (state,duration) segments + timing thresholds into text."""
    return build_timeline(segs, timing).text


# --------------------------------------------------------------------------- #
# The intended message as a timeline, and pairing it against a decode
# --------------------------------------------------------------------------- #
def _keyable_symbols(word: str) -> list:
    """Split a word into keyable symbols, treating <XX> as one prosign."""
    return [t for t in _SYMBOL.findall(word) if t in CHAR_TO_MORSE]


def ideal_timeline(text: str, timing: Timing) -> Timeline:
    """Render `text` as the timeline a machine sender would have keyed.

    Same shape as a decoded Timeline, laid out the way `synth.generate` builds
    its on/off list, so "perfect" here is exactly what the synthesizer would
    produce at `timing`. Every block's `units` equals its `target_units`.
    """
    u = timing.unit_sec
    char_gap = timing.char_gap_sec or 3 * u
    word_gap = timing.word_gap_sec or 7 * u

    chars, blocks, t = [], [], 0.0
    words = [w for w in text.upper().split() if w]

    for wi, word in enumerate(words):
        lead = None
        if wi > 0:
            lead = Block(t, t + word_gap, "word-gap", word_gap / u,
                         word_gap / u)
            blocks.append(lead)
            t += word_gap
        for li, ch in enumerate(_keyable_symbols(word)):
            if li > 0:
                lead = Block(t, t + char_gap, "char-gap", char_gap / u,
                             char_gap / u)
                blocks.append(lead)
                t += char_gap
            pattern = CHAR_TO_MORSE[ch]
            pending, c0 = [], t
            for ei, el in enumerate(pattern):
                if ei > 0:
                    gap = Block(t, t + u, "element-gap", 1.0, 1.0)
                    pending.append(gap)
                    blocks.append(gap)
                    t += u
                is_dit = el == "."
                dur = u if is_dit else 3 * u
                mark = Block(t, t + dur, "dit" if is_dit else "dah",
                             1.0 if is_dit else 3.0, 1.0 if is_dit else 3.0)
                pending.append(mark)
                blocks.append(mark)
                t += dur
            chars.append(Char(char=ch, pattern=pattern, t0=c0, t1=t,
                              blocks=pending, lead_gap=lead))
            lead = None

    return Timeline(text=" ".join(words), chars=chars, blocks=blocks,
                    duration=t)


@dataclass
class Slot:
    """One aligned position between a decode and the intended message."""
    op: str                      # equal|sub|del|ins for the characters
    actual: "Char | None"
    ideal: "Char | None"
    space_op: "str | None" = None  # equal|ins|del for the word boundary before


def _token_stream(tl: Timeline) -> list:
    """Characters plus explicit word-boundary tokens, the stream `compare_text`
    aligns on, so pairing and the accuracy figure never disagree."""
    out = []
    for c in tl.chars:
        g = c.lead_gap
        if g is not None and g.kind in ("word-gap", "pause"):
            out.append((" ", None))
        out.append((c.char, c))
    return out


def pair(actual: Timeline, ideal: Timeline) -> list:
    """Align a decode against the intended message, character by character.

    Each space op is folded onto the character that follows it, so a
    word-boundary error is visible twice: as the slot's `space_op`, and as that
    slot's own gap being the wrong length.
    """
    a_items, b_items = _token_stream(actual), _token_stream(ideal)
    ops = _align([tok for tok, _ in b_items],       # expected
                 [tok for tok, _ in a_items])       # got

    slots, ai, bi, pending_space = [], 0, 0, None
    for op, e, g in ops:
        ideal_item = b_items[bi] if e is not None else None
        bi += 1 if e is not None else 0
        actual_item = a_items[ai] if g is not None else None
        ai += 1 if g is not None else 0
        # A space token carries no character; it only reports whether the word
        # boundary landed where it should, which we hang on the next character.
        if ideal_item is not None and ideal_item[1] is None:
            pending_space = op if (actual_item is not None
                                   and actual_item[1] is None) else "del"
            ideal_item = None
        if actual_item is not None and actual_item[1] is None:
            if pending_space is None:
                pending_space = "ins"
            actual_item = None
        if ideal_item is None and actual_item is None:
            continue
        # A space aligned against a character leaves one side empty, so the
        # character's own verdict is no longer `op` — it's an extra or a miss.
        if ideal_item is None:
            op = "ins"
        elif actual_item is None:
            op = "del"
        slots.append(Slot(op=op,
                          actual=actual_item[1] if actual_item else None,
                          ideal=ideal_item[1] if ideal_item else None,
                          space_op=pending_space))
        pending_space = None
    return slots


def retarget(slots: list) -> int:
    """Re-target each decoded gap from the intended message, in place.

    `build_timeline` has to guess a gap's class from its duration, which is the
    only information it has. Once the intended text is known that guess is
    obsolete: if the alignment pairs a decoded character with an intended one,
    the intended character's lead gap says what the silence before it was
    *supposed* to be, whatever it measured. Without this, Farnsworth-ish letter
    gaps that overshoot the target's char/word split get graded as word gaps and
    average out to a flattering score, while the character-gap row vanishes from
    the report entirely.

    Rests are the exception, and deliberately so. `build_timeline` has already
    judged a silence far past any spacing to be the sender stopping, and the
    intended text can't overrule that: practicing a list of separate words means
    the text has a word gap at every point you paused between exercises, and
    grading those as word gaps buries the real errors under 200-unit
    "deviations". Where the line falls is `pause_factor`'s job, not this one's.

    Only gaps move. Marks keep the target their own class implies, since a
    mis-decoded character says nothing reliable about what its elements meant.
    And only `target_kind`/`target_units` move: `kind` must go on reporting what
    the decoder read, because the decoded text, the word-boundary diff, and
    `pair`'s own token stream are all derived from it. That's what keeps this
    safe to run after pairing — it cannot invalidate the pairing it was handed.

    Returns the number of gaps whose class changed.
    """
    moved = 0
    for slot in slots:
        if slot.actual is None or slot.ideal is None:
            continue
        got, want = slot.actual.lead_gap, slot.ideal.lead_gap
        if got is None or want is None or got.kind == "pause":
            continue
        if got.target_kind != want.kind:
            moved += 1
        got.target_kind = want.kind
        got.target_units = want.target_units
    return moved


# --------------------------------------------------------------------------- #
# Analysis against a target
# --------------------------------------------------------------------------- #
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


def analyze(timeline: Timeline, ref: Timing, measured: Timing,
            tolerance: float = 0.30) -> Analysis:
    """Grade the keying in `timeline` against the ideal `ref` timing.

    `timeline` must have been built against `ref` (that's what makes its
    `units`/`target_units` comparable), and should already have been through
    `retarget` if the intended message is known. Every verdict here reads
    `target_kind`/`target_units`, never `kind`: what a gap was meant to be is
    what it should be graded as. Blocks still classified as intentional pauses —
    the sender resting between repetitions or transmissions — carry no target
    and are counted separately rather than graded as spacing errors.
    """
    n_pauses = sum(1 for b in timeline.blocks if b.target_kind == "pause")
    graded = [b for b in timeline.blocks if b.target_units > 0]

    groups = {}
    for b in graded:
        g = groups.setdefault(b.target_kind,
                              {"vals": [], "target": b.target_units})
        g["vals"].append(b.units)

    stats = []
    for kind in _CLASS_ORDER:
        if kind in groups:
            vals = np.asarray(groups[kind]["vals"])
            stats.append(ClassStat(kind, vals.size, float(vals.mean()),
                                    float(vals.std()), groups[kind]["target"]))

    devs, within = [], 0
    for b in graded:
        rel = abs(b.units - b.target_units) / b.target_units
        if rel <= tolerance:
            within += 1
        # Flag a deviation only if it's both proportionally and absolutely off,
        # so 1-unit elements aren't flagged for tiny wobble.
        elif abs(b.units - b.target_units) >= 0.4:
            devs.append(Deviation(b.t0, b.target_kind, b.units, b.target_units,
                                  b.context))

    devs.sort(key=lambda d: abs(d.value_units - d.target_units) / d.target_units,
              reverse=True)
    frac = within / len(graded) if graded else 1.0
    return Analysis(ref, measured, stats, devs[:12], frac, tolerance, n_pauses)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def quick_decode(sig: np.ndarray, rate: int, tone: float,
                 timing: Timing, bandwidth: float = 200.0) -> str:
    """Decode `sig` to text using a *fixed* known tone and timing.

    Lightweight path for live/streaming use: no tone detection or speed
    estimation, just envelope -> threshold -> segments -> decode against the
    given (target) timing. Returns "" for too-short/silent input.
    """
    if sig.size < int(0.1 * rate) or float(np.max(np.abs(sig))) < 1e-6:
        return ""
    env = envelope(sig, rate, tone, bw=bandwidth)
    thr = keying_threshold(env)
    segs = run_lengths(env > thr, rate)
    marks = [d for s, d in segs if s == 1]
    if not marks:
        return ""
    segs = debounce(segs, min_dur=0.35 * float(np.percentile(marks, 20)))
    return decode_segments(segs, timing)


@dataclass
class Result:
    text: str
    tone_hz: float
    timing: Timing              # measured (auto-estimated) timing
    rate: int
    analysis: Analysis | None = None  # present when a target was supplied
    timeline: Timeline | None = None  # the decode with timing preserved
    segments: list = field(default_factory=list)  # (state, seconds), debounced
    signal: np.ndarray | None = None  # normalized mono audio at `rate`


def decode_file(path: str, tone: float | None = None,
                target_rate: int = TARGET_RATE,
                bandwidth: float = 200.0,
                target_wpm: float | None = None,
                target_farnsworth: float | None = None,
                tolerance: float = 0.30,
                keep_signal: bool = False,
                expected: str | None = None) -> Result:
    """Decode `path`, and grade it if `target_wpm` is given.

    `expected` is the intended message. It changes nothing about the decode —
    only what the spacing is graded against, via `retarget`: gap classes come
    from the text the sender meant to send rather than from a duration guess.
    """
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

    measured = estimate_timing(segs, expected=expected)
    analysis = None
    if target_wpm is not None:
        # Decode against the target's ideal timing and grade the sending.
        ref = target_timing(target_wpm, target_farnsworth)
        timeline = build_timeline(segs, ref)
        if expected and expected.strip():
            retarget(pair(timeline, ideal_timeline(expected, ref)))
        analysis = analyze(timeline, ref, measured, tolerance=tolerance)
    else:
        timeline = build_timeline(segs, measured)
    return Result(text=timeline.text, tone_hz=tone_hz, timing=measured,
                  rate=target_rate, analysis=analysis, timeline=timeline,
                  segments=segs, signal=sig if keep_signal else None)
