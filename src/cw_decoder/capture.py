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
DEFAULT_MAX_SECONDS = 30.0  # safety cap so a capture can't run away and fill disk


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


def open_stream(device: int, rate: int = RATE):
    """Start ffmpeg streaming raw mono float32 PCM from `device` to stdout.

    Returns the Popen; caller reads stdout in blocks and calls `_quit_ffmpeg`
    to stop. Used by live decode.
    """
    backend = _backend()
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "error",
           "-f", backend, "-i", f":{device}",
           "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def record(device: int, out_path: str, rate: int = RATE,
           max_seconds: float = DEFAULT_MAX_SECONDS) -> None:
    """Capture audio from `device` into `out_path` (mono WAV at `rate`).

    Recording stops at whichever comes first: the user pressing Enter, or the
    `max_seconds` cap. ffmpeg is also given `-t max_seconds`, so the file is
    hard-bounded even if the interactive stop is somehow missed — a capture can
    never run away and fill the disk.
    """
    if max_seconds <= 0:
        max_seconds = DEFAULT_MAX_SECONDS
    backend = _backend()
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "error",
           "-f", backend, "-i", f":{device}",
           "-ac", "1", "-ar", str(rate),
           "-t", str(max_seconds), "-y", out_path]

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
