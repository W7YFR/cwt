"""Command-line interface for cw-decoder."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import tempfile

from . import core


def _build_report(res: core.Result,
                  comparison: "core.Comparison | None",
                  comparison_source: "str | None" = None) -> dict:
    """Assemble a JSON-serializable report from a decode result."""
    t = res.timing
    report = {
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
    path = os.path.join(os.path.expanduser("~"), ".cw-decoder", "sessions",
                        stamp)
    os.makedirs(path, exist_ok=True)
    return path


def _warn_dropouts(path: str, rate: int) -> None:
    """Tell the user if the capture has dropped samples.

    A dropped buffer clicks, shortens whatever element it lands in, and — since
    the unit estimate averages the dit with a third of the dah — reads back as
    faster sending than was keyed. It used to be silent, discoverable only by
    ear, so say it out loud.
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
    print("#   Try a different input device, close other audio apps, or "
          "record externally and", file=sys.stderr)
    print("#   pass the file instead of using --live.", file=sys.stderr)


def _web_page_path(out: "str | None") -> str:
    """Where the review page goes, with its directory created."""
    if out:
        path = os.path.abspath(out)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        return path
    return os.path.join(_session_dir(), "review.html")


def _emit_web_review(res: core.Result, source: str, expected: "str | None",
                     expected_source: "str | None", tolerance: float,
                     page_path: str, audio_path: "str | None" = None,
                     verbose: bool = True) -> None:
    """Build the self-contained review page, then open it in a browser.

    `audio_path` is the original recording. The page embeds it at its own
    sample rate rather than the decoder's 8 kHz working copy, so playback
    sounds like what you recorded.
    """
    import webbrowser

    from . import review, webpage

    payload = review.build_payload(res, source=source, expected=expected,
                                   expected_source=expected_source,
                                   tolerance=tolerance, audio_path=audio_path)
    size = webpage.write(page_path, payload)
    if verbose:
        print(f"# web review: {page_path} ({size / 1024:.0f} KB, audio at "
              f"{payload['audio_rate'] / 1000:g} kHz)", file=sys.stderr)
    webbrowser.open(pathlib.Path(page_path).resolve().as_uri())


def _resolve_device(device, capture):
    """Return an audio input device index, listing/prompting if not given.

    Returns None (after printing an error) if no device can be determined.
    """
    if device is not None:
        return device
    devices = capture.list_audio_devices()
    if not devices:
        print("no audio input devices found.", file=sys.stderr)
        return None
    print("audio input devices:", file=sys.stderr)
    for idx, name in devices:
        print(f"  [{idx}] {name}", file=sys.stderr)
    if not sys.stdin.isatty():
        print("error: specify a device with -D/--device.", file=sys.stderr)
        return None
    print("select device index: ", end="", file=sys.stderr, flush=True)
    try:
        return int(input().strip())
    except (ValueError, EOFError):
        print("error: invalid device index.", file=sys.stderr)
        return None


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
        description="Decode Morse code (CW) from an audio recording into text.",
    )
    p.add_argument("input", nargs="?",
                   help="audio file (wav/mp3/flac/m4a/ogg/...). "
                        "Non-WAV requires ffmpeg.")
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
                   help="print only the decoded text (no report).")
    p.add_argument("--json", action="store_true",
                   help="emit a structured JSON report to stdout (and nothing "
                        "else). Includes the decoded text, speeds, grading, and "
                        "accuracy.")
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

    web = p.add_argument_group("web review")
    web.add_argument("--web-review", action="store_true",
                     help="also build an interactive review page — your keying "
                          "drawn on a canvas against perfect timing, with "
                          "spacing annotated — and open it in a browser. The "
                          "page is one self-contained file with the recording "
                          "embedded, so you can replay yourself, hear the "
                          "target, and re-grade at any speed offline.")
    web.add_argument("--web-out", metavar="FILE", default=None,
                     help="write the review page here (implies --web-review). "
                          "Default: ~/.cw-decoder/sessions/<timestamp>/"
                          "review.html")

    live = p.add_argument_group("live capture (trainer)")
    live.add_argument("--live", action="store_true",
                      help="capture from an audio input device (live keying) "
                           "instead of decoding a file, then decode and grade.")
    live.add_argument("--preview", action="store_true",
                      help="with --live, also print the decode in real time as "
                           "you key (requires -w for timing).")
    live.add_argument("--list-devices", action="store_true",
                      help="list available audio input devices and exit.")
    live.add_argument("-D", "--device", type=int, default=None,
                      help="audio input device index for --live "
                           "(see --list-devices).")
    live.add_argument("--duration", type=float, default=120.0,
                      help="maximum capture length in seconds; recording also "
                           "stops early when you press Enter (default 120). "
                           "This cap prevents a runaway recording filling the "
                           "disk.")
    live.add_argument("--capture-rate", type=int, default=None,
                      help="force a capture sample rate. Default: the audio "
                           "device's own rate, with no resampling — forcing a "
                           "rate makes ffmpeg resample every sample, which "
                           "audibly roughens a keyer sidetone. The decoder "
                           "resamples to its own working rate regardless, so "
                           "this only affects the saved/played-back audio.")
    live.add_argument("--save", metavar="WAVFILE", default=None,
                      help="keep the captured audio at this path (default: "
                           "discard after decoding).")
    args = p.parse_args(argv)

    verbose = not args.quiet
    tol = max(args.tolerance, 0.0) / 100.0
    web = args.web_review or args.web_out is not None

    if args.preview and not args.live:
        p.error("--preview only applies with --live")

    pal = _Palette(_color_enabled(args.color))

    # When a review page was asked for, the page *is* the practice report, so
    # don't also dump it to the terminal — the decoded text still prints, as do
    # the stderr lines naming the files written. `--json` is an explicit
    # machine-readable request and is unaffected.
    report = verbose and not web

    # Resolved up front: a live capture records straight into this directory,
    # so it has to exist before recording starts.
    page_path = _web_page_path(args.web_out) if web else None

    def emit(res, comparison, source):
        if args.json:
            print(json.dumps(_build_report(res, comparison, source), indent=2))
        else:
            _print_result(res, report, comparison, source, pal)

    # --- list audio devices and exit ------------------------------------- #
    if args.list_devices:
        from . import capture
        try:
            devices = capture.list_audio_devices()
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        if not devices:
            print("no audio input devices found.", file=sys.stderr)
            return 1
        print("audio input devices:")
        for idx, name in devices:
            print(f"  [{idx}] {name}")
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
    if args.live:
        from . import capture

        if args.preview and args.target_wpm is None:
            print("error: --preview requires a target speed (-w/--target-wpm).",
                  file=sys.stderr)
            return 1

        device = _resolve_device(args.device, capture)
        if device is None:
            return 1

        # None means "the device's native rate, no resampling"; the actual
        # rate is read back off the capture afterwards.
        cap_rate = args.capture_rate

        if args.save:
            out_path, keep = args.save, True
        elif web:
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
            if args.preview:
                from . import stream, synth
                timing = core.target_timing(args.target_wpm,
                                            args.target_farnsworth)
                print(f"# live decode ({args.target_wpm:g} wpm) on device "
                      f"{device} — key now; Enter to stop (auto after "
                      f"{args.duration:g}s).", file=sys.stderr)

                def on_update(text):
                    sys.stderr.write("\r" + text + " ")
                    sys.stderr.flush()

                sig, _, cap_rate = stream.run_live(
                    device, timing, rate=cap_rate, tone=args.tone,
                    max_seconds=args.duration, on_update=on_update,
                    dsp_rate=args.rate)
                sys.stderr.write("\n")
                sys.stderr.flush()
                if sig.size < int(0.2 * cap_rate):
                    raise RuntimeError("capture produced no audio.")
                synth.write_wav(out_path, sig, cap_rate)
            else:
                print(f"# recording on device {device} — key your message, "
                      f"then press Enter to stop (auto-stops after "
                      f"{args.duration:g}s).", file=sys.stderr)
                capture.record(device, out_path, rate=cap_rate,
                               max_seconds=args.duration)
                cap_rate = capture.wav_rate(out_path) or args.rate

            res = core.decode_file(out_path, tone=args.tone,
                                   target_rate=args.rate,
                                   bandwidth=args.bandwidth,
                                   target_wpm=args.target_wpm,
                                   target_farnsworth=args.target_farnsworth,
                                   tolerance=tol, keep_signal=web)
        except (RuntimeError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        finally:
            if not keep and os.path.exists(out_path):
                os.unlink(out_path)

        if keep and verbose:
            print(f"# saved recording to {out_path} "
                  f"({cap_rate / 1000:g} kHz)", file=sys.stderr)
        _warn_dropouts(out_path, cap_rate)
        comparison = (core.compare_text(expected, res.text)
                      if expected else None)
        emit(res, comparison, expected_source)
        if web:
            _emit_web_review(res, "live capture", expected, expected_source,
                             tol, page_path, audio_path=out_path,
                             verbose=verbose)
        return 0

    if args.demo is not None:
        from . import synth
        sig = synth.generate(
            args.demo, wpm=args.demo_wpm,
            farnsworth_wpm=args.demo_farnsworth, tone=args.tone or 600.0,
            rate=args.rate, noise=args.demo_noise,
        )
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tf:
            synth.write_wav(tf.name, sig, args.rate)
            res = core.decode_file(tf.name, tone=args.tone, target_rate=args.rate,
                                   bandwidth=args.bandwidth,
                                   target_wpm=args.target_wpm,
                                   target_farnsworth=args.target_farnsworth,
                                   tolerance=tol, keep_signal=web)
        # For a demo, compare against the demo text unless a file was supplied.
        if expected is not None:
            cmp_target, cmp_source = expected, expected_source
        else:
            cmp_target, cmp_source = args.demo, "--demo text"
        comparison = core.compare_text(cmp_target, res.text)
        if args.json:
            print(json.dumps(_build_report(res, comparison, cmp_source), indent=2))
        else:
            if report:
                print(f"# demo input     : {args.demo!r}")
            _print_result(res, report, comparison, cmp_source, pal)
        if web:
            _emit_web_review(res, "--demo", cmp_target, cmp_source, tol,
                             page_path, verbose=verbose)
        return 0

    if not args.input:
        p.error("an input file is required (or use --demo)")

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
                               tolerance=tol, keep_signal=web)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    comparison = core.compare_text(expected, res.text) if expected else None
    emit(res, comparison, expected_source)
    if web:
        _emit_web_review(res, os.path.basename(args.input), expected,
                         expected_source, tol, page_path,
                         audio_path=args.input, verbose=verbose)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
