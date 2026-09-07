"""Command-line interface for cw-decoder."""

from __future__ import annotations

import argparse
import json
import os
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


def _mark(ok: bool) -> str:
    return "OK" if ok else "**"


def _print_analysis(a: core.Analysis) -> None:
    ref, m = a.ref, a.measured
    e = sys.stdout

    def wpm_line(label, actual, target):
        diff = actual - target
        sign = "+" if diff >= 0 else ""
        print(f"#   {label:16s}: {actual:5.1f} wpm  (target {target:.1f}, "
              f"{sign}{diff:.1f})  {_mark(abs(diff) <= max(1.0, 0.08*target))}", file=e)

    print("# ===== practice report =====", file=e)
    wpm_line("character speed", m.char_wpm, ref.char_wpm)
    wpm_line("overall speed", m.farnsworth_wpm, ref.farnsworth_wpm)
    print(f"#   target unit     : {ref.unit_sec*1000:.1f} ms/dit", file=e)
    print("#", file=e)
    print("#   element / spacing (in target units; 'OK' within "
          f"{a.tolerance*100:.0f}%):", file=e)
    labels = {"dit": "dit", "dah": "dah", "element-gap": "intra-char gap",
              "char-gap": "character gap", "word-gap": "word gap"}
    for s in a.stats:
        ok = abs(s.mean_units - s.target_units) <= a.tolerance * s.target_units
        print(f"#     {labels[s.name]:15s}: {s.mean_units:4.2f}u avg  "
              f"(target {s.target_units:.2f})  jitter ±{s.std_units:.2f}u  "
              f"n={s.n:<3d} {_mark(ok)}", file=e)
    print("#", file=e)
    print(f"#   consistency     : {a.within_tol_frac*100:.0f}% of elements "
          "within tolerance", file=e)
    if a.n_pauses:
        print(f"#   ({a.n_pauses} long inter-transmission pause(s) ignored)",
              file=e)
    if a.deviations:
        print("#   largest deviations:", file=e)
        for d in a.deviations:
            ctx = f' after "{d.context}"' if d.context else ""
            print(f"#     t={d.time_sec:6.2f}s  {d.kind:12s} "
                  f"{d.value_units:5.2f}u (target {d.target_units:.2f}){ctx}",
                  file=e)
    else:
        print("#   no significant spacing deviations. clean sending!", file=e)
    print("# ---", file=e)


def _print_comparison(c: core.Comparison, source: "str | None" = None) -> None:
    e = sys.stdout
    errors = c.substitutions + c.insertions + c.deletions
    print("# ===== accuracy vs intended text =====", file=e)
    if source:
        print(f"#   source   : {source}", file=e)
    print(f"#   accuracy : {c.accuracy*100:.1f}%  "
          f"({errors} error(s) in {c.n_expected} symbols: "
          f"{c.substitutions} sub, {c.insertions} extra, {c.deletions} missed)",
          file=e)
    print("#   diff ([exp→got] substitution, [+extra], [-missed]):", file=e)
    for line in _wrap(c.diff, 72):
        print(f"#     {line}", file=e)
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


def _print_result(res: core.Result, verbose: bool,
                  comparison: "core.Comparison | None" = None,
                  comparison_source: "str | None" = None) -> None:
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
            _print_analysis(res.analysis)
        if comparison is not None:
            _print_comparison(comparison, comparison_source)
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
    p.add_argument("-e", "--expected", metavar="TEXTFILE", default=None,
                   help="file containing the intended message; the decode is "
                        "compared against it and scored for accuracy.")
    p.add_argument("-q", "--quiet", action="store_true",
                   help="print only the decoded text (no report).")
    p.add_argument("--json", action="store_true",
                   help="emit a structured JSON report to stdout (and nothing "
                        "else). Includes the decoded text, speeds, grading, and "
                        "accuracy.")
    p.add_argument("--demo", metavar="TEXT", nargs="?", const="CQ CQ DE W1AW K",
                   help="decode a synthesized signal of TEXT instead of a file "
                        "(round-trip self-test).")
    p.add_argument("--demo-wpm", type=float, default=20.0,
                   help="character speed for --demo (default 20).")
    p.add_argument("--demo-farnsworth", type=float, default=None,
                   help="overall Farnsworth speed for --demo.")
    p.add_argument("--demo-noise", type=float, default=0.0,
                   help="additive noise level for --demo (e.g. 0.2).")

    live = p.add_argument_group("live capture (trainer)")
    live.add_argument("--listen", action="store_true",
                      help="capture from an audio input device instead of a "
                           "file: key your message, then it decodes and grades.")
    live.add_argument("--list-devices", action="store_true",
                      help="list available audio input devices and exit.")
    live.add_argument("-D", "--device", type=int, default=None,
                      help="audio input device index for --listen "
                           "(see --list-devices).")
    live.add_argument("--duration", type=float, default=30.0,
                      help="maximum capture length in seconds; recording also "
                           "stops early when you press Enter (default 30). This "
                           "cap prevents a runaway recording filling the disk.")
    live.add_argument("--save", metavar="WAVFILE", default=None,
                      help="keep the captured audio at this path (default: "
                           "discard after decoding).")
    args = p.parse_args(argv)

    verbose = not args.quiet
    tol = max(args.tolerance, 0.0) / 100.0

    def emit(res, comparison, source):
        if args.json:
            print(json.dumps(_build_report(res, comparison, source), indent=2))
        else:
            _print_result(res, verbose, comparison, source)

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

    # Load the intended text, if explicitly given.
    expected = None
    expected_source = None
    if args.expected is not None:
        try:
            with open(args.expected, encoding="utf-8") as fh:
                expected = fh.read()
            expected_source = args.expected
        except OSError as e:
            print(f"error: cannot read --expected file: {e}", file=sys.stderr)
            return 1

    # --- live capture (trainer) ------------------------------------------ #
    if args.listen:
        from . import capture

        device = args.device
        try:
            if device is None:
                devices = capture.list_audio_devices()
                if not devices:
                    print("no audio input devices found.", file=sys.stderr)
                    return 1
                print("audio input devices:", file=sys.stderr)
                for idx, name in devices:
                    print(f"  [{idx}] {name}", file=sys.stderr)
                if not sys.stdin.isatty():
                    print("error: specify a device with -D/--device.",
                          file=sys.stderr)
                    return 1
                print("select device index: ", end="", file=sys.stderr, flush=True)
                device = int(input().strip())

            if args.save:
                out_path, keep = args.save, True
            else:
                fd, out_path = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                keep = False

            if expected:
                print("#", file=sys.stderr)
                print("# send this:", file=sys.stderr)
                print(f"#   {' '.join(expected.split())}", file=sys.stderr)
                print("#", file=sys.stderr)
            else:
                print("# (no target text given — pass -e FILE to be graded)",
                      file=sys.stderr)

            print(f"# recording from device {device} — key your message, then "
                  f"press Enter to stop (auto-stops after {args.duration:g}s).",
                  file=sys.stderr)

            try:
                capture.record(device, out_path, rate=args.rate,
                               max_seconds=args.duration)
                res = core.decode_file(out_path, tone=args.tone,
                                       target_rate=args.rate,
                                       bandwidth=args.bandwidth,
                                       target_wpm=args.target_wpm,
                                       target_farnsworth=args.target_farnsworth,
                                       tolerance=tol)
            finally:
                if not keep and os.path.exists(out_path):
                    os.unlink(out_path)
        except (RuntimeError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

        if args.save and verbose:
            print(f"# saved recording to {args.save}", file=sys.stderr)
        comparison = (core.compare_text(expected, res.text)
                      if expected else None)
        emit(res, comparison, expected_source)
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
                                   tolerance=tol)
        # For a demo, compare against the demo text unless a file was supplied.
        if expected is not None:
            cmp_target, cmp_source = expected, expected_source
        else:
            cmp_target, cmp_source = args.demo, "--demo text"
        comparison = core.compare_text(cmp_target, res.text)
        if args.json:
            print(json.dumps(_build_report(res, comparison, cmp_source), indent=2))
            return 0
        if verbose:
            print(f"# demo input     : {args.demo!r}")
        _print_result(res, verbose, comparison, cmp_source)
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
                               tolerance=tol)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    comparison = core.compare_text(expected, res.text) if expected else None
    if args.json:
        print(json.dumps(_build_report(res, comparison, expected_source),
                         indent=2))
        return 0
    _print_result(res, verbose, comparison, expected_source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
