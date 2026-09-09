"""Live audio capture via ffmpeg.

Currently supports macOS (avfoundation). The rest of the pipeline is unchanged:
we capture to a mono WAV at the decoder's sample rate, then decode/grade it like
any other file. Kept separate from core.py because it's platform-specific and
involves an interactive recording loop.
"""

from __future__ import annotations

import os
import platform
import re
import select
import shutil
import subprocess
import sys
import time

RATE = 8000
# Capture at the device's *native* rate: pass rate=None and don't give ffmpeg
# an -ar at all.
#
# Forcing a rate makes ffmpeg resample every sample. On a square-ish keyer
# sidetone that is audible — resampling 48 kHz to 44.1 kHz leaves the harmonics
# intact but lifts the noise between them by ~6 dB (worse on a real sidetone),
# which is exactly the "crunchy" quality it produces. The decoder resamples to
# its own 8 kHz working rate anyway, so there is nothing to gain by resampling
# twice.
DEFAULT_MAX_SECONDS = 120.0  # safety cap so a capture can't run away and fill disk
_HEADER_TIMEOUT = 15.0       # seconds to wait for ffmpeg's WAV header on a pipe

# Keep the realtime capture path a pure passthrough: no -ar, no -ac, no filters.
# Every conversion ffmpeg has to do while the device is streaming is a chance to
# fall behind and drop a buffer, and a dropped buffer splices the waveform at an
# arbitrary phase — an audible click, a shortened dit or dah, and a decoder that
# reads the sending as faster than it was. Channels and rate are sorted out
# afterwards, off the clock, by load_audio.
_THREAD_QUEUE = "8192"       # input packet queue; the default overflows here


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise RuntimeError("ffmpeg not found on PATH — required for live capture.")
    return exe


def _backend() -> str:
    system = platform.system()
    if system == "Darwin":
        return "avfoundation"
    raise RuntimeError(
        f"Live capture is currently implemented for macOS only (detected "
        f"{system}). Record with your OS tools and pass the WAV/MP3 instead."
    )


def _parse_devices(stderr_text: str):
    """Extract (index, name) audio input devices from ffmpeg's device listing."""
    devices, in_audio = [], False
    for line in stderr_text.splitlines():
        low = line.lower()
        if "audio devices" in low:
            in_audio = True
            continue
        if "video devices" in low:
            in_audio = False
            continue
        if in_audio:
            m = re.search(r"\[(\d+)\]\s+(.+?)\s*$", line)
            if m:
                devices.append((int(m.group(1)), m.group(2)))
    return devices


def list_audio_devices():
    """Return a list of (index, name) for available audio input devices."""
    backend = _backend()
    cmd = [_ffmpeg(), "-hide_banner", "-f", backend,
           "-list_devices", "true", "-i", ""]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return _parse_devices(proc.stderr)


def _quit_ffmpeg(proc) -> None:
    """Ask ffmpeg to stop and finalize the file (graceful), else terminate."""
    if proc.poll() is not None:
        return
    try:
        proc.stdin.write(b"q")
        proc.stdin.flush()
    except (OSError, ValueError, AttributeError):
        proc.terminate()


def _read_stream_format(stdout):
    """Read ffmpeg's WAV header off the pipe; return (sample_rate, channels).

    This is how the caller learns the device's native format without forcing
    one: ask for `-f wav` instead of raw PCM, parse the header, then treat the
    rest of the pipe as samples. On a pipe ffmpeg can't backfill the RIFF/data
    lengths so they arrive as 0xFFFFFFFF — which is fine, we only need `fmt `.
    """
    # Poll with a deadline on a real pipe, so a device that never produces
    # audio fails with a clear message instead of hanging. An in-memory stream
    # (tests) has no fileno, so just read it.
    try:
        stdout.fileno()
        pollable = True
    except Exception:
        pollable = False

    def need(n: int) -> bytes:
        buf = b""
        deadline = time.monotonic() + _HEADER_TIMEOUT
        while len(buf) < n:
            if time.monotonic() > deadline:
                raise RuntimeError("timed out waiting for audio from ffmpeg "
                                   "— is the device in use or unauthorized?")
            if pollable and not select.select([stdout], [], [], 0.5)[0]:
                continue
            chunk = stdout.read(n - len(buf))
            if not chunk:
                raise RuntimeError("ffmpeg closed the stream before sending "
                                   "any audio.")
            buf += chunk
        return buf

    head = need(12)
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise RuntimeError("unexpected audio stream header from ffmpeg.")
    while True:
        cid = need(4)
        size = int.from_bytes(need(4), "little")
        if cid == b"fmt ":
            fmt = need(size)
            return (int.from_bytes(fmt[4:8], "little"),      # sample rate
                    int.from_bytes(fmt[2:4], "little") or 1)  # channels
        if cid == b"data":
            raise RuntimeError("audio stream had no format chunk.")
        need(size + (size & 1))          # skip, chunks are word-aligned


def open_stream(device: int, rate: "int | None" = None):
    """Start ffmpeg streaming mono float32 PCM from `device` to stdout.

    Returns (Popen, rate). With `rate=None` the device's native rate is used
    and reported back — no resampling, which is what keeps a keyer sidetone
    clean. The caller reads stdout in blocks and calls `_quit_ffmpeg` to stop.
    """
    backend = _backend()
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "warning",
           "-thread_queue_size", _THREAD_QUEUE,
           "-f", backend, "-i", f":{device}"]
    if rate:
        cmd += ["-ar", str(rate)]
    # A WAV container rather than bare f32le, so the header reports the rate and
    # channel count the device actually gave us.
    cmd += ["-c:a", "pcm_f32le", "-f", "wav", "-"]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        actual, channels = _read_stream_format(proc.stdout)
    except Exception:
        _quit_ffmpeg(proc)
        raise
    return proc, actual, channels


def wav_rate(path: str) -> "int | None":
    """The sample rate of a WAV file, or None if it can't be read."""
    import wave
    try:
        with wave.open(path, "rb") as w:
            return w.getframerate()
    except Exception:
        return None


def record(device: int, out_path: str, rate: "int | None" = None,
           max_seconds: float = DEFAULT_MAX_SECONDS) -> None:
    """Capture audio from `device` into `out_path` as a mono WAV.

    With `rate=None` (the default) no `-ar` is passed, so ffmpeg records at the
    device's native rate and no resampling happens — see the note on
    DEFAULT_MAX_SECONDS above for why that matters. Read the resulting rate off
    the file with `wav_rate`.

    Recording stops at whichever comes first: the user pressing Enter, or the
    `max_seconds` cap. ffmpeg is also given `-t max_seconds`, so the file is
    hard-bounded even if the interactive stop is somehow missed — a capture can
    never run away and fill the disk.
    """
    if max_seconds <= 0:
        max_seconds = DEFAULT_MAX_SECONDS
    backend = _backend()
    # No -ac and (by default) no -ar: nothing to convert while the device is
    # streaming. load_audio downmixes and resamples later, off the clock.
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "warning",
           "-thread_queue_size", _THREAD_QUEUE,
           "-f", backend, "-i", f":{device}"]
    if rate:
        cmd += ["-ar", str(rate)]
    cmd += ["-t", str(max_seconds), "-y", out_path]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        if sys.stdin.isatty():
            # Poll for Enter, but never wait past the cap (ffmpeg's -t enforces
            # the same bound on the file itself).
            deadline = time.monotonic() + max_seconds
            while proc.poll() is None and time.monotonic() < deadline:
                ready, _, _ = select.select([sys.stdin], [], [], 0.5)
                if ready:
                    try:
                        os.read(sys.stdin.fileno(), 4096)  # consume the Enter
                    except OSError:
                        pass
                    break
            _quit_ffmpeg(proc)
        else:
            proc.wait()  # non-interactive: rely on ffmpeg's -t cap
    except KeyboardInterrupt:
        _quit_ffmpeg(proc)

    err = b""
    try:
        if proc.stderr:
            err = proc.stderr.read()
    except OSError:
        pass
    proc.wait()

    # ffmpeg returns non-zero when told to quit early; only treat a missing/empty
    # capture as a real failure.
    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1000:
        msg = err.decode(errors="replace") if err else ""
        raise RuntimeError(f"capture produced no audio.\n{msg}".strip())

    # Pass ffmpeg's own complaints through. These used to be suppressed by
    # `-loglevel error`, which hid the queue-overflow warning that accompanies
    # dropped buffers — the thing that makes a capture click and read fast.
    for line in err.decode(errors="replace").splitlines():
        line = line.strip()
        if line and "deprecated" not in line.lower():
            print(f"# ffmpeg: {line}", file=sys.stderr)
