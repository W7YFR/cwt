#!/usr/bin/env python3
"""Dump the Python decoder's answers so the TypeScript port can be held to them.

The Python implementation is not the product, but it is the one validated
against real recordings over months, so it serves as the oracle. This writes one JSON file per fixture containing both halves of the
comparison:

  segments   what the Python DSP found. The TS DSP is checked against these
             with a millisecond tolerance, because the two pipelines are
             deliberately different — Python bandpasses and Hilbert-transforms
             at 8 kHz, TypeScript quadrature-demodulates at the native rate.

  grading    everything derived *from* those segments. The TS grading is fed
             the Python segments verbatim and must match this to 1e-9, because
             it is a port rather than a reimplementation. A disagreement here
             is a bug, never a modeling difference.

Run it with `npm run oracle`, or `python3 tools/oracle.py <outdir>`.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from cw_decoder import core  # noqa: E402

# (filename, intended text, char wpm, overall wpm or None, nominal wpm)
#
# Mirrors tests/test_fixture.py. `nominal` is the speed the recording was
# actually sent at — ground truth, which neither decoder gets to see. It is
# what lets the agreement test ask "which one is right" rather than only
# "do they agree".
FIXTURES = [
    ("cq-ab1cd-20wpm-k3ng.wav", "CQ CQ DE AB1CD K", 20, 20, 20),
    ("cq-de-w7yfr.wav", "CQ DE W7YFR", 25, None, 25),
]

# Synthesized cases, so the corpus covers timing the real recordings don't:
# heavy Farnsworth, a single-letter drill, and prosigns.
# (name, text, char wpm, overall wpm)
SYNTH = [
    ("synth-farnsworth", "CQ CQ DE W1AW K", 22, 13),
    ("synth-letter-drill", "A B C D E F", 25, 14),
    ("synth-prosigns", "<BT> TEST DE W1AW <AR> <SK>", 20, 20),
    ("synth-fast", "PARIS PARIS PARIS", 35, 35),
]


def timing_dict(t: core.Timing) -> dict:
    return {
        "unitSec": t.unit_sec,
        "charWpm": t.char_wpm,
        "farnsworthWpm": t.farnsworth_wpm,
        "ditDahSplit": t.dit_dah_split,
        "elementCharSplit": t.element_char_split,
        "charWordSplit": t.char_word_split,
        "charGapSec": t.char_gap_sec,
        "wordGapSec": t.word_gap_sec,
    }


def block_dict(b: core.Block) -> dict:
    return {
        "t0": b.t0, "t1": b.t1, "kind": b.kind, "units": b.units,
        "targetUnits": b.target_units, "targetKind": b.target_kind,
        "context": b.context,
    }


def char_dict(c: core.Char) -> dict:
    return {"char": c.char, "pattern": c.pattern, "t0": c.t0, "t1": c.t1,
            "nBlocks": len(c.blocks),
            "leadGapKind": c.lead_gap.kind if c.lead_gap else None}


def timeline_dict(tl: core.Timeline) -> dict:
    return {
        "text": tl.text,
        "duration": tl.duration,
        "blocks": [block_dict(b) for b in tl.blocks],
        "chars": [char_dict(c) for c in tl.chars],
    }


def analysis_dict(a: core.Analysis) -> dict:
    return {
        "tolerance": a.tolerance,
        "withinTolFrac": a.within_tol_frac,
        "nPauses": a.n_pauses,
        "stats": [{"name": s.name, "n": s.n, "meanUnits": s.mean_units,
                   "stdUnits": s.std_units, "targetUnits": s.target_units}
                  for s in a.stats],
        "deviations": [{"timeSec": d.time_sec, "kind": d.kind,
                        "valueUnits": d.value_units,
                        "targetUnits": d.target_units, "context": d.context}
                       for d in a.deviations],
    }


def comparison_dict(c: core.Comparison) -> dict:
    return {
        "expected": c.expected, "decoded": c.decoded, "accuracy": c.accuracy,
        "nExpected": c.n_expected, "substitutions": c.substitutions,
        "insertions": c.insertions, "deletions": c.deletions, "diff": c.diff,
    }


def grading_for(segs, expected, char_wpm, farns) -> dict:
    """Everything downstream of the segments — the part that must match exactly."""
    measured = core.estimate_timing(segs, expected=expected)
    ref = core.target_timing(char_wpm, farns)

    # Both rest policies, because collapse-rests is a control in the UI and the
    # boundary it moves is exactly the kind of thing a port gets wrong.
    out = {"measured": timing_dict(measured), "ref": timing_dict(ref)}
    for label, pause_factor in (("rests", core.PAUSE_FACTOR),
                                ("noRests", float("inf"))):
        tl = core.build_timeline(segs, ref, pause_factor=pause_factor)
        # Record the timeline twice, before and after retarget. The difference
        # between them *is* what retarget does — a gap the decoder read as a
        # word gap that the intended text says was a letter gap — so dumping
        # only the second would let a port that never retargeted at all pass
        # as long as it guessed the same classes.
        out[label] = {"timeline": timeline_dict(tl)}
        retargeted = 0
        if expected:
            retargeted = core.retarget(core.pair(tl, core.ideal_timeline(expected, ref)))
        analysis = core.analyze(tl, ref, measured, tolerance=0.30)
        out[label]["retargetedTimeline"] = timeline_dict(tl)
        out[label]["retargeted"] = retargeted
        out[label]["analysis"] = analysis_dict(analysis)

    out["ideal"] = timeline_dict(core.ideal_timeline(expected or "", ref))
    if expected:
        decoded = core.build_timeline(segs, ref).text
        out["comparison"] = comparison_dict(core.compare_text(expected, decoded))
    else:
        out["comparison"] = None
    return out


def dump_case(name: str, sig, rate: int, expected: str,
              char_wpm: float, farns) -> dict:
    """Run the Python DSP, then the Python grading, and record both."""
    tone = core.detect_tone(sig, rate)
    env = core.envelope(sig, rate, tone)
    thr = core.keying_threshold(env)
    segs = core.run_lengths(env > thr, rate)
    marks = [d for s, d in segs if s == 1]
    if marks:
        import numpy as np
        segs = core.debounce(segs, min_dur=0.35 * float(np.percentile(marks, 20)))

    return {
        "name": name,
        "expected": expected,
        "charWpm": char_wpm,
        "farnsworthWpm": farns,
        "dspRate": rate,
        "toneHz": tone,
        "segments": [[int(s), d] for s, d in segs],
        "grading": grading_for(segs, expected, char_wpm, farns),
    }


def main(outdir: str) -> int:
    os.makedirs(outdir, exist_ok=True)
    data_dir = os.path.join(os.path.dirname(__file__), "..", "tests", "data")
    written = []

    for fname, expected, char_wpm, farns, nominal in FIXTURES:
        path = os.path.join(data_dir, fname)
        if not os.path.exists(path):
            print(f"skip {fname}: not present", file=sys.stderr)
            continue
        # The DSP rate stays 8 kHz here: this is what Python actually did, and
        # what the TS port is being compared against. The TS side reads the
        # same WAV at its native rate on purpose.
        sig = core.load_audio(path, core.TARGET_RATE)
        case = dump_case(fname, sig, core.TARGET_RATE, expected, char_wpm, farns)
        case["sourceWav"] = fname
        case["nominalWpm"] = nominal
        out = os.path.join(outdir, fname.replace(".wav", "") + ".json")
        with open(out, "w") as fh:
            json.dump(case, fh, indent=1)
        written.append(os.path.basename(out))

    from cw_decoder import synth
    for name, text, char_wpm, farns in SYNTH:
        sig = synth.generate(text, wpm=char_wpm, farnsworth_wpm=farns,
                             rate=core.TARGET_RATE)
        case = dump_case(name, sig, core.TARGET_RATE, text, char_wpm, farns)
        # The TS side regenerates this signal itself rather than reading a WAV,
        # so record what it takes to do that.
        # Enough of a fingerprint that the TS synthesizer can be shown to
        # produce the same waveform, not merely a waveform that decodes the
        # same. Without this a synth bug could hide behind a forgiving decoder.
        import numpy as np
        case["synth"] = {"text": text, "wpm": char_wpm, "farnsworthWpm": farns,
                         "rate": core.TARGET_RATE,
                         "nSamples": int(sig.size),
                         "absSum": float(np.abs(sig).sum()),
                         "head": [float(v) for v in sig[:32]]}
        out = os.path.join(outdir, name + ".json")
        with open(out, "w") as fh:
            json.dump(case, fh, indent=1)
        written.append(os.path.basename(out))

    index = os.path.join(outdir, "index.json")
    with open(index, "w") as fh:
        json.dump({"cases": sorted(written)}, fh, indent=1)

    _write_static_imports(outdir, sorted(written))
    print(f"wrote {len(written)} oracle cases to {outdir}")
    return 0


def _write_static_imports(outdir: str, written: list) -> None:
    """Regenerate the TypeScript module that imports these dumps statically.

    The browser test tier has no filesystem, so it cannot read the dumps the way
    the node tiers do. A generated module of plain imports works in both, and
    generating it here means a new fixture cannot be added to the corpus and
    then silently left out of most of the suite — which is a failure that looks
    exactly like everything passing.
    """
    names = [f[:-5] for f in written]
    ident = lambda n: n.replace("-", "_").replace(".", "_")  # noqa: E731
    lines = [
        "/* The oracle cases as static imports.",
        " *",
        " * GENERATED by tools/oracle.py — do not edit by hand.",
        " *",
        " * The pure tier could read these off disk, but the browser tier cannot:",
        " * there is no node:fs there, and reaching for it took down the whole file",
        " * before a single test ran. A static import works in both, and Vite inlines",
        " * the JSON at build time so there is no fetch to wait on either.",
        " */",
        "",
        'import type { OracleCase } from "./oracle";',
        "",
    ]
    lines += [f'import {ident(n)} from "./oracle/{n}.json";' for n in names]
    lines += ["", "export const ORACLE_CASES: OracleCase[] = ["]
    lines += [f"  {ident(n)} as unknown as OracleCase," for n in names]
    lines += ["];", ""]

    out = os.path.join(os.path.dirname(outdir.rstrip("/")), "oracle-data.ts")
    with open(out, "w") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "app/test/oracle"))
