"""Command-line interface for cw-decoder."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import threading

from . import core


def _build_report(res: core.Result,
                  comparison: "core.Comparison | None",
                  comparison_source: "str | None" = None,
                  source: "str | None" = None) -> dict:
    """Assemble a JSON-serializable report from a decode result.

    The shape is shared with the review page's "JSON report" download, so a
    directory of these is one time series whether the runs came from the
    terminal or the browser — hence the provenance keys up front: a dump that
    can't say what it decoded or when is no use for tracking a trend.
    """
    from datetime import datetime, timezone

    t = res.timing
    report = {
        "source": source,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "text": res.text,
        "tone_hz": round(res.tone_hz, 1),
        "sample_rate": res.rate,
        "measured": {
            "char_wpm": round(t.char_wpm, 2),
            "farnsworth_wpm": round(t.farnsworth_wpm, 2),
            "unit_ms": round(t.unit_sec * 1000, 2),
        },
        "target": None,
        "analysis": None,
        "comparison": None,
    }
    a = res.analysis
    if a is not None:
        report["target"] = {
            "char_wpm": round(a.ref.char_wpm, 2),
            "farnsworth_wpm": round(a.ref.farnsworth_wpm, 2),
            "unit_ms": round(a.ref.unit_sec * 1000, 2),
        }
        report["analysis"] = {
            "tolerance": a.tolerance,
            "within_tolerance_frac": round(a.within_tol_frac, 4),
            "pauses_ignored": a.n_pauses,
            "elements": [
                {
                    "name": s.name,
                    "n": s.n,
                    "mean_units": round(s.mean_units, 3),
                    "std_units": round(s.std_units, 3),
                    "target_units": round(s.target_units, 3),
                    "ok": abs(s.mean_units - s.target_units)
                          <= a.tolerance * s.target_units,
                }
                for s in a.stats
            ],
            "deviations": [
                {
                    "time_sec": round(d.time_sec, 2),
                    "kind": d.kind,
                    "value_units": round(d.value_units, 2),
                    "target_units": round(d.target_units, 2),
                    "context": d.context,
                }
                for d in a.deviations
            ],
        }
    if comparison is not None:
        c = comparison
        report["comparison"] = {
            "expected_source": comparison_source,
            "accuracy": round(c.accuracy, 4),
            "n_expected": c.n_expected,
            "substitutions": c.substitutions,
            "insertions": c.insertions,
            "deletions": c.deletions,
            "diff": c.diff,
        }
    return report


_ANSI = {"green": "\033[32m", "yellow": "\033[33m", "red": "\033[31m",
         "bold": "\033[1m", "reset": "\033[0m"}


class _Palette:
    """Wraps text in ANSI colors, or passes it through when disabled."""

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def __call__(self, text, color):
        if not self.enabled or not color:
            return text
        return f"{_ANSI[color]}{text}{_ANSI['reset']}"


def _color_enabled(mode: str) -> bool:
    if mode == "never":
        return False
    if mode == "always":
        return True
    # auto: colorize only on a real terminal, and respect NO_COLOR.
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _grade(dev_ratio: float, tol: float):
    """Map a deviation ratio to a (marker, color): green OK / yellow ~ / red **."""
    if dev_ratio <= tol:
        return "OK", "green"
    if dev_ratio <= 2 * tol:
        return "~", "yellow"
    return "**", "red"


def _colorize_diff(line: str, pal: "_Palette") -> str:
    """Paint the bracketed error annotations ([..]) red; leave correct text."""
    if not pal.enabled:
        return line
    return re.sub(r"\[[^\]]*\]", lambda m: pal(m.group(0), "red"), line)


def _print_analysis(a: core.Analysis, pal: "_Palette") -> None:
    ref, m = a.ref, a.measured
    e = sys.stdout

    def wpm_line(label, actual, target):
        diff = actual - target
        sign = "+" if diff >= 0 else ""
        base = max(1.0, 0.08 * target)
        marker, color = _grade(abs(diff), base)
        print(f"#   {label:16s}: {actual:5.1f} wpm  (target {target:.1f}, "
              f"{sign}{diff:.1f})  {pal(marker, color)}", file=e)

    print(pal("# ===== practice report =====", "bold"), file=e)
    wpm_line("character speed", m.char_wpm, ref.char_wpm)
    wpm_line("overall speed", m.farnsworth_wpm, ref.farnsworth_wpm)
    print(f"#   target unit     : {ref.unit_sec*1000:.1f} ms/dit", file=e)
    print("#", file=e)
    print("#   element / spacing (in target units; 'OK' within "
          f"{a.tolerance*100:.0f}%):", file=e)
    labels = {"dit": "dit", "dah": "dah", "element-gap": "intra-char gap",
              "char-gap": "character gap", "word-gap": "word gap"}
    for s in a.stats:
        dev = abs(s.mean_units - s.target_units) / s.target_units \
            if s.target_units else 0.0
        marker, color = _grade(dev, a.tolerance)
        avg = pal(f"{s.mean_units:4.2f}u", color)
        print(f"#     {labels[s.name]:15s}: {avg} avg  "
              f"(target {s.target_units:.2f})  jitter ±{s.std_units:.2f}u  "
              f"n={s.n:<3d} {pal(marker, color)}", file=e)
    print("#", file=e)
    frac = a.within_tol_frac
    fcolor = "green" if frac >= 0.9 else "yellow" if frac >= 0.75 else "red"
    print(f"#   consistency     : {pal(f'{frac*100:.0f}%', fcolor)} of elements "
          "within tolerance", file=e)
    if a.n_pauses:
        print(f"#   ({a.n_pauses} long inter-transmission pause(s) ignored)",
              file=e)
    if a.deviations:
        print("#   largest deviations:", file=e)
        for d in a.deviations:
            ctx = f' after "{d.context}"' if d.context else ""
            print(f"#     t={d.time_sec:6.2f}s  {d.kind:12s} "
                  f"{pal(f'{d.value_units:5.2f}u', 'red')} "
                  f"(target {d.target_units:.2f}){ctx}", file=e)
    else:
        print(pal("#   no significant spacing deviations. clean sending!",
                  "green"), file=e)
    print("# ---", file=e)


def _print_comparison(c: core.Comparison, source: "str | None",
                      pal: "_Palette") -> None:
    e = sys.stdout
    errors = c.substitutions + c.insertions + c.deletions
    print(pal("# ===== accuracy vs intended text =====", "bold"), file=e)
    if source:
        print(f"#   source   : {source}", file=e)
    acc = c.accuracy
    acolor = "green" if acc >= 0.95 else "yellow" if acc >= 0.85 else "red"
    print(f"#   accuracy : {pal(f'{acc*100:.1f}%', acolor)}  "
          f"({errors} error(s) in {c.n_expected} symbols: "
          f"{c.substitutions} sub, {c.insertions} extra, {c.deletions} missed)",
          file=e)
    print("#   diff ([exp→got] substitution, [+extra], [-missed]):", file=e)
    for line in _wrap(c.diff, 72):
        print(f"#     {_colorize_diff(line, pal)}", file=e)
    print("# ---", file=e)


def _wrap(s: str, width: int):
    out, line = [], ""
    for word in s.split(" "):
        if line and len(line) + 1 + len(word) > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out or [""]


def _session_dir() -> str:
    """A fresh timestamped directory under ~/.cw-decoder/sessions."""
    from datetime import datetime

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(_state_dir(), "sessions", stamp)
    os.makedirs(path, exist_ok=True)
    return path


def _discard(audio_path: str, page_path: "str | None") -> None:
    """Clean up an abandoned take: the recording, and the session directory if
    we were the ones who made it (never a path the user chose)."""
    try:
        if audio_path and os.path.exists(audio_path):
            os.unlink(audio_path)
    except OSError:
        pass
    if not page_path:
        return
    try:
        session = os.path.dirname(page_path)
        if os.path.isdir(session) and not os.listdir(session):
            os.rmdir(session)
    except OSError:
        pass


def _trim_capture(path: str, rate: int, pad: float, tone: "float | None",
                  bandwidth: float, verbose: bool) -> None:
    """Rewrite `path` with the dead air at each end cut back to `pad` seconds.

    Done in place on the capture, before decoding, so the trimmed audio is what
    gets decoded, saved, and embedded in the review page — and the review
    timeline starts at your keying instead of after a long lead-in.
    """
    from . import synth

    try:
        sig = core.load_audio(path, rate, normalize=False)
    except (RuntimeError, OSError, ValueError):
        return
    trimmed, lead = core.trim_silence(sig, rate, pad=pad, tone=tone,
                                      bandwidth=bandwidth)
    cut = (sig.size - trimmed.size) / float(rate) if rate else 0.0
    if cut <= 0.05:
        return                     # nothing worth rewriting the file for
    synth.write_wav(path, trimmed, rate)
    if verbose:
        print(f"# trimmed {cut:.1f}s of dead air "
              f"({lead:.1f}s lead, {cut - lead:.1f}s tail), "
              f"keeping {pad:g}s padding", file=sys.stderr)


def _warn_dropouts(path: str, rate: int, backend: str = "") -> None:
    """Tell the user if the capture has dropped samples.

    A dropped buffer clicks, shortens whatever element it lands in, and — since
    the unit estimate averages the dit with a third of the dah — reads back as
    faster sending than was keyed. Nothing else reports it and it is hard to
    catch by ear, so say it out loud.
    """
    if not os.path.exists(path):
        return
    try:
        # At the file's own rate: resampling smooths the splice and hides it.
        sig = core.load_audio(path, rate, normalize=False)
    except (RuntimeError, OSError, ValueError):
        return
    hits = core.find_dropouts(sig, rate)
    if not hits:
        return
    secs = sig.size / rate if rate else 0.0
    where = ", ".join(f"{t:.2f}s" for t in hits[:6])
    if len(hits) > 6:
        where += ", ..."
    print(f"# warning: {len(hits)} dropped audio buffer(s) in this capture "
          f"({len(hits) / secs:.1f}/s) at {where}", file=sys.stderr)
    print("#   Dropped samples click, shorten dits/dahs, and inflate the "
          "measured speed.", file=sys.stderr)
    if backend == "ffmpeg":
        # This is ffmpeg's avfoundation audio path, not our use of it: it drops
        # buffers even with the queue raised and every conversion removed.
        print("#   The ffmpeg backend is known to do this; the portaudio "
              "backend buffers properly.", file=sys.stderr)
        print("#   It ships with cw-decoder, so this means PortAudio failed "
              "to load — see", file=sys.stderr)
        print("#   'cw-decode --list-devices --capture-backend portaudio' "
              "for the reason.", file=sys.stderr)
    else:
        print("#   Try a different input device, close other audio apps, or "
              "record externally", file=sys.stderr)
        print("#   and pass the file instead of using --live.",
              file=sys.stderr)


def _wait_for_interrupt() -> None:
    """Block until Ctrl-C. Factored out so a test can serve without hanging."""
    threading.Event().wait()


def _review_dir(out: "str | None") -> str:
    """Where the session bundle goes, with its directory created."""
    path = os.path.abspath(out) if out else _session_dir()
    os.makedirs(path, exist_ok=True)
    return path


def _emit_web_review(res: core.Result, source: str, expected: "str | None",
                     expected_source: "str | None", tolerance: float,
                     page_path: str, audio_path: "str | None" = None,
                     verbose: bool = True,
                     pad_sec: float = core.TRIM_PAD,
                     target_wpm: "float | None" = None,
                     target_farnsworth: "float | None" = None,
                     app_dir: "str | None" = None,
                     open_browser: bool = True) -> None:
    """Write the session bundle, then serve the browser app over it.

    The CLI does its own DSP and hands over *segments*; the grading, the chart
    and the report all live in the app. That is what keeps a session reviewed
    from the terminal and one recorded in the browser from ever disagreeing —
    there is one implementation of the analysis, not two kept in step by hand.

    `tolerance` is deliberately not in the bundle: it is a control in the
    review, not a property of the recording, and baking one in would make two
    dumps of the same session incomparable for no reason.
    """
    import webbrowser

    from . import bundle as bundle_mod
    from . import serve as serve_mod

    session_dir = page_path
    bundle_path = bundle_mod.write(
        session_dir, res, source=source, audio_path=audio_path,
        expected=expected, expected_source=expected_source,
        pad_sec=pad_sec, target_wpm=target_wpm,
        target_farnsworth=target_farnsworth)

    app = serve_mod.find_app_dir(app_dir)
    if app is None:
        print(f"# session written: {bundle_path}", file=sys.stderr)
        print("# (no built app found — run `npm install && npm run build`, "
              "then re-run to open the review)", file=sys.stderr)
        return

    server = serve_mod.serve(session_dir, app).start()
    if verbose:
        size = os.path.getsize(bundle_path) / 1024
        print(f"# review: {server.url}  ({size:.0f} KB session in "
              f"{session_dir})", file=sys.stderr)
        print("# Ctrl-C when you are done with the page.", file=sys.stderr)
    if open_browser:
        webbrowser.open(server.url)
    try:
        # The page is useless once the server stops, so the process waits here
        # rather than exiting and leaving a dead tab open.
        _wait_for_interrupt()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


# `-D` values that mean "forget what you remembered and ask me again". `?` is
# the obvious spelling but it's a glob in zsh, so accept words too.
_RESELECT = {"?", "ask", "list", "select"}


def _state_dir() -> str:
    """Where per-user state lives. Resolved per call, not at import, so a test
    (or a caller) can redirect it by setting HOME."""
    return os.path.join(os.path.expanduser("~"), ".cw-decoder")


def _config_path() -> str:
    return os.path.join(_state_dir(), "config.json")


def _load_config() -> dict:
    try:
        with open(_config_path(), encoding="utf-8") as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_config(cfg: dict) -> None:
    try:
        path = _config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
    except OSError:
        pass          # remembering is a convenience; never fail a run over it


def _remembered_device(backend: str) -> "str | None":
    got = _load_config().get("devices", {}).get(backend)
    return got if isinstance(got, str) else None


def _remember_device(backend: str, name: str) -> None:
    """Store the device *by name*: indices shift when hardware comes and goes."""
    cfg = _load_config()
    cfg.setdefault("devices", {})[backend] = name
    _save_config(cfg)


def _match_device(devices, spec: str):
    """Resolve `-D` — an index, or a device name (or part of one).

    Returns (index, error). Names are matched case-insensitively, preferring an
    exact match, so a substring that hits several devices is reported rather
    than guessed at.
    """
    s = str(spec).strip()
    if re.fullmatch(r"\d+", s):
        idx = int(s)
        if devices and not any(d.index == idx for d in devices):
            return None, (f"no device with index {idx}. "
                          "Use --list-devices to see what's available.")
        return idx, None
    low = s.lower()
    exact = [d for d in devices if d.name.lower() == low]
    if exact:
        return exact[0].index, None
    hits = [d for d in devices if low in d.name.lower()]
    if len(hits) == 1:
        return hits[0].index, None
    if len(hits) > 1:
        names = ", ".join(f"[{d.index}] {d.name}" for d in hits)
        return None, f"{spec!r} matches several devices: {names}"
    return None, (f"no device matching {spec!r}. "
                  "Use --list-devices to see what's available.")


def _resolve_device(device, capture, backend="auto", use_saved=True,
                    devices=None):
    """Return an audio input device index, or None (after printing an error).

    Order of preference: an explicit `-D`, then the device remembered from last
    time (matched by name, so it survives re-indexing), then a prompt.
    """
    if devices is None:
        devices = capture.list_audio_devices(backend)
    if not devices:
        print("no audio input devices found.", file=sys.stderr)
        return None

    if device is not None:
        idx, err = _match_device(devices, device)
        if err:
            print(f"error: {err}", file=sys.stderr)
        return idx

    if use_saved:
        saved = _remembered_device(backend)
        if saved:
            hit = next((d for d in devices if d.name == saved), None)
            if hit:
                print(f"# using remembered device [{hit.index}] {hit.label()}"
                      f"  (-D ask to choose again)", file=sys.stderr)
                return hit.index
            print(f"# remembered device is not available: {saved}",
                  file=sys.stderr)

    # Name the backend: indices are backend-specific, so a list from one is
    # meaningless to the other.
    print(f"audio input devices ({capture.resolve_backend(backend)}):",
          file=sys.stderr)
    for d in devices:
        print(f"  [{d.index}] {d.label()}", file=sys.stderr)
    if not sys.stdin.isatty():
        print("error: specify a device with -D/--device.", file=sys.stderr)
        return None
    print("select device index: ", end="", file=sys.stderr, flush=True)
    try:
        idx, err = _match_device(devices, input().strip())
    except EOFError:
        print("error: invalid device index.", file=sys.stderr)
        return None
    if err:
        print(f"error: {err}", file=sys.stderr)
    return idx


def _send_header(expected) -> None:
    if expected:
        print("#\n# send this:", file=sys.stderr)
        print(f"#   {' '.join(expected.split())}", file=sys.stderr)
        print("#", file=sys.stderr)
    else:
        print("# no target message — send anything (add -e to score against one)",
              file=sys.stderr)


def _print_result(res: core.Result, verbose: bool,
                  comparison: "core.Comparison | None" = None,
                  comparison_source: "str | None" = None,
                  pal: "_Palette | None" = None) -> None:
    pal = pal or _Palette(False)
    t = res.timing
    if verbose:
        print(f"# tone           : {res.tone_hz:.1f} Hz")
        if res.analysis is None:
            print(f"# dit length     : {t.unit_sec * 1000:.1f} ms")
            print(f"# character speed: {t.char_wpm:.1f} wpm "
                  f"({t.char_wpm * 5:.0f} cpm)")
            print(f"# overall speed  : {t.farnsworth_wpm:.1f} wpm (Farnsworth)")
            for note in t.notes:
                print(f"# {note}")
            print("# ---")
        else:
            _print_analysis(res.analysis, pal)
        if comparison is not None:
            _print_comparison(comparison, comparison_source, pal)
    print(res.text)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="cw-decode",
        description="Decode Morse code (CW) into text and grade the keying. "
                    "With no input file it records from an audio device; "
                    "either way it opens an interactive review page. See "
                    "--basic and --json for terminal output.",
    )
    p.add_argument("input", nargs="?",
                   help="audio file to decode (wav/mp3/flac/m4a/ogg/...); "
                        "non-WAV requires ffmpeg. Omit it to record live "
                        "instead.")
    p.add_argument("-t", "--tone", type=float, default=None,
                   help="CW tone frequency in Hz (default: auto-detect).")
    p.add_argument("-b", "--bandwidth", type=float, default=200.0,
                   help="bandpass half-width around the tone, Hz (default 200).")
    p.add_argument("-r", "--rate", type=int, default=core.TARGET_RATE,
                   help=f"internal sample rate (default {core.TARGET_RATE}).")
    p.add_argument("-w", "--target-wpm", type=float, default=None,
                   help="target character speed (wpm). Decodes against this ideal "
                        "timing and prints a practice report grading your keying.")
    p.add_argument("-f", "--target-farnsworth", type=float, default=None,
                   help="target overall Farnsworth speed (wpm); defaults to "
                        "--target-wpm. Only meaningful with --target-wpm.")
    p.add_argument("-T", "--tolerance", type=float, default=30.0,
                   help="grading tolerance in percent for the practice report "
                        "(default 30). Smaller = stricter.")
    p.add_argument("-e", "--expected", metavar="TEXT|FILE", default=None,
                   help="the intended message, as literal text or a path to a "
                        "text file (an existing file is read; otherwise the "
                        "value is the message). The decode is scored against it.")
    p.add_argument("-q", "--quiet", action="store_true",
                   help="print only the decoded text: no report, no review "
                        "page.")
    p.add_argument("--json", action="store_true",
                   help="emit a structured JSON report to stdout instead of "
                        "opening the review page. Includes the decoded text, "
                        "speeds, grading, and accuracy — the same shape the "
                        "page's 'JSON report' download writes, so terminal and "
                        "browser runs can go in one trend file.")
    p.add_argument("--basic", action="store_true",
                   help="print the practice report to the terminal instead of "
                        "opening the review page.")
    p.add_argument("--color", choices=["auto", "always", "never"], default="auto",
                   help="colorize the report: auto (only on a terminal; also "
                        "honors NO_COLOR), always, or never.")
    p.add_argument("--demo", metavar="TEXT", nargs="?", const="CQ CQ DE W1AW K",
                   help="decode a synthesized signal of TEXT instead of a file "
                        "(round-trip self-test).")
    p.add_argument("--demo-wpm", type=float, default=20.0,
                   help="character speed for --demo (default 20).")
    p.add_argument("--demo-farnsworth", type=float, default=None,
                   help="overall Farnsworth speed for --demo.")
    p.add_argument("--demo-noise", type=float, default=0.0,
                   help="additive noise level for --demo (e.g. 0.2).")

    web = p.add_argument_group("web review (the default output)")
    web.add_argument("--web-review", action="store_true",
                     help="open the browser trainer on this recording — your "
                          "keying drawn against perfect timing, with spacing "
                          "annotated, playable side by side, and re-gradable "
                          "at any speed. This is what happens by default; "
                          "pass it explicitly only to get the review as well "
                          "as --json or --basic.")
    web.add_argument("--web-out", metavar="DIR", default=None,
                     help="write the session bundle here (implies "
                          "--web-review). Default: "
                          "~/.cw-decoder/sessions/<timestamp>/")
    web.add_argument("--app-dir", metavar="DIR", default=None,
                     help="the built browser app to serve (default: the "
                          "dist/ directory beside this checkout). Build it "
                          "with `npm install && npm run build`.")
    web.add_argument("--no-open", action="store_true",
                     help="serve the review but don't launch a browser; the "
                          "URL is printed instead.")

    live = p.add_argument_group("live capture (trainer)")
    live.add_argument("--live", action="store_true",
                      help="capture from an audio input device (live keying) "
                           "instead of decoding a file, then decode and grade. "
                           "This is what happens by default when no input file "
                           "is given, so the flag is only needed to be "
                           "explicit.")
    live.add_argument("--preview", action="store_true",
                      help="on a live capture, also print the decode in real "
                           "time as you key (requires -w for timing).")
    live.add_argument("--list-devices", action="store_true",
                      help="list available audio input devices and exit.")
    live.add_argument("-D", "--device", default=None,
                      help="audio input device for --live: an index from "
                           "--list-devices, or the device's name (or any "
                           "unambiguous part of it, case-insensitive). "
                           "Whatever you use is remembered by name for next "
                           "time, so it survives re-indexing when hardware "
                           "comes and goes. Pass '-D ask' (or -D '?') to "
                           "forget it and choose again.")
    live.add_argument("--duration", type=float, default=120.0,
                      help="maximum capture length in seconds; recording also "
                           "stops early when you press Enter, or starts over on "
                           "Ctrl-R (default 120). "
                           "This cap prevents a runaway recording filling the "
                           "disk.")
    live.add_argument("--capture-backend", choices=["auto", "portaudio",
                                                    "ffmpeg"], default="auto",
                      help="how to capture live audio. 'portaudio' buffers "
                           "generously and reports input "
                           "overflows; 'ffmpeg' is the macOS-only fallback and "
                           "drops buffers on some devices. Default: portaudio "
                           "when available. Device indices differ between "
                           "backends — list and select with the same one.")
    live.add_argument("--capture-rate", type=int, default=None,
                      help="force a capture sample rate. Default: the audio "
                           "device's own rate, with no resampling — forcing a "
                           "rate makes ffmpeg resample every sample, which "
                           "audibly roughens a keyer sidetone. The decoder "
                           "resamples to its own working rate regardless, so "
                           "this only affects the saved/played-back audio.")
    live.add_argument("--trim-pad", type=float, default=core.TRIM_PAD,
                      metavar="SEC",
                      help=f"seconds of dead air to keep at each end of a live "
                           f"capture; the rest is trimmed off (default "
                           f"{core.TRIM_PAD:g}).")
    live.add_argument("--no-trim", action="store_true",
                      help="keep a live capture exactly as recorded, including "
                           "the dead air before and after your keying.")
    live.add_argument("--save", metavar="WAVFILE", default=None,
                      help="keep the captured audio at this path (default: "
                           "discard after decoding).")
    args = p.parse_args(argv)

    verbose = not args.quiet
    tol = max(args.tolerance, 0.0) / 100.0

    if args.json and args.basic:
        p.error("--json and --basic are two different reports; pick one")

    # Both defaults point at the interactive path, because that's where the
    # tool earns its keep: the review page is the report worth reading, and
    # live keying is what there is to review. An input file opts out of the
    # capture; --json, --basic or -q opt out of the page. --web-review and
    # --web-out ask for the page back explicitly, so one run can produce a JSON
    # dump *and* a page.
    want_page = (args.web_review or args.web_out is not None
                 or not (args.json or args.basic or args.quiet))
    want_live = args.live or (args.input is None and args.demo is None)

    if args.live and args.input:
        p.error("--live captures from an audio device — don't also pass an "
                "input file")
    if args.preview and not want_live:
        p.error("--preview only applies to a live capture")

    pal = _Palette(_color_enabled(args.color))

    # When the review page is built, the page *is* the practice report, so
    # don't also dump it to the terminal — the decoded text still prints, as do
    # the stderr lines naming the files written. --basic asks for the terminal
    # report by name, so it gets it either way; --json is an explicit
    # machine-readable request and is unaffected.
    report = verbose and (args.basic or not want_page)

    # Resolved up front: a live capture records straight into this directory,
    # so it has to exist before recording starts.
    page_path = _review_dir(args.web_out) if want_page else None

    def emit(res, comparison, exp_source, source):
        if args.json:
            print(json.dumps(_build_report(res, comparison, exp_source,
                                           source), indent=2))
        else:
            _print_result(res, report, comparison, exp_source, pal)

    # --- list audio devices and exit ------------------------------------- #
    if args.list_devices:
        from . import capture
        try:
            backend = capture.resolve_backend(args.capture_backend)
            devices = capture.list_audio_devices(backend)
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        if not devices:
            print("no audio input devices found.", file=sys.stderr)
            return 1
        others = [b for b in capture.available_backends() if b != backend]
        print(f"audio input devices ({backend}):")
        for idx, name in devices:
            print(f"  [{idx}] {name}")
        if others:
            print(f"# indices are {backend}-specific; also available: "
                  f"{', '.join(others)} (--capture-backend)", file=sys.stderr)
        return 0

    # Resolve the intended text, if explicitly given: a path to an existing file
    # is read; otherwise the value is used as the literal message text.
    expected = None
    expected_source = None
    if args.expected is not None:
        if os.path.isfile(args.expected):
            try:
                with open(args.expected, encoding="utf-8") as fh:
                    expected = fh.read()
                expected_source = args.expected
            except OSError as e:
                print(f"error: cannot read --expected file: {e}", file=sys.stderr)
                return 1
        elif args.expected.lower().endswith(".txt"):
            # Looks like a filename but doesn't exist — almost certainly a typo,
            # not an intended literal message. Fail loudly rather than silently
            # grading against the path string.
            print(f"error: --expected file not found: {args.expected}",
                  file=sys.stderr)
            return 1
        else:
            expected = args.expected
            expected_source = "(inline text)"

    # --- live capture (trainer) ------------------------------------------ #
    if want_live:
        from . import capture

        if args.preview and args.target_wpm is None:
            print("error: --preview requires a target speed (-w/--target-wpm).",
                  file=sys.stderr)
            return 1

        try:
            backend = capture.resolve_backend(args.capture_backend)
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

        # `-D ask` (or -D '?') forgets the remembered device and asks again.
        # Both spellings, because `?` is a glob in zsh and needs quoting.
        reselect = str(args.device).strip().lower() in _RESELECT
        if reselect:
            cfg = _load_config()
            if cfg.get("devices", {}).pop(backend, None) is not None:
                _save_config(cfg)

        devices = capture.list_audio_devices(backend)
        device = _resolve_device(None if reselect else args.device,
                                 capture, backend, use_saved=not reselect,
                                 devices=devices)
        if device is None:
            return 1
        device_name = next((d.name for d in devices if d.index == device), None)

        # None means "the device's native rate, no resampling"; the actual
        # rate is read back off the capture afterwards.
        cap_rate = args.capture_rate

        if args.save:
            out_path, keep = args.save, True
        elif want_page:
            # Record straight into the session directory: the page needs the
            # audio to embed, and a live take is worth keeping as a plain WAV
            # anyway. Nothing to copy, nothing deleted out from under us.
            out_path = os.path.join(os.path.dirname(page_path), "session.wav")
            keep = True
        else:
            fd, out_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            keep = False

        try:
            _send_header(expected)

            def on_restart(n):
                # Return to the start of the line and wipe it, so this lands
                # cleanly instead of after a half-written preview decode.
                if sys.stderr.isatty():
                    sys.stderr.write("\r\033[K")
                print(f"# take {n + 1}: started over, previous take "
                      "discarded.", file=sys.stderr)

            if args.preview:
                from . import stream, synth
                timing = core.target_timing(args.target_wpm,
                                            args.target_farnsworth)
                print(f"# live decode ({args.target_wpm:g} wpm) on device "
                      f"{device} — key now; Enter to stop, Ctrl-R to start "
                      f"over (auto after {args.duration:g}s).",
                      file=sys.stderr)

                def on_update(text):
                    sys.stderr.write("\r" + text + " ")
                    sys.stderr.flush()

                sig, _, cap_rate, used, problems = stream.run_live(
                    device, timing, rate=cap_rate, tone=args.tone,
                    max_seconds=args.duration, on_update=on_update,
                    dsp_rate=args.rate, backend=backend,
                    on_restart=on_restart)
                sys.stderr.write("\n")
                sys.stderr.flush()
                if sig.size < int(0.2 * cap_rate):
                    raise RuntimeError("capture produced no audio.")
                synth.write_wav(out_path, sig, cap_rate)
            else:
                print(f"# recording on device {device} ({backend}) — key your "
                      f"message, then press Enter to stop, or Ctrl-R to start "
                      f"over (auto-stops after {args.duration:g}s).",
                      file=sys.stderr)
                cap_rate, used, problems = capture.record(
                    device, out_path, rate=cap_rate,
                    max_seconds=args.duration, backend=backend,
                    on_restart=on_restart)
            # Whatever the backend noticed — PortAudio reports input overflow
            # directly, ffmpeg complains about its queue.
            for line in problems:
                print(f"# {used}: {line}", file=sys.stderr)

            # Only now that a capture actually worked is the device worth
            # remembering; memorizing one that failed would be unhelpful.
            if device_name:
                _remember_device(backend, device_name)

            if not args.no_trim:
                _trim_capture(out_path, cap_rate, args.trim_pad, args.tone,
                              args.bandwidth, verbose)

            res = core.decode_file(out_path, tone=args.tone,
                                   target_rate=args.rate,
                                   bandwidth=args.bandwidth,
                                   target_wpm=args.target_wpm,
                                   target_farnsworth=args.target_farnsworth,
                                   tolerance=tol, keep_signal=want_page,
                                   expected=expected)
        except KeyboardInterrupt:
            # Ctrl-C means abandon the take — don't decode it, don't grade it,
            # don't open a review page for it. Enter is the "I'm done" key.
            print("\n# canceled — discarding this take.", file=sys.stderr)
            _discard(out_path, page_path if not args.web_out else None)
            return 130                     # conventional exit code for SIGINT
        except (RuntimeError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        finally:
            if not keep and os.path.exists(out_path):
                os.unlink(out_path)

        if keep and verbose:
            print(f"# saved recording to {out_path} "
                  f"({cap_rate / 1000:g} kHz, {used})", file=sys.stderr)
        _warn_dropouts(out_path, cap_rate, backend=used)
        comparison = (core.compare_text(expected, res.text)
                      if expected else None)
        emit(res, comparison, expected_source, "live capture")
        if want_page:
            _emit_web_review(res, "live capture", expected, expected_source,
                             tol, page_path, audio_path=out_path,
                             verbose=verbose, pad_sec=args.trim_pad,
                             target_wpm=args.target_wpm,
                             target_farnsworth=args.target_farnsworth,
                             app_dir=args.app_dir,
                             open_browser=not args.no_open)
        return 0

    if args.demo is not None:
        from . import synth
        sig = synth.generate(
            args.demo, wpm=args.demo_wpm,
            farnsworth_wpm=args.demo_farnsworth, tone=args.tone or 600.0,
            rate=args.rate, noise=args.demo_noise,
        )
        # For a demo, compare against the demo text unless a file was supplied.
        # Resolved before decoding so the spacing is graded against it too.
        if expected is not None:
            cmp_target, cmp_source = expected, expected_source
        else:
            cmp_target, cmp_source = args.demo, "--demo text"
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tf:
            synth.write_wav(tf.name, sig, args.rate)
            res = core.decode_file(tf.name, tone=args.tone, target_rate=args.rate,
                                   bandwidth=args.bandwidth,
                                   target_wpm=args.target_wpm,
                                   target_farnsworth=args.target_farnsworth,
                                   tolerance=tol, keep_signal=want_page,
                                   expected=cmp_target)
        comparison = core.compare_text(cmp_target, res.text)
        if args.json:
            print(json.dumps(_build_report(res, comparison, cmp_source,
                                           "--demo"), indent=2))
        else:
            if report:
                print(f"# demo input     : {args.demo!r}")
            _print_result(res, report, comparison, cmp_source, pal)
        if want_page:
            _emit_web_review(res, "--demo", cmp_target, cmp_source, tol,
                             page_path, verbose=verbose,
                             target_wpm=args.target_wpm,
                             target_farnsworth=args.target_farnsworth,
                             app_dir=args.app_dir,
                             open_browser=not args.no_open)
        return 0

    # Reaching here means there is an input file: no --demo, and `want_live` is
    # false, which only happens when one was given.
    # If no --expected was given, fall back to a sibling text file with the same
    # base name as the audio (e.g. qso.wav -> qso.txt).
    if expected is None:
        sibling = os.path.splitext(args.input)[0] + ".txt"
        if os.path.isfile(sibling):
            try:
                with open(sibling, encoding="utf-8") as fh:
                    expected = fh.read()
                expected_source = sibling
            except OSError as e:
                print(f"error: cannot read {sibling}: {e}", file=sys.stderr)
                return 1

    try:
        res = core.decode_file(args.input, tone=args.tone,
                               target_rate=args.rate, bandwidth=args.bandwidth,
                               target_wpm=args.target_wpm,
                               target_farnsworth=args.target_farnsworth,
                               tolerance=tol, keep_signal=want_page,
                               expected=expected)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    comparison = core.compare_text(expected, res.text) if expected else None
    emit(res, comparison, expected_source, os.path.basename(args.input))
    if want_page:
        _emit_web_review(res, os.path.basename(args.input), expected,
                         expected_source, tol, page_path,
                         audio_path=args.input, verbose=verbose,
                         pad_sec=args.trim_pad,
                         target_wpm=args.target_wpm,
                         target_farnsworth=args.target_farnsworth,
                         app_dir=args.app_dir,
                         open_browser=not args.no_open)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
