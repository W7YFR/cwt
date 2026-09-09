"""Live audio capture.

Two backends:

* **portaudio** (preferred) — via the `sounddevice` package. Captures through
  a callback with a large driver-side buffer and *reports* input overflows, so
  a glitch is a message rather than something you discover by ear. Works on
  macOS, Linux and Windows.
* **ffmpeg** (fallback) — avfoundation on macOS only. Kept so live capture
  still works without the optional dependency, but ffmpeg's avfoundation audio
  path drops capture buffers on real hardware even with the input queue raised
  and every conversion removed from the realtime path. A dropped buffer splices
  the waveform at an arbitrary phase: it clicks, it shortens whatever dit or
  dah it landed in, and since the decoder's unit estimate averages the dit with
  a third of the dah, it makes the sending read back *faster* than it was
  keyed. `core.find_dropouts` catches it after the fact either way.

Whichever backend is used, capture stays a passthrough: the device's own rate
and channel count, no filters. Rate conversion and channel folding happen
afterwards, off the clock, in `core.load_audio`.
"""

from __future__ import annotations

import os
import platform
import queue
import re
import select
import shutil
import subprocess
import sys
import time
from typing import NamedTuple

import numpy as np

RATE = 8000
DEFAULT_MAX_SECONDS = 120.0  # safety cap so a capture can't run away and fill disk
_HEADER_TIMEOUT = 15.0       # seconds to wait for ffmpeg's WAV header on a pipe
_THREAD_QUEUE = "8192"       # ffmpeg input packet queue; the default overflows

BACKENDS = ("portaudio", "ffmpeg")


# --------------------------------------------------------------------------- #
# Backend selection
# --------------------------------------------------------------------------- #
def _sounddevice():
    """The `sounddevice` module, or None if it isn't installed/usable."""
    try:
        import sounddevice
        sounddevice.query_devices()      # fails fast if PortAudio is broken
        return sounddevice
    except Exception:
        return None


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise RuntimeError("ffmpeg not found on PATH — required for live capture.")
    return exe


def _backend_name() -> str:
    system = platform.system()
    if system == "Darwin":
        return "avfoundation"
    raise RuntimeError(
        f"ffmpeg live capture is implemented for macOS only (detected "
        f"{system}). Install the 'live' extra for the portaudio backend, or "
        f"record with your OS tools and pass the WAV instead."
    )


def available_backends() -> list:
    """Backends usable right now, best first."""
    out = []
    if _sounddevice() is not None:
        out.append("portaudio")
    if shutil.which("ffmpeg") and platform.system() == "Darwin":
        out.append("ffmpeg")
    return out


def resolve_backend(name: str = "auto") -> str:
    """Pick a backend, preferring portaudio. Raises if none is usable."""
    usable = available_backends()
    if name != "auto":
        if name not in BACKENDS:
            raise RuntimeError(f"unknown capture backend: {name}")
        if name not in usable:
            extra = ("Install it with: pip install 'cw-decoder[live]'"
                     if name == "portaudio"
                     else "Install ffmpeg (macOS only for capture).")
            raise RuntimeError(f"capture backend {name!r} is unavailable. {extra}")
        return name
    if not usable:
        raise RuntimeError(
            "no live-capture backend available. Install the portaudio backend "
            "with: pip install 'cw-decoder[live]'  (or install ffmpeg on macOS)."
        )
    return usable[0]


# --------------------------------------------------------------------------- #
# Device listing
# --------------------------------------------------------------------------- #
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


class Device(NamedTuple):
    """An input device. `name` is the device's own name — stable across runs,
    unlike `index` — so it's what gets remembered. `detail` is display-only."""
    index: int
    name: str
    detail: str = ""

    def label(self) -> str:
        return f"{self.name} ({self.detail})" if self.detail else self.name


def list_audio_devices(backend: str = "auto") -> list:
    """Return [Device, ...] for the given backend's input devices.

    Indices are backend-specific — PortAudio and avfoundation number devices
    differently — so always list and select with the same backend. Names are
    not, which is why they're the durable way to refer to a device.
    """
    backend = resolve_backend(backend)
    if backend == "portaudio":
        sd = _sounddevice()
        out = []
        for i, d in enumerate(sd.query_devices()):
            if d.get("max_input_channels", 0) > 0:
                out.append(Device(i, d["name"],
                                  f"{int(d['default_samplerate'])} Hz, "
                                  f"{d['max_input_channels']} ch"))
        return out
    cmd = [_ffmpeg(), "-hide_banner", "-f", _backend_name(),
           "-list_devices", "true", "-i", ""]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return [Device(i, n) for i, n in _parse_devices(proc.stderr)]


# --------------------------------------------------------------------------- #
# Incremental capture
# --------------------------------------------------------------------------- #
class LiveStream:
    """A running capture that can be read incrementally.

    `rate` and `channels` describe what the device actually gave us. `read`
    returns however many new interleaved samples are available (possibly an
    empty array) or None once the source has ended.
    """

    rate: int = 0
    channels: int = 1
    backend: str = ""

    def read(self, timeout: float = 0.2):
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError

    def problems(self) -> list:
        """Backend-reported glitches (e.g. input overflow)."""
        return []


class _PortAudioStream(LiveStream):
    def __init__(self, sd, device: int, rate: "int | None"):
        info = sd.query_devices(device, "input")
        max_ch = int(info.get("max_input_channels") or 1)
        self.backend = "portaudio"
        self.rate = int(rate or info.get("default_samplerate") or 48000)
        self.channels = 1 if max_ch >= 1 else max_ch
        self._q: queue.Queue = queue.Queue()
        self._status: list = []
        self._sd = sd

        def callback(indata, frames, time_info, status):
            # PortAudio tells us when it had to drop input — record it rather
            # than letting a glitch pass silently.
            if status:
                self._status.append(str(status))
            self._q.put(np.asarray(indata, dtype=np.float32).reshape(-1).copy())

        # latency="high" asks the driver for a generous buffer, which is what
        # keeps a capture from overrunning while the rest of this process works.
        self._stream = sd.InputStream(
            device=device, samplerate=self.rate, channels=self.channels,
            dtype="float32", blocksize=0, latency="high", callback=callback)
        self._stream.start()

    def read(self, timeout: float = 0.2):
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return np.zeros(0, dtype=np.float32)

    def stop(self) -> None:
        try:
            self._stream.stop()
        finally:
            self._stream.close()
        # Drain whatever the callback queued before we stopped.
        rest = []
        while True:
            try:
                rest.append(self._q.get_nowait())
            except queue.Empty:
                break
        self._tail = np.concatenate(rest) if rest else np.zeros(0, np.float32)

    def drain(self):
        return getattr(self, "_tail", np.zeros(0, dtype=np.float32))

    def problems(self) -> list:
        return list(self._status)


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
            return (int.from_bytes(fmt[4:8], "little"),       # sample rate
                    int.from_bytes(fmt[2:4], "little") or 1)  # channels
        if cid == b"data":
            raise RuntimeError("audio stream had no format chunk.")
        need(size + (size & 1))          # skip, chunks are word-aligned


def _quit_ffmpeg(proc) -> None:
    """Ask ffmpeg to stop and finalize (graceful), else terminate."""
    if proc.poll() is not None:
        return
    try:
        proc.stdin.write(b"q")
        proc.stdin.flush()
    except (OSError, ValueError, AttributeError):
        proc.terminate()


class _FfmpegStream(LiveStream):
    def __init__(self, device: int, rate: "int | None"):
        cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "warning",
               "-thread_queue_size", _THREAD_QUEUE,
               # Documented for video frames, but avfoundation's audio path
               # also discards late buffers; ask it not to.
               "-drop_late_frames", "false",
               "-f", _backend_name(), "-i", f":{device}"]
        if rate:
            cmd += ["-ar", str(rate)]
        # A WAV container rather than bare f32le, so the header reports the
        # rate and channel count the device actually gave us.
        cmd += ["-c:a", "pcm_f32le", "-f", "wav", "-"]
        self.backend = "ffmpeg"
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
        try:
            self.rate, self.channels = _read_stream_format(self._proc.stdout)
        except Exception:
            _quit_ffmpeg(self._proc)
            raise

    def read(self, timeout: float = 0.2):
        ready, _, _ = select.select([self._proc.stdout], [], [], timeout)
        if not ready:
            return np.zeros(0, dtype=np.float32)
        data = self._proc.stdout.read1(65536)
        if not data:
            return None
        return np.frombuffer(data, dtype="<f4")

    def stop(self) -> None:
        _quit_ffmpeg(self._proc)
        rest = []
        try:
            while True:                    # keep the remaining tail audio
                data = self._proc.stdout.read1(65536)
                if not data:
                    break
                rest.append(np.frombuffer(data, dtype="<f4"))
        except (OSError, ValueError):
            pass
        err = b""
        try:
            if self._proc.stderr:
                err = self._proc.stderr.read()
        except OSError:
            pass
        self._proc.wait()
        self._tail = np.concatenate(rest) if rest else np.zeros(0, np.float32)
        self._err = err.decode(errors="replace")

    def drain(self):
        return getattr(self, "_tail", np.zeros(0, dtype=np.float32))

    def problems(self) -> list:
        out = []
        for line in getattr(self, "_err", "").splitlines():
            line = line.strip()
            if line and "deprecated" not in line.lower():
                out.append(line)
        return out


def open_stream(device: int, rate: "int | None" = None,
                backend: str = "auto") -> LiveStream:
    """Start capturing from `device`. `rate=None` uses the device's own rate."""
    backend = resolve_backend(backend)
    if backend == "portaudio":
        return _PortAudioStream(_sounddevice(), device, rate)
    return _FfmpegStream(device, rate)


# --------------------------------------------------------------------------- #
# Recording to a file
# --------------------------------------------------------------------------- #
def _stop_requested() -> bool:
    """True once the user has pressed Enter (non-blocking)."""
    if not sys.stdin.isatty():
        return False
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    if not ready:
        return False
    try:
        os.read(sys.stdin.fileno(), 4096)      # consume the Enter
    except OSError:
        pass
    return True


def capture_samples(device: int, rate: "int | None" = None,
                    max_seconds: float = DEFAULT_MAX_SECONDS,
                    backend: str = "auto", on_block=None):
    """Capture until Enter, end of stream, or `max_seconds`.

    Returns (mono_samples, rate, backend, problems). `on_block` is called with
    the accumulated *interleaved* buffer as it grows, for a live preview.
    """
    if max_seconds <= 0:
        max_seconds = DEFAULT_MAX_SECONDS
    stream = open_stream(device, rate, backend)
    chunks: list = []
    start = time.monotonic()
    try:
        while True:
            block = stream.read(0.1)
            if block is None:                  # source ended
                break
            if block.size:
                chunks.append(block)
                if on_block is not None:
                    on_block(chunks, stream.rate, stream.channels)
            if _stop_requested():
                break
            if time.monotonic() - start >= max_seconds:
                break
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop()
    tail = stream.drain()
    if tail.size:
        chunks.append(tail)

    sig = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    return (to_mono(sig, stream.channels), stream.rate, stream.backend,
            stream.problems())


def to_mono(sig: np.ndarray, channels: int) -> np.ndarray:
    """Fold interleaved frames to mono. A no-op for a mono capture."""
    if channels <= 1 or sig.size < channels:
        return sig
    usable = sig.size // channels * channels
    return sig[:usable].reshape(-1, channels).mean(axis=1).astype(np.float32)


def wav_rate(path: str) -> "int | None":
    """The sample rate of a WAV file, or None if it can't be read."""
    import wave
    try:
        with wave.open(path, "rb") as w:
            return w.getframerate()
    except Exception:
        return None


def record(device: int, out_path: str, rate: "int | None" = None,
           max_seconds: float = DEFAULT_MAX_SECONDS,
           backend: str = "auto") -> tuple:
    """Capture from `device` into `out_path` as a mono WAV.

    Returns (rate, backend, problems). With `rate=None` the device's own rate
    is used and no resampling happens anywhere in the capture path.
    """
    from .synth import write_wav

    sig, rate, backend, problems = capture_samples(
        device, rate, max_seconds, backend)
    if sig.size < int(0.05 * max(rate, 1)):
        raise RuntimeError("capture produced no audio.")
    write_wav(out_path, sig, rate)
    return rate, backend, problems
