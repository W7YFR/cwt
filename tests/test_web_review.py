"""Tests for the --web-review page.

The important one is `test_js_grading_matches_python`: the browser re-grades
client-side, which means review-core.js duplicates core.py's timing logic. That
duplication is the price of a serverless page, and this test is what keeps it
honest — it runs both implementations over the same segments and asserts they
agree.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from cw_decoder import core, morse, review, synth, webpage

CORE_JS = Path(core.__file__).parent / "web" / "review-core.js"
node = pytest.mark.skipif(shutil.which("node") is None,
                          reason="node not installed")


def _decode(text="CQ CQ DE W7YFR K", wpm=22, farns=None, rate=8000,
            target_wpm=None, target_farns=None, noise=0.0, expected=None):
    sig = synth.generate(text, wpm=wpm, farnsworth_wpm=farns, tone=600,
                         rate=rate, noise=noise)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, rate)
        return core.decode_file(tf.name, target_rate=rate,
                                target_wpm=target_wpm,
                                target_farnsworth=target_farns,
                                keep_signal=True, expected=expected)


def _flat(rows) -> list:
    """Flatten rows of numbers so pytest.approx can compare them."""
    return [v for row in rows for v in row]


def _run_js(script: str, payload: dict) -> dict:
    """Run `script` with ReviewCore loaded and the payload on stdin."""
    prelude = f"""
      const RC = require({str(CORE_JS)!r});
      RC.setMorse({json.dumps(morse.tables())});
      const PAYLOAD = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      {script}
    """
    proc = subprocess.run(["node", "-e", prelude],
                          input=json.dumps(payload), capture_output=True,
                          text=True)
    if proc.returncode != 0:
        raise AssertionError(f"node failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


# --------------------------------------------------------------------------- #
# Python <-> JavaScript agreement
# --------------------------------------------------------------------------- #
@node
@pytest.mark.parametrize("text,wpm,farns,tgt_wpm,tgt_farns", [
    ("CQ CQ DE W7YFR K", 22, None, 22, None),      # on target
    ("CQ TEST DE K1ABC", 25, 13, 25, 13),          # heavy Farnsworth
    ("PARIS PARIS PARIS", 18, None, 25, 25),       # sending well under target
    ("R FB TU 73 <SK>", 20, None, 20, 15),         # prosigns + spacing target
    ("THE QUICK BROWN FOX", 30, None, 22, 22),     # sending over target
])
def test_js_grading_matches_python(text, wpm, farns, tgt_wpm, tgt_farns):
    """review-core.js and core.py must produce the same timeline and grades."""
    res = _decode(text, wpm=wpm, farns=farns,
                  target_wpm=tgt_wpm, target_farns=tgt_farns, expected=text)
    payload = review.build_payload(res, source="test", expected=text,
                                   tolerance=0.30)

    got = _run_js("""
      const t = RC.targetTiming(PAYLOAD.target.char_wpm,
                                PAYLOAD.target.farnsworth_wpm);
      const tl = RC.buildTimeline(PAYLOAD.segments, t);
      // Same order the page uses: pair the classified timeline, then let the
      // intended text re-target the gaps before grading.
      const ideal = RC.idealTimeline(PAYLOAD.expected, t);
      const slots = RC.pair(tl, ideal);
      const moved = RC.retarget(slots);
      const g = RC.grade(tl, PAYLOAD.tolerance);
      console.log(JSON.stringify({
        timing: [t.unitSec, t.ditDahSplit, t.elementCharSplit,
                 t.charWordSplit, t.charGapSec, t.wordGapSec],
        text: tl.text,
        kinds: tl.blocks.map(b => b.kind),
        units: tl.blocks.map(b => b.units),
        targets: tl.blocks.map(b => b.targetUnits),
        targetKinds: tl.blocks.map(b => b.targetKind),
        chars: tl.chars.map(c => c.char + ':' + c.pattern),
        idealText: ideal.text,
        idealDuration: ideal.duration,
        idealBlocks: ideal.blocks.map(b => b.kind + ':' + b.units.toFixed(6)),
        slots: slots.map(s => [s.op, s.actual ? s.actual.char : null,
                               s.ideal ? s.ideal.char : null, s.spaceOp]),
        moved: moved,
        stats: g.stats.map(s => [s.name, s.n, s.meanUnits, s.stdUnits,
                                 s.targetUnits]),
        devs: g.deviations.map(d => [d.kind, d.valueUnits, d.targetUnits,
                                     d.context]),
        within: g.withinTolFrac,
        pauses: g.nPauses,
      }));
    """, payload)

    # Python side, from the same segments the payload carries.
    ref = core.target_timing(payload["target"]["char_wpm"],
                             payload["target"]["farnsworth_wpm"])
    segs = [(s, d) for s, d in payload["segments"]]
    tl = core.build_timeline(segs, ref)
    ideal = core.ideal_timeline(payload["expected"], ref)
    slots = core.pair(tl, ideal)
    moved = core.retarget(slots)
    a = core.analyze(tl, ref, res.timing, tolerance=payload["tolerance"])

    assert got["timing"] == pytest.approx(
        [ref.unit_sec, ref.dit_dah_split, ref.element_char_split,
         ref.char_word_split, ref.char_gap_sec, ref.word_gap_sec], abs=1e-12)
    assert got["text"] == tl.text
    assert got["kinds"] == [b.kind for b in tl.blocks]
    assert got["units"] == pytest.approx([b.units for b in tl.blocks], abs=1e-9)
    assert got["targets"] == pytest.approx([b.target_units for b in tl.blocks],
                                           abs=1e-9)
    assert got["targetKinds"] == [b.target_kind for b in tl.blocks]
    assert got["chars"] == [f"{c.char}:{c.pattern}" for c in tl.chars]
    # The intended message, and the alignment that re-targeted the gaps.
    assert got["idealText"] == ideal.text
    assert got["idealDuration"] == pytest.approx(ideal.duration, abs=1e-9)
    assert got["idealBlocks"] == [f"{b.kind}:{b.units:.6f}"
                                  for b in ideal.blocks]
    assert got["slots"] == [
        [s.op, s.actual.char if s.actual else None,
         s.ideal.char if s.ideal else None, s.space_op] for s in slots]
    assert got["moved"] == moved
    assert got["pauses"] == a.n_pauses
    assert got["within"] == pytest.approx(a.within_tol_frac, abs=1e-9)
    # Compare labels/counts exactly and the statistics numerically
    # (pytest.approx only handles flat sequences, hence the flattening).
    assert [(s[0], s[1]) for s in got["stats"]] == [(s.name, s.n)
                                                    for s in a.stats]
    assert _flat(s[2:] for s in got["stats"]) == pytest.approx(
        _flat((s.mean_units, s.std_units, s.target_units) for s in a.stats),
        abs=1e-9)
    assert [(d[0], d[3]) for d in got["devs"]] == [(d.kind, d.context)
                                                   for d in a.deviations]
    assert _flat(d[1:3] for d in got["devs"]) == pytest.approx(
        _flat((d.value_units, d.target_units) for d in a.deviations), abs=1e-9)


@node
@pytest.mark.parametrize("expected,decoded", [
    ("CQ DE W7YFR", "CQ DE W7YFR"),          # clean
    ("CQ TEST", "CQ TEXT"),                  # substitution
    ("ROB DE W7YFR", "ROB DE XX W7YFR"),     # insertions
    ("CQ TEST", "CQ TES"),                   # deletion
    ("PARIS PARIS PARIS", "PARIS PARXS PARIS"),
    ("TU 73 <SK>", "TU 73 <SK>"),            # prosigns
    ("CQ DE W7YFR", "CQDE W7YFR"),           # missed word boundary
    ("CQ DE W7YFR", "CQ D E W7YFR"),         # extra word boundary
])
def test_js_comparison_matches_python(expected, decoded):
    """The page's accuracy figure must match what the CLI reports."""
    got = _run_js("""
      const c = RC.compare(PAYLOAD.expected, PAYLOAD.decoded);
      console.log(JSON.stringify({
        accuracy: c.accuracy, n: c.nExpected, sub: c.substitutions,
        ins: c.insertions, del: c.deletions,
      }));
    """, {"expected": expected, "decoded": decoded})

    c = core.compare_text(expected, decoded)
    assert got["accuracy"] == pytest.approx(c.accuracy, abs=1e-9)
    assert (got["n"], got["sub"], got["ins"], got["del"]) == (
        c.n_expected, c.substitutions, c.insertions, c.deletions)


@node
def test_js_ideal_timeline_is_perfect_and_decodes_back():
    """The synthesized target must grade as flawless and round-trip to itself."""
    got = _run_js("""
      const t = RC.targetTiming(25, 13);
      const ideal = RC.idealTimeline("CQ CQ DE W7YFR <AR> K", t);
      const g = RC.grade(ideal, 0.01);
      // Re-derive segments from the ideal marks (offset by leading silence,
      // the way a real recording starts) and decode them back.
      const LEAD = 0.1, segs = [];
      let prev = 0;
      for (const b of ideal.blocks) {
        if (b.kind !== 'dit' && b.kind !== 'dah') continue;
        segs.push([0, b.t0 + LEAD - prev]);
        segs.push([1, b.t1 - b.t0]);
        prev = b.t1 + LEAD;
      }
      segs.push([0, LEAD]);
      console.log(JSON.stringify({
        text: ideal.text,
        within: g.withinTolFrac,
        devs: g.deviations.length,
        roundTrip: RC.buildTimeline(segs, t).text,
      }));
    """, {})
    assert got["text"] == "CQ CQ DE W7YFR <AR> K"
    assert got["within"] == 1.0          # perfect keying is perfectly graded
    assert got["devs"] == 0
    assert got["roundTrip"] == "CQ CQ DE W7YFR <AR> K"


@node
@pytest.mark.parametrize("gaps,want", [
    # Evenly wound-out spacing: every gap 4x nominal, all of it graded.
    ([28, 28, 28, 28], ["word-gap"] * 4),
    # The same gaps with one stop among them: only the stop is a rest.
    ([28, 28, 90, 28], ["word-gap", "word-gap", "pause", "word-gap"]),
    # Tight sending with one wide word gap: the floor keeps it gradable even
    # though it towers over this sender's own typical gap.
    ([3, 3, 13, 3], ["char-gap", "char-gap", "word-gap", "char-gap"]),
])
def test_js_rest_detection_matches_python(gaps, want):
    """Both sides must draw the rest line in the same place.

    A rest is judged against the sender's own median gap, so this is the one
    piece of buildTimeline that depends on the whole segment list rather than
    on one duration — easy to get subtly different in a port.
    """
    unit = 1.2 / 20
    segs = [(0, 0.1)]
    for g in gaps:
        segs += [(1, unit), (0, g * unit)]
    segs += [(1, unit), (0, 0.1)]

    got = _run_js("""
      const t = RC.targetTiming(20, 20);
      const tl = RC.buildTimeline(PAYLOAD.segments, t);
      const loose = RC.buildTimeline(PAYLOAD.segments, t, Infinity);
      console.log(JSON.stringify({
        kinds: tl.blocks.filter(b => b.kind !== 'dit').map(b => b.kind),
        targets: tl.blocks.filter(b => b.kind !== 'dit').map(b => b.targetUnits),
        pauses: RC.grade(tl, 0.3).nPauses,
        loosePauses: RC.grade(loose, 0.3).nPauses,
      }));
    """, {"segments": [list(s) for s in segs]})

    timing = core.target_timing(20, 20)
    tl = core.build_timeline(segs, timing)
    kinds = [b.kind for b in tl.blocks if b.kind != "dit"]
    assert kinds == want                       # the behavior we intend...
    assert got["kinds"] == kinds               # ...and both sides agree on it
    assert got["targets"] == pytest.approx(
        [b.target_units for b in tl.blocks if b.kind != "dit"], abs=1e-9)
    assert got["pauses"] == core.analyze(tl, timing, timing).n_pauses
    # Disabling rest detection must agree too: nothing is ever a rest.
    loose = core.build_timeline(segs, timing, pause_factor=float("inf"))
    assert got["loosePauses"] == core.analyze(loose, timing, timing).n_pauses
    assert got["loosePauses"] == 0


@node
def test_js_pair_aligns_characters_and_flags_word_errors():
    got = _run_js("""
      const t = RC.targetTiming(20, 20);
      function slots(sentText, wantText) {
        // Build an "actual" timeline by keying sentText perfectly, so the only
        // differences from the target are the character/word errors themselves.
        const a = RC.idealTimeline(sentText, t);
        const b = RC.idealTimeline(wantText, t);
        return RC.pair(a, b).map(s => [
          s.op, s.actual ? s.actual.char : null,
          s.ideal ? s.ideal.char : null, s.spaceOp]);
      }
      console.log(JSON.stringify({
        clean: slots("CQ DE", "CQ DE"),
        sub: slots("CQ DX", "CQ DE"),
        missed: slots("CQ D", "CQ DE"),
        extra: slots("CQ DEX", "CQ DE"),
        noSpace: slots("CQDE", "CQ DE"),
      }));
    """, {})

    assert got["clean"] == [["equal", "C", "C", None], ["equal", "Q", "Q", None],
                            ["equal", "D", "D", "equal"],
                            ["equal", "E", "E", None]]
    assert [s[0] for s in got["sub"]] == ["equal", "equal", "equal", "sub"]
    assert got["sub"][3][1:3] == ["X", "E"]
    assert [s[0] for s in got["missed"]] == ["equal", "equal", "equal", "del"]
    assert got["missed"][3][1:3] == [None, "E"]
    assert [s[0] for s in got["extra"]][-1] == "ins"
    # A missed word boundary: characters still align, the space is reported
    # missing on the character that should have started the new word.
    assert [s[1] for s in got["noSpace"]] == ["C", "Q", "D", "E"]
    assert got["noSpace"][2][3] == "del"


def _wide_spacing_payload(text="CQ TEST DE K1ABC"):
    """A payload whose gap classes the duration classifier gets wrong.

    Sent with Farnsworth spacing against a straight 25 wpm target, so every
    letter gap reads as a word gap and every word gap reads as a pause — the
    shape that made the deviations table disagree with the graph.
    """
    res = _decode(text, wpm=25, farns=13, target_wpm=25, target_farns=25,
                  expected=text)
    return review.build_payload(res, source="test", expected=text,
                                tolerance=0.30)


@node
def test_js_deviation_targets_match_the_target_lane():
    """The two panels must not disagree: one gap, one target.

    The deviations table and the graph's TGT lane used to read from different
    places — the duration classifier's guess and the intended text respectively
    — so a letter gap could be listed against a 7u target while the lane above
    it was drawn against 3u.
    """
    got = _run_js("""
      const t = RC.targetTiming(PAYLOAD.target.char_wpm,
                                PAYLOAD.target.farnsworth_wpm);
      const tl = RC.buildTimeline(PAYLOAD.segments, t);
      const ideal = RC.idealTimeline(PAYLOAD.expected, t);
      const slots = RC.pair(tl, ideal);
      RC.retarget(slots);
      const g = RC.grade(tl, PAYLOAD.tolerance);
      // What the graph draws for each paired gap, keyed by the time the
      // deviations table prints, so the two can be compared directly.
      const lane = {};
      for (const s of slots) {
        if (!s.actual || !s.actual.leadGap || !s.ideal || !s.ideal.leadGap) {
          continue;
        }
        lane[s.actual.leadGap.t0.toFixed(6)] = s.ideal.leadGap.units;
      }
      console.log(JSON.stringify({
        lane: lane,
        devs: g.deviations.map(d => [d.timeSec.toFixed(6), d.kind,
                                     d.valueUnits, d.targetUnits]),
        // Word-boundary errors still reported: retarget() leaves `kind`
        // alone, so the token stream still shows the spaces the decoder read.
        spaceOps: slots.filter(s => s.spaceOp).map(s => s.spaceOp),
        pauses: g.nPauses,
        classes: g.stats.map(s => s.name),
      }));
    """, _wide_spacing_payload())

    assert got["devs"], "wide spacing should produce deviations"
    for at, kind, value, target in got["devs"]:
        assert at in got["lane"], f"deviation at {at}s is not a paired gap"
        assert target == pytest.approx(got["lane"][at], abs=1e-9), (
            f"{kind} at {at}s graded against {target}u but the target lane "
            f"draws {got['lane'][at]}u")
    # Both gap classes are present, and nothing was written off as a rest.
    assert "char-gap" in got["classes"] and "word-gap" in got["classes"]
    assert got["pauses"] == 0
    assert got["spaceOps"]


# --------------------------------------------------------------------------- #
# Payload and page assembly
# --------------------------------------------------------------------------- #
def test_payload_is_json_serializable_and_raw():
    res = _decode(target_wpm=22)
    p = review.build_payload(res, source="qso.wav", expected="CQ CQ DE W7YFR K",
                             expected_source="qso.txt", tolerance=0.25)
    json.dumps(p)                                   # must round-trip cleanly
    assert p["version"] == review.PAYLOAD_VERSION
    assert p["audio"].startswith("data:audio/wav;base64,")
    assert p["expected"] == "CQ CQ DE W7YFR K"
    assert p["target"]["explicit"] is True
    assert p["tolerance"] == 0.25
    # Segments are seconds, not units: that's what lets the page re-grade.
    assert all(s in (0, 1) for s, _ in p["segments"])
    assert sum(d for _, d in p["segments"]) == pytest.approx(p["duration_sec"],
                                                             abs=0.01)


def test_payload_defaults_target_to_measured_speed():
    """With no -w, the target track is the sender's own speed keyed perfectly."""
    res = _decode(wpm=18, target_wpm=None)
    p = review.build_payload(res, source="x.wav")
    assert p["target"]["explicit"] is False
    assert abs(p["target"]["char_wpm"] - 18) <= 2
    assert p["expected"] is None


def test_payload_requires_the_signal():
    sig = synth.generate("TEST", wpm=20, tone=600, rate=8000)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, 8000)
        res = core.decode_file(tf.name, target_rate=8000)   # keep_signal=False
    with pytest.raises(ValueError, match="keep_signal"):
        review.build_payload(res, source="x.wav")


def test_page_is_self_contained():
    res = _decode(target_wpm=22)
    p = review.build_payload(res, source="qso.wav")
    html = webpage.render(p)
    assert "/*__" not in html                       # every slot was filled
    # No external references: a strict offline file.
    for bad in ("http://", "https://", "<link", "src=\"http"):
        assert bad not in html
    assert "data:audio/wav;base64," in html
    assert "ReviewCore" in html

    # Nothing in the transport row may resize while playing, or everything to
    # its right shifts. The clock gets a fixed width (not min-width) and the
    # play/stop glyph lives in its own fixed-width span.
    assert re.search(r"\.clock\s*\{[^}]*\bwidth:\s*\d", html), \
        "the clock needs a fixed width, not an elastic one"
    assert re.search(r"\.ico\s*\{[^}]*\bwidth:", html)
    assert html.count('class="ico"') == 2      # one per transport button


def test_page_escapes_script_breakout_in_text():
    """A </script> in the intended message must not terminate the payload."""
    res = _decode(target_wpm=22)
    p = review.build_payload(res, source="x.wav",
                             expected="</script><script>alert(1)</script>")
    html = webpage.render(p)
    assert "</script><script>alert(1)" not in html
    assert "\\u003c/script" in html


# --------------------------------------------------------------------------- #
# The page actually runs
# --------------------------------------------------------------------------- #
def _sloppy_wav(path, text="CQ CQ DE W7YFR K", wpm=20, rate=8000):
    """Synthesize keying with real faults, so the page's error paths get drawn.

    Deliberately includes: element jitter, squeezed character gaps, one badly
    stretched gap, a stretched word gap, a missed word space, a clipped dah,
    and a rest. The stretched word gap and the rest are distinct on purpose —
    one is a gradable spacing error, the other is the sender stopping.
    """
    import numpy as np

    from cw_decoder.morse import CHAR_TO_MORSE

    unit = 1.2 / wpm
    rng = np.random.default_rng(7)
    on = [(False, 0.15)]
    for wi, word in enumerate(text.split(" ")):
        if wi > 0:
            gap = 3.0 if wi == 3 else 7.0      # wi==3 -> the space is missed
            if wi == 1:
                gap = 12.0                     # a word gap stretched, not a rest
            if wi == 2:
                gap = 20.0                     # the sender stopping: a rest
            on.append((False, gap * unit * rng.normal(1.0, 0.04)))
        for li, ch in enumerate(word):
            if li > 0:
                base = 1.9 if wi == 3 else 3.0     # squeezed inside W7YFR
                if wi == 1 and li == 1:
                    base = 6.5                     # one stretched gap
                on.append((False, base * unit * rng.normal(1.0, 0.10)))
            for ei, el in enumerate(CHAR_TO_MORSE[ch]):
                if ei > 0:
                    on.append((False, unit * rng.normal(1.0, 0.18)))
                length = 1.0 if el == "." else 3.0
                if word == "K" and ei == 0:
                    length = 1.1                   # a dah clipped to dit length
                on.append((True, length * unit * rng.normal(1.0, 0.12)))
    on.append((False, 0.15))

    n = int(sum(d for _, d in on) * rate)
    env = np.zeros(n)
    i = 0
    for is_on, dur in on:
        span = int(dur * rate)
        if is_on and span > 0:
            env[i:i + span] = 1.0
        i += span
    t = np.arange(n) / rate
    sig = env * np.sin(2 * np.pi * 620 * t) + rng.normal(0, 0.02, n)
    synth.write_wav(str(path), (sig / np.max(np.abs(sig))).astype("float32"),
                    rate)


# The intended text behind the boot fixture, named so a test can grade the
# same recording in Python and compare.
SLOPPY_EXPECTED = "CQ CQ DE W7YFR K"
SLOPPY_WPM = 20
SLOPPY_TOL = 0.30


def _same_numbers(a, b, path="report"):
    """Assert two report blocks agree, allowing the last decimal place to move.

    Both sides round to the same precision, but Python rounds a half to even
    and JavaScript rounds it up, so a value sitting exactly on the boundary can
    land one step apart. That's a formatting tie, not a disagreement about the
    grading — which test_js_matches_python_on_the_same_fixture holds to 1e-9.
    """
    if isinstance(a, dict):
        assert set(a) == set(b), f"keys differ at {path}"
        for k in a:
            _same_numbers(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        assert len(a) == len(b), f"length differs at {path}"
        for i, (x, y) in enumerate(zip(a, b)):
            _same_numbers(x, y, f"{path}[{i}]")
    elif isinstance(a, bool) or isinstance(b, bool):
        assert a is b, f"{path}: {a!r} != {b!r}"
    elif isinstance(a, float) or isinstance(b, float):
        assert a == pytest.approx(b, abs=1.5e-3), f"{path}: {a} != {b}"
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


def _run_stub(page):
    """Boot `page` under the stub DOM and return everything it observed."""
    stub = Path(__file__).parent / "dom_stub.js"
    proc = subprocess.run(["node", str(stub), str(page)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, f"page failed to run:\n{proc.stderr}"
    return json.loads(proc.stdout)


def _zoom_range(page):
    """The zoom slider's limits, read from the page's own markup rather than
    restated here — the stub lifts them across, and app.js clamps to them."""
    src = page.read_text()
    lo = re.search(r'id="zoom"[^>]*\bmin="(\d+)"', src)
    hi = re.search(r'id="zoom"[^>]*\bmax="(\d+)"', src)
    assert lo and hi, "could not find the zoom slider's range in the page"
    return int(lo.group(1)), int(hi.group(1))


def _boot_sloppy_page(tmp_path):
    """Build the review page for the sloppy fixture, run it under the stub DOM,
    and return everything the stub observed."""
    wav = tmp_path / "sloppy.wav"
    _sloppy_wav(wav)
    res = core.decode_file(str(wav), target_rate=8000, target_wpm=SLOPPY_WPM,
                           keep_signal=True)
    page = tmp_path / "review.html"
    webpage.write(str(page), review.build_payload(
        res, source="sloppy.wav", expected=SLOPPY_EXPECTED,
        expected_source="(inline text)", tolerance=SLOPPY_TOL))
    return _run_stub(page), page


@node
def test_page_boots_and_draws(tmp_path):
    """Boot the real page under a stub DOM and drive every control.

    This is the guard against the failure that only shows up as a blank page:
    app.js throwing during boot, layout, or draw. It asserts the page painted,
    annotated spacing, flagged the faults, and wired up audio — not how it
    looks.
    """
    d, page = _boot_sloppy_page(tmp_path)

    assert d["scripts"] == 4                       # morse, payload, core, app
    assert d["actions"] > 300                      # every control was driven
    assert d["fills"] > 100 and d["strokes"] > 100  # it painted

    labels = set(d["labels"])
    assert {"YOU", "TGT", "DRIFT"} <= labels       # both tracks and the drift strip
    assert any(x.endswith("u") for x in labels)    # spacing annotated in units
    assert any(x.endswith("s") for x in labels)    # ruler ticks for seeking
    assert {"OK", "~", "**"} & labels              # grade markers
    assert any("→" in x for x in labels)           # a substitution was captioned
    assert "no space" in labels                    # the missed word boundary

    # The track labels live in the left gutter, and content is clipped out of
    # it, so scrolled blocks pass behind the labels instead of over them.
    GUTTER = 44
    for name in ("YOU", "TGT", "DRIFT"):
        assert d["labelX"][name] < GUTTER, f"{name} label escaped the gutter"
    assert d["clipped"] > 0                        # a clip was actually applied
    assert d["clipLefts"] == [GUTTER]              # every clip starts at the gutter

    # No two gutter labels may land on top of each other. Both bugs found in
    # review were exactly this — content over "YOU", then the drift bound over
    # "DRIFT" — so check it generally rather than case by case.
    boxes = d["gutterLabels"]
    assert len(boxes) >= 4                         # YOU, TGT, DRIFT, ±drift
    for i, (t1, x1, y1, w1) in enumerate(boxes):
        for t2, x2, y2, w2 in boxes[i + 1:]:
            overlap = (x1 < x2 + w2 and x2 < x1 + w1
                       and abs(y1 - y2) < 10)      # ~one line of leading
            assert not overlap, (
                f"gutter labels {t1!r} at ({x1},{y1}) and {t2!r} at "
                f"({x2},{y2}) overlap")
    # Panning moved content well left of the gutter — which is exactly the case
    # that used to draw over the labels.
    assert d["contentMinX"] < 0

    # Audio: the recording plays and seeks (per-character playback), and the
    # target is synthesized rather than played from a file.
    assert d["audio"]["plays"] > 0
    assert d["audio"]["maxSeek"] > 0.1
    assert d["audio"]["oscStarts"] > 0
    assert d["audio"]["gainEvents"] > 20

    # The recording plays from a decoded buffer, decoded once and cached — not
    # an <audio> element routed through a gain node, which can output silence
    # on some file:// / data: combinations.
    assert d["audio"]["decodes"] == 1
    assert d["audio"]["decodedBytes"] > 10_000

    # The listening level is a playback control: moving it sets gain nodes and
    # never touches the samples. +30 dB on the slider must reach the graph.
    assert d["audio"]["maxLevel"] > 10, \
        f"listening gain never reached the audio graph: {d['audio']['levels']}"

    # Each deviation offers both sides as separate play controls, and each
    # drives the right source: "yours" the recording, "target" the oscillator.
    ab = d["abTest"]
    assert ab["cells"] >= 4 and ab["cells"] % 2 == 0
    assert ab["youClicks"] == 1, "clicking 'yours' did not play the recording"
    assert ab["tgtClicks"] == 1, "clicking 'target' did not play the target"
    # And it plays a context window, not a bare element: spacing is only
    # audible with the characters either side of it.
    assert ab["youSpan"] > 0.4

    # Hovering either value points at the stretch of canvas it describes, on
    # the same track that value would play — so "yours" and "target" light up
    # different rows — and the highlight goes away when the pointer leaves.
    # Exactly one wash per hover, in the hovered track's own color: one listener
    # on the row, one redraw, one highlight.
    hov = d["devHover"]
    assert hov["you"] == [hov["colors"]["you"]], \
        f"hovering 'yours' should wash the YOU track once: {hov['you']}"
    assert hov["tgt"] == [hov["colors"]["tgt"]], \
        f"hovering 'target' should wash the TGT track once: {hov['tgt']}"
    assert hov["afterLeave"] == [], \
        f"the highlight outlived the hover: {hov['afterLeave']}"

    # The highlight opens at the leading character's first mark, give or take
    # its 4px pad. Only the gaps *between* a range's characters belong to it —
    # the one before the first character belongs to the character before that,
    # and including it made a letter-gap highlight read as gap-char-gap-char.
    assert hov["youLeadIn"] is not None, "found no marks inside the highlight"
    assert 0 <= hov["youLeadIn"] <= 8, (
        f"the highlight starts {hov['youLeadIn']}px before the first mark it "
        "contains, so it has swallowed the gap ahead of the range")

    # Zoomed in past the viewport, hovering a row for a deviation the view has
    # scrolled away from brings it on screen — otherwise the highlight lands
    # outside the viewport and the row looks inert. Two rows at different
    # moments must land the view in different places; the same row twice must
    # land it in the same place.
    assert hov["rows"] >= 2
    assert hov["translateRowA"] != hov["translateRowB"], \
        "hovering a deviation off screen did not reveal it"
    assert hov["translateReHover"] == hov["translateRowB"], \
        "re-hovering the same row moved the view"

    # What a row plays is scoped to the class it grades: a letter gap gets the
    # characters either side, a word gap the words either side. Recorded as
    # [kind, the moment the row names, window start, length, target length].
    dp = d["devPlay"]
    assert dp, "no deviation row played anything"
    assert {"char-gap", "word-gap"} <= {r[0] for r in dp}
    # The window must contain the moment its row names. A gap's timestamp is
    # also the instant the previous character ends, and resolving that tie the
    # wrong way scoped every gap row one character early — which put the gap
    # itself at the very edge of the window instead of in the middle of it.
    for kind, at, start, dur, tgt_dur in dp:
        assert start < at < start + dur, (
            f"{kind} row at {at}s played [{start:.2f}, {start + dur:.2f}], "
            "which doesn't contain the moment the row names")
        assert tgt_dur > 0, f"{kind} row played nothing on the target track"
    # Both sides are scoped by the same rule, so a word gap reaches wider than
    # a letter gap on both. (Fixture-specific: words here are 2-5 characters.)
    for i, label in ((3, "yours"), (4, "target")):
        letters = [r[i] for r in dp if r[0] == "char-gap"]
        words = [r[i] for r in dp if r[0] == "word-gap"]
        assert min(words) > max(letters), (
            f"on '{label}', a word gap should reach wider than a letter gap: "
            f"letter {max(letters):.2f}s vs word {min(words):.2f}s")

    # "Collapse rests" (on by default): the fixture's 20-unit stop is the
    # sender pausing, so it stays out of the grading and takes a fixed sliver
    # of the chart. Turning it off makes every silence spacing again — which
    # tops the deviations table with a 20-unit "word gap" and stretches the
    # chart out by the difference.
    on, off = d["restToggle"]["collapsed"], d["restToggle"]["expanded"]
    assert on["restLabels"] == ["Rest 20u"], (
        f"collapsed, the rest should be labeled as one: {on['restLabels']}")
    assert off["restLabels"] == [], (
        f"expanded, nothing should read as a rest: {off['restLabels']}")
    # And drawn in its own hue, not borrowed from the grade scale — nothing
    # about a rest is good or bad, so green/amber/red would misread as a
    # verdict, and the muted gray it used to share with pauses read as a
    # rendering fault.
    palette = d["restToggle"]["colors"]
    assert on["restColors"] == [palette["--rest"]], (
        f"the rest label should use --rest: {on['restColors']}")
    assert palette["--rest"] not in (palette["--ok"], palette["--warn"],
                                     palette["--bad"], palette["--you"],
                                     palette["--tgt"], palette["--ink-faint"])
    # Collapsed, the stop is absent from the table; expanded, it leads it.
    assert on["worst"] < off["worst"]
    assert off["devs"][0] == ["word-gap", pytest.approx(19.65, abs=0.5)]
    assert on["devs"] == off["devs"][1:], \
        "collapsing a rest should only remove the rest's own row"
    # The fixture's stop is 20u wide; collapsed it gets REST_W = 62px, so at
    # 14 px/unit the chart is ~218px narrower.
    assert on["overflow"] < off["overflow"]
    # The 12.4u word gap is a genuine spacing error and survives either way:
    # collapsing rests must not swallow real gaps along with the stop.
    assert ["word-gap", pytest.approx(12.37, abs=0.5)] in on["devs"]

    # Playback resets the transport when it ends. The original bug: the payload
    # duration is rounded, so the clock could plateau just under it and a `>=`
    # test never fired, leaving the button stuck on "playing".
    er = d["endReset"]
    assert er["buffered"], "playback did not use a decoded buffer"
    assert er["labelWhilePlaying"] == "■"
    assert er["labelAfterEnd"] == "▶", \
        "transport stuck after playback ran past the buffer's duration"
    assert er["labelAfterEndedEvent"] == "▶", \
        "transport stuck after the source node's own ended event"

    # The clock never reads negative. Playback is scheduled a beat ahead, so an
    # unclamped reading showed "-0.0s" for the first few frames — and the extra
    # character widened the clock, shoving the rest of the control row sideways.
    assert er["clocksWhilePlaying"], "the frame loop produced no clock readings"
    for c in er["clocksWhilePlaying"]:
        assert not c.startswith("-"), f"clock read {c!r}"

    # The listening level starts at unity: the recording plays back at the
    # level it was made, and boosting is an explicit choice. (Readings are
    # space-padded to a constant width — see the readout check below.)
    assert d["initial"]["gainOut"].strip() == "0 dB", \
        f"listening level defaulted to {d['initial']['gainOut']!r}"

    # No readout may change width. The control groups are sized by their
    # contents and the intended-message field absorbs the slack, so a reading
    # that gains a digit shoves the row sideways and re-wraps that field's
    # caption. Dragging a slider made that twitch; the wheel zoom made it
    # constant. Every reading each output showed, across every sweep above:
    assert d["readouts"], "no readouts were recorded"
    for name, seen in d["readouts"].items():
        assert seen, f"{name} never showed a reading"
        widths = sorted({len(s) for s in seen})
        assert len(widths) == 1, (
            f"{name} rendered at {widths} characters wide across {sorted(seen)}"
            " — the control row will twitch as it updates")

    # This session is too long to fit the window, so it opens fully zoomed out:
    # the whole thing on screen before you touch anything, so you can find
    # where the trouble is and then go in on it. (A session short enough to fit
    # zooms in instead — test_the_page_opens_filling_the_width.)
    floor, ceiling = _zoom_range(page)
    # Compared as numbers: an input's .value is a string.
    assert int(d["initial"]["zoom"]) == floor, (
        f"zoom opened at {d['initial']['zoom']!r}, not the slider's minimum "
        f"{floor}")
    assert d["initial"]["zoomOut"].strip() == f"{floor} px/unit"
    # And it stayed there because there was nothing to gain: even fully zoomed
    # out the chart is wider than the track.
    assert d["fitOpen"]["room"] > 0, \
        "this fixture is meant to overflow the window at the minimum zoom"
    # For a session this long "fit" means all the way out, and the Fit button
    # gets back there from anywhere — here, from the far end of the slider.
    assert float(d["fitOpen"]["zoomedIn"]["zoom"].split()[0]) == ceiling
    assert float(d["fitOpen"]["refit"]["zoom"].split()[0]) == floor

    # --- the wheel zooms ------------------------------------------------- #
    steps = dict(d["wheelZoom"]["steps"])

    # Wheel up zooms in, wheel down zooms out. Two notches up then two back
    # down returns you exactly where you started: the step is proportional, so
    # it has to be symmetric or the zoom would creep with every gesture.
    assert steps["in"]["ppu"] > steps["start"]["ppu"], "wheel up did not zoom in"
    assert steps["in-again"]["ppu"] > steps["in"]["ppu"], "zoom stopped moving"
    assert steps["out"]["ppu"] == steps["in"]["ppu"]
    assert steps["out-again"]["ppu"] == steps["start"]["ppu"], (
        f"two notches up and two back down landed on "
        f"{steps['out-again']['ppu']}, not {steps['start']['ppu']}")
    # Shift means pan, so it must leave the zoom exactly where it was...
    assert steps["shift"]["ppu"] == steps["out-again"]["ppu"], \
        "shift+wheel changed the zoom instead of panning"
    # ...and it must actually pan. Content is translated by (gutter - scrollX).
    assert steps["shift"]["translate"] < steps["out-again"]["translate"], \
        "shift+wheel did not scroll the view"

    # Spinning the wheel stops at the slider's own limits rather than running
    # off into a zoom the slider can't express.
    assert steps["pinned-in"]["ppu"] == ceiling
    assert steps["pinned-out"]["ppu"] == floor

    # The slider thumb follows the wheel, snapped to its whole-number step
    # while the readout keeps the fraction the wheel actually landed on.
    for name in ("in", "in-again", "out"):
        s = steps[name]
        assert abs(s["slider"] - s["ppu"]) <= 0.5, (
            f"the slider ({s['slider']}) drifted from the zoom ({s['ppu']})")
    assert any(s["ppu"] % 1 for _, s in d["wheelZoom"]["steps"] if "ppu" in s), \
        "the wheel only ever produced whole zoom levels; nothing to snap"

    # Anchoring: the same gesture over the left edge and over the right edge of
    # an identical view. Both reach the same zoom, but each holds the content
    # under the pointer still, so they leave the view in very different places.
    # Zoom about the middle only would make these two identical.
    anc = d["wheelZoom"]["anchored"]
    assert anc["left"]["ppu"] == anc["right"]["ppu"]
    assert anc["left"]["translate"] - anc["right"]["translate"] > 200, (
        "zooming at the left and at the right edge left the view in the same "
        f"place — the pointer is not anchoring it: {anc}")

    # The view follows the playhead instead of letting it slide off-screen.
    # Content is translated by (gutter - scrollX), so this trace falls as the
    # view scrolls. It page-jumps rather than sliding every frame, so expect
    # long plateaus with steps between them — and never a backwards step.
    follow = d["follow"]
    assert len(follow) > 20, "the frame loop was not pumped"
    assert all(b <= a for a, b in zip(follow, follow[1:])), \
        f"the view scrolled backwards during playback: {follow}"
    assert follow[0] - follow[-1] > 500, \
        f"the view barely moved while audio played: {follow}"
    assert len(set(follow)) > 2                    # it stepped more than once

    # All three renderers paint...
    assert set(d["viewFills"]) == {"per-char", "absolute", "overlay"}
    for view, fills in d["viewFills"].items():
        assert fills > 20, f"the {view} renderer drew almost nothing"
    # ...and overlay really superimposes: the split views label two separate
    # rows, overlay stacks the names as a color key inside one band. (Fill
    # counts can't tell them apart — every view draws both tracks.)
    rows = d["viewRows"]
    for split in ("per-char", "absolute"):
        gap = abs(rows[split]["YOU"] - rows[split]["TGT"])
        assert gap > 40, f"{split} should keep the tracks in separate rows"
    over = abs(rows["overlay"]["YOU"] - rows["overlay"]["TGT"])
    assert over < 25, "overlay should share one band"

    # Four downloads, offered in every view. The recording rides along as the
    # payload's data URI; the target is rendered fresh (so its filename carries
    # the speed it was rendered at), the chart is a full-width PNG, and the
    # report is JSON.
    dl = d["downloads"]
    yours = [x for x in dl if x["name"].endswith("-yours.wav")]
    target = [x for x in dl if "-target-" in x["name"]]
    charts = [x for x in dl if x["name"].endswith(".png")]
    reports = [x for x in dl if x["name"].endswith("-report.json")]
    assert yours and target and charts and reports
    assert reports[0]["scheme"] == "blob" and reports[0]["size"] > 500
    assert yours[0]["scheme"] == "data" and yours[0]["size"] > 10_000
    assert target[0]["scheme"] == "blob" and target[0]["size"] > 10_000
    assert "wpm" in target[0]["name"]
    # The target render carries padding at both ends rather than stopping dead
    # on its last element; see test_target_audio_gets_the_same_padding for the
    # value itself.
    assert d["audio"]["offlineSeconds"] > 2 * core.TRIM_PAD
    # One chart per view, each named for the view it captured.
    assert {x["name"].rsplit("-", 1)[-1] for x in charts} == {
        "char.png", "absolute.png", "overlay.png"}
    assert all(x["size"] > 1000 for x in charts)

    assert "consistent" in d["scoresHTML"]
    assert "accurate" in d["scoresHTML"]
    # The detected tone is shown — it's what the decoder locked onto and the
    # frequency the target is synthesized at, so a wrong reading explains a
    # bad decode. Along with the recording's true level and rate.
    assert "Hz tone" in d["scoresHTML"]
    assert "dBFS peak" in d["scoresHTML"]
    assert "Element" in d["reportHTML"]

    # Every class named in either table explains itself on hover. Without it
    # the names only make sense once you know the model — "intra-char gap"
    # reads naturally as the gap *between* characters, which is a different
    # class with a target three times larger.
    help_by_label = {}
    for label, text in d["classHelp"]:
        help_by_label.setdefault(label, []).append(text)
    assert help_by_label, "no class carried hover text"
    for label, texts in help_by_label.items():
        for text in texts:
            assert text.startswith(label + " — "), \
                f"{label!r} hover text does not name its own class: {text!r}"
            assert len(text) > 60, f"{label!r} hover text is too thin: {text!r}"

    # Both tables use the same words for the same class, so a flagged class can
    # be looked up in the averages above it. The deviations table used to print
    # the raw internal name ("element-gap") against a table that said
    # "intra-char gap", with nothing to connect the two.
    labels = set(help_by_label)
    assert "intra-char gap" in labels
    assert not [x for x in labels if "-gap" in x], \
        f"a raw internal class name reached the report: {sorted(labels)}"

    # The one that actually confuses people says which side of the character
    # it is on, and where to find it when it is too narrow to be labeled.
    intra = help_by_label["intra-char gap"][0]
    assert "INSIDE" in intra and "zoom in" in intra

    # And a deviation row says it is a single element, not the average sitting
    # in the table above — a class can be within tolerance overall and still
    # have one element flagged out here.
    assert any("not the average" in t
               for texts in help_by_label.values() for t in texts), \
        "nothing tells you a deviation row is one element, not an average"
    assert d["title"].startswith("CW review")
    # Clearing the intended message drops accuracy but keeps spacing grading,
    # which is the whole point of the no-target fallback.
    assert "accurate" not in d["scoresWithoutTarget"]
    assert "consistent" in d["scoresWithoutTarget"]


@node
def test_a_deviation_plays_exactly_what_its_class_covers(tmp_path):
    """The window a row plays must hold what the class covers and no more.

    A dit, a dah and an intra-character gap all live *inside* one character, so
    those rows get that character alone. They used to take a neighbor on each
    side as well, which highlighted three letters for a fault in the middle one
    and buried a 20 ms hesitation in a second and a half of audio.

    Checked against the decode's own character spans rather than against
    durations, so it says the thing that matters — which characters are in and
    which are out — without depending on the padding or the fixture's lengths.
    """
    d, _ = _boot_sloppy_page(tmp_path)
    res = core.decode_file(str(tmp_path / "sloppy.wav"), target_rate=8000,
                           target_wpm=SLOPPY_WPM, tolerance=SLOPPY_TOL,
                           expected=SLOPPY_EXPECTED)
    chars = res.timeline.chars
    assert chars

    inside_one_character = {"dit", "dah", "element-gap"}
    seen = set()
    for kind, at, start, dur, _tgt in d["devPlay"]:
        stop = start + dur
        # The character the flagged element belongs to: for a mark or an
        # intra-character gap that's the one containing it; for a gap between
        # characters it's the one the gap leads into.
        # The table prints the moment to 2dp, so match to within that.
        eps = 0.01
        if kind in inside_one_character:
            hit = [i for i, c in enumerate(chars)
                   if c.t0 - eps <= at <= c.t1 + eps]
        else:
            hit = [i for i, c in enumerate(chars)
                   if c.lead_gap is not None
                   and abs(c.lead_gap.t0 - at) <= eps]
        assert len(hit) == 1, f"{kind} at {at}s matched {len(hit)} characters"
        i = hit[0]
        seen.add(kind)

        # However wide the class is, the flagged character itself is in.
        assert start <= chars[i].t0 and stop >= chars[i].t1, (
            f"{kind} at {at}s played [{start:.2f}, {stop:.2f}], which does not "
            f"cover the character it is about "
            f"([{chars[i].t0:.2f}, {chars[i].t1:.2f}])")

        if kind in inside_one_character:
            # ...and for a fault inside a character, nothing else is.
            if i > 0:
                assert start > chars[i - 1].t1, (
                    f"{kind} at {at}s reaches back into the previous "
                    f"character — the fault is inside one character")
            if i + 1 < len(chars):
                assert stop < chars[i + 1].t0, (
                    f"{kind} at {at}s reaches into the next character — the "
                    f"fault is inside one character")
        elif kind == "char-gap":
            # A letter gap needs the character either side of it, and stops
            # there: another gap next door would compete with the one flagged.
            assert start <= chars[i - 1].t0, \
                "a letter gap must include the character before it"
            if i + 1 < len(chars):
                assert stop < chars[i + 1].t0, \
                    "a letter gap must stop at the character after it"

    assert inside_one_character & seen, (
        "this fixture is meant to flag something inside a character; nothing "
        f"here did: {sorted(seen)}")
    assert "char-gap" in seen


@node
def test_the_page_opens_filling_the_width(tmp_path):
    """A session short enough to fit gets zoomed in until it fills the window.

    Opening fully zoomed out is right for a long take — the whole thing lands
    on screen at once — but it strands a short one in a corner of the chart,
    and empty pixels are the one thing a timing chart has no use for.
    """
    res = _decode(text="SOS", wpm=SLOPPY_WPM, target_wpm=SLOPPY_WPM,
                  expected="SOS")
    page = tmp_path / "review.html"
    webpage.write(str(page), review.build_payload(
        res, source="short.wav", expected="SOS",
        expected_source="(inline text)", tolerance=SLOPPY_TOL))
    d = _run_stub(page)

    floor, ceiling = _zoom_range(page)
    fit = d["fitOpen"]
    opened = float(fit["zoom"].split()[0])
    assert floor < opened < ceiling, (
        f"three characters opened at {opened} px/unit; expected somewhere "
        f"between the slider's {floor} and {ceiling}")
    # The readout is the honest one — the slider can only say whole numbers, so
    # the fit lands on a fraction it has to round.
    assert float(d["initial"]["zoomOut"].split()[0]) == opened

    # It fills the track: nothing left to scroll at the zoom it chose...
    assert fit["room"] == 0, \
        f"the chart still scrolls {fit['room']}px after fitting the width"
    # ...and that is the most it could have used — one px/unit further in
    # overflows. Without this, "fills the width" would also be satisfied by
    # doing nothing at all on a chart that already fit.
    assert fit["oneStepIn"]["room"] > 0, (
        "one step further in still fits, so the fit stopped short of the width "
        f"available: {fit}")

    # And the Fit button gets you back here after going in on something. It
    # earns a button because it isn't a zoom you can dial up: it depends on the
    # session and on how wide the window happens to be.
    assert fit["zoomedIn"]["room"] > 0, "zooming to the ceiling did not overflow"
    assert fit["refit"]["zoom"] == fit["zoom"], (
        f"Fit landed on {fit['refit']['zoom']!r} rather than the opening "
        f"{fit['zoom']!r}")
    assert fit["refit"]["room"] == 0, "Fit left the chart scrollable"


@node
def test_the_fit_never_zooms_past_the_sliders_ceiling(tmp_path):
    """A single character can't fill the window at any zoom the slider offers,
    so the fit stops at the top of its range instead of running away."""
    res = _decode(text="E", wpm=SLOPPY_WPM, target_wpm=SLOPPY_WPM, expected="E")
    page = tmp_path / "review.html"
    webpage.write(str(page), review.build_payload(
        res, source="tiny.wav", expected="E",
        expected_source="(inline text)", tolerance=SLOPPY_TOL))
    d = _run_stub(page)

    _, ceiling = _zoom_range(page)
    assert float(d["fitOpen"]["zoom"].split()[0]) == ceiling
    # Still short of filling the track, and that's fine — it's as far as the
    # zoom goes.
    assert d["fitOpen"]["room"] == 0


@node
def test_the_pages_json_report_matches_the_cli_schema(tmp_path):
    """A report downloaded from the page and one dumped by `--json` are the
    same shape, so a folder of both reads as one trend rather than two.

    Key-for-key, and — since the page opens at exactly the settings the CLI
    graded at — number-for-number too.
    """
    from cw_decoder import cli

    d, _ = _boot_sloppy_page(tmp_path)
    page = d["jsonReports"]["asOpened"]
    assert page, "the page produced no JSON report"

    res = core.decode_file(str(tmp_path / "sloppy.wav"), target_rate=8000,
                           target_wpm=SLOPPY_WPM, tolerance=SLOPPY_TOL,
                           expected=SLOPPY_EXPECTED)
    mine = cli._build_report(res, core.compare_text(SLOPPY_EXPECTED, res.text),
                             "(inline text)", "sloppy.wav")

    # The page adds one block for the settings only it has; everything else is
    # the CLI's schema exactly.
    assert set(page) == set(mine) | {"review"}
    for key in ("measured", "target", "analysis", "comparison"):
        assert set(page[key]) == set(mine[key]), f"{key} block drifted"
    assert set(page["analysis"]["elements"][0]) == \
        set(mine["analysis"]["elements"][0])
    assert set(page["analysis"]["deviations"][0]) == \
        set(mine["analysis"]["deviations"][0])

    # Same numbers, not just the same keys. (`generated` is when the dump was
    # taken, so it legitimately differs.)
    assert page["source"] == mine["source"] == "sloppy.wav"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00",
                        page["generated"])
    for key in ("text", "tone_hz", "sample_rate", "measured", "target",
                "analysis", "comparison"):
        _same_numbers(page[key], mine[key], key)

    rev = page["review"]
    assert rev["from"] == "web-review"
    assert rev["expected"] == SLOPPY_EXPECTED
    assert rev["collapse_rests"] is True
    # When the page itself was built, as distinct from when this dump was
    # taken: the two together say how stale the recording behind it is.
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00",
                        rev["payload_generated"])
    assert d["jsonReports"]["asOpenedName"].endswith(
        f"-{SLOPPY_WPM}wpm-report.json")


@node
def test_the_json_report_follows_the_pages_controls(tmp_path):
    """The point of downloading from the page rather than re-running the CLI:
    the dump is of the grading currently on screen, and it records the
    page-only settings that shaped it."""
    d, _ = _boot_sloppy_page(tmp_path)
    opened, regraded = (d["jsonReports"]["asOpened"],
                        d["jsonReports"]["regraded"])
    assert opened and regraded

    # The stub moved the speed, the tolerance, the intended message, and the
    # rest toggle between the two downloads.
    assert opened["target"]["char_wpm"] == SLOPPY_WPM
    assert regraded["target"]["char_wpm"] == 13
    assert regraded["target"]["unit_ms"] == pytest.approx(1200 / 13, abs=0.01)
    assert opened["analysis"]["tolerance"] == SLOPPY_TOL
    assert regraded["analysis"]["tolerance"] == 0.10
    assert regraded["review"]["expected"] == "SOS"
    # Retyping the target makes the payload's provenance a lie; say so.
    assert regraded["comparison"]["expected_source"] == \
        "(edited in the review page)"
    assert opened["comparison"]["expected_source"] == "(inline text)"

    # Rests collapsed, the long silence is out of the grading; expanded, it is
    # graded as spacing. Both the flag and its consequence are in the file.
    assert opened["review"]["collapse_rests"] is True
    assert opened["analysis"]["pauses_ignored"] >= 1
    assert regraded["review"]["collapse_rests"] is False
    assert regraded["analysis"]["pauses_ignored"] == 0
    assert (regraded["analysis"]["within_tolerance_frac"] !=
            opened["analysis"]["within_tolerance_frac"])
    # And the filename distinguishes the two, so they don't collide on disk.
    assert d["jsonReports"]["regradedName"].endswith("-13wpm-report.json")
    assert (d["jsonReports"]["regradedName"] !=
            d["jsonReports"]["asOpenedName"])


def test_write_returns_size(tmp_path):
    res = _decode(target_wpm=22)
    p = review.build_payload(res, source="x.wav")
    out = tmp_path / "review.html"
    size = webpage.write(str(out), p)
    assert size == out.stat().st_size > 10_000


# --------------------------------------------------------------------------- #
# CLI wiring
# --------------------------------------------------------------------------- #
# `no_browser` — the list of URLs the CLI would have opened — is an autouse
# fixture in conftest.py, since the page is the default output and no test
# should be able to launch a real browser by forgetting it.
def _copy_recorder(src, seen=None):
    """A fake capture.record that copies `src` and reports back like the real one."""
    def fake_record(dev, out, **kw):
        if seen is not None:
            seen.update(kw)
        shutil.copyfile(src, out)
        from cw_decoder import capture
        return capture.wav_rate(str(out)) or 8000, "stub", []
    return fake_record


def _fixture_wav(tmp_path, text="CQ DE AB1CD", wpm=20):
    wav = tmp_path / "in.wav"
    synth.write_wav(str(wav), synth.generate(text, wpm=wpm, tone=600,
                                             rate=8000), 8000)
    return wav


# --------------------------------------------------------------------------- #
# What the tool does when you don't tell it: open the review page, and record
# if there's nothing to decode.
# --------------------------------------------------------------------------- #
def test_the_review_page_is_the_default_output(tmp_path, no_browser, capsys,
                                               monkeypatch):
    """No flags at all: the page is the report, and the terminal keeps only the
    decoded text."""
    from cw_decoder import cli

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("os.path.expanduser",
                        lambda p: p.replace("~", str(tmp_path), 1))
    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "--color", "never"]) == 0
    cap = capsys.readouterr()

    pages = list((tmp_path / ".cw-decoder" / "sessions").glob("*/review.html"))
    assert len(pages) == 1
    assert no_browser == [pages[0].resolve().as_uri()]
    assert cap.out.strip() == "CQ DE AB1CD"
    assert "practice report" not in cap.out


def test_live_capture_is_the_default_with_no_input_file(tmp_path, monkeypatch,
                                                        no_browser, capsys):
    """Nothing to decode means there is something to record."""
    from cw_decoder import capture, cli

    src = _fixture_wav(tmp_path)
    seen = {}
    monkeypatch.setattr(
        capture, "list_audio_devices",
        lambda backend="auto": [capture.Device(0, "Stub Input", "48000 Hz")])
    monkeypatch.setattr(capture, "record", _copy_recorder(src, seen))
    # No --live, and no file to decode.
    assert cli.main(["-D", "0", "-w", "20", "-q"]) == 0
    assert seen, "nothing was recorded"
    assert "recording on device" in capsys.readouterr().err


def test_an_input_file_opts_out_of_the_live_capture(tmp_path, monkeypatch,
                                                    no_browser, capsys):
    from cw_decoder import capture, cli

    recorded = []
    monkeypatch.setattr(capture, "record",
                        lambda *a, **k: recorded.append(1))
    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "-q"]) == 0
    assert capsys.readouterr().out.strip() == "CQ DE AB1CD"
    assert recorded == []


def test_live_and_an_input_file_together_are_refused(tmp_path, capsys):
    """Two sources of audio, and no sensible way to pick one."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["--live", str(wav)])
    assert "don't also pass an input file" in capsys.readouterr().err


def test_json_and_basic_together_are_refused(capsys):
    from cw_decoder import cli

    with pytest.raises(SystemExit):
        cli.main(["--json", "--basic", "--demo", "PARIS"])
    assert "pick one" in capsys.readouterr().err


def test_preview_no_longer_needs_the_live_flag(capsys):
    """--live is the default, so --preview on its own is not a contradiction.
    It gets as far as the check it should: the one for a target speed."""
    from cw_decoder import cli

    assert cli.main(["--preview"]) == 1
    assert "--preview requires a target speed" in capsys.readouterr().err


def test_preview_is_still_refused_when_decoding_a_file(tmp_path, capsys):
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["--preview", "-w", "20", str(wav)])
    assert "only applies to a live capture" in capsys.readouterr().err


def test_json_report_says_what_it_decoded_and_when(tmp_path, capsys):
    """Provenance, so a directory of dumps reads as a time series."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "--json"]) == 0
    d = json.loads(capsys.readouterr().out)
    assert d["source"] == wav.name
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00",
                        d["generated"])


def test_cli_web_out_implies_review(tmp_path, no_browser, capsys):
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    out = tmp_path / "sub" / "r.html"          # a directory that doesn't exist
    assert cli.main([str(wav), "-w", "20", "--web-out", str(out)]) == 0
    assert out.is_file()
    assert no_browser == [out.resolve().as_uri()]
    cap = capsys.readouterr()
    assert "web review" in cap.err and "KB" in cap.err
    assert "CQ DE AB1CD" in cap.out       # the usual stdout output is unchanged


def test_cli_web_review_defaults_to_session_dir(tmp_path, no_browser,
                                                monkeypatch):
    from cw_decoder import cli

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("os.path.expanduser",
                        lambda p: p.replace("~", str(tmp_path), 1))
    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "--web-review"]) == 0
    pages = list((tmp_path / ".cw-decoder" / "sessions").glob("*/review.html"))
    assert len(pages) == 1
    assert pages[0].stat().st_size > 10_000
    assert no_browser == [pages[0].resolve().as_uri()]


@pytest.mark.parametrize("flag", ["--basic", "--json", "-q"])
def test_the_review_page_can_be_opted_out_of(tmp_path, no_browser, capsys,
                                             flag):
    """Each of the three report flags means "not the page"."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", flag]) == 0
    capsys.readouterr()
    assert no_browser == []
    assert list(tmp_path.glob("*.html")) == []


def test_cli_web_review_carries_the_expected_text(tmp_path, no_browser):
    """A sibling .txt is picked up and lands in the page as the target."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    (tmp_path / "in.txt").write_text("CQ DE AB1CD")
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "--web-out", str(out)]) == 0
    html = out.read_text(encoding="utf-8")
    assert '"expected":"CQ DE AB1CD"' in html
    assert "in.txt" in html


def test_cli_web_review_works_without_a_target_speed(tmp_path, no_browser):
    """No -w: the page still opens, targeting the sender's own measured speed."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path, wpm=18)
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "--web-out", str(out)]) == 0
    assert '"explicit":false' in out.read_text(encoding="utf-8")


def test_cli_web_review_with_demo(tmp_path, no_browser):
    from cw_decoder import cli

    out = tmp_path / "r.html"
    assert cli.main(["--demo", "PARIS PARIS", "-w", "20",
                     "--web-out", str(out)]) == 0
    assert out.is_file()
    assert '"source":"--demo"' in out.read_text(encoding="utf-8")


def test_live_web_review_keeps_the_recording(tmp_path, no_browser, capsys,
                                             monkeypatch):
    """A live take is otherwise gone, so the page gets a plain WAV beside it."""
    from cw_decoder import capture, cli

    src = _fixture_wav(tmp_path, text="CQ DE AB1CD", wpm=20)

    # Stand in for the sound card: "recording" just copies the fixture over.
    # record() reports back the rate it captured at, the backend, and any
    # glitches the backend noticed.
    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input", "48000 Hz")])
    monkeypatch.setattr(capture, "record", _copy_recorder(src))

    out = tmp_path / "live" / "review.html"
    assert cli.main(["--live", "-D", "0", "-w", "20",
                     "--web-out", str(out)]) == 0
    assert out.is_file()
    wav = out.parent / "session.wav"
    assert wav.is_file() and wav.stat().st_size > 1000
    assert "saved recording to" in capsys.readouterr().err


def test_live_web_review_defers_to_explicit_save(tmp_path, no_browser,
                                                 monkeypatch):
    """With --save, don't also drop a session.wav next to the page."""
    from cw_decoder import capture, cli

    src = _fixture_wav(tmp_path, text="CQ DE AB1CD", wpm=20)
    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input", "48000 Hz")])
    monkeypatch.setattr(capture, "record", _copy_recorder(src))

    out = tmp_path / "live" / "review.html"
    keep = tmp_path / "mine.wav"
    assert cli.main(["--live", "-D", "0", "-w", "20", "--save", str(keep),
                     "--web-out", str(out)]) == 0
    assert keep.is_file()
    assert not (out.parent / "session.wav").exists()


def test_web_review_suppresses_the_practice_report(tmp_path, no_browser,
                                                   capsys):
    """The page is the report, so don't print it to the terminal as well."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "-e", "CQ DE AB1CD",
                     "--web-out", str(out)]) == 0
    cap = capsys.readouterr()
    # The decoded text is still the primary output.
    assert cap.out.strip() == "CQ DE AB1CD"
    for gone in ("practice report", "character speed", "consistency",
                 "accuracy", "element / spacing", "tone"):
        assert gone not in cap.out
    # But the stderr line naming the page still appears — that's not the report.
    assert "web review" in cap.err
    assert out.is_file()


def test_basic_prints_the_terminal_report(tmp_path, capsys, no_browser):
    """Regression guard: the suppression must not leak into --basic runs."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "--basic", "--color", "never"]) == 0
    out = capsys.readouterr().out
    assert "practice report" in out
    assert "consistency" in out
    assert "CQ DE AB1CD" in out
    assert no_browser == []


def test_basic_and_the_page_can_be_asked_for_together(tmp_path, capsys,
                                                      no_browser):
    """--basic names the terminal report; asking for the page back with
    --web-review shouldn't take it away again."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "--basic", "--color", "never",
                     "--web-out", str(out)]) == 0
    assert "practice report" in capsys.readouterr().out
    assert out.is_file()
    assert no_browser == [out.resolve().as_uri()]


def test_json_survives_web_review(tmp_path, no_browser, capsys):
    """--json is an explicit machine-readable request; the page doesn't cancel
    it. Only the human-readable report is suppressed."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "--json",
                     "--web-out", str(out)]) == 0
    cap = capsys.readouterr()
    d = json.loads(cap.out)                    # entire stdout is still JSON
    assert d["text"].strip() == "CQ DE AB1CD"
    assert d["analysis"]["elements"]
    assert out.is_file()


def _fake_device(monkeypatch, native_rate=48000, seen=None,
                 text="CQ DE AB1CD"):
    """Stand in for the sound card. Records at its own rate unless forced.

    That mirrors ffmpeg: with no `-ar` it captures at the device's native rate
    and writes that rate into the WAV header.
    """
    from cw_decoder import capture

    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input", "48000 Hz")])

    def fake_record(dev, out, **kw):
        if seen is not None:
            seen.update(kw)
        rate = int(kw.get("rate") or native_rate)
        synth.write_wav(out, synth.generate(text, wpm=20, tone=600, rate=rate),
                        rate)
        return rate, "stub", []

    monkeypatch.setattr(capture, "record", fake_record)


def test_live_capture_does_not_force_a_rate(tmp_path, monkeypatch, no_browser):
    """Never resample at capture.

    Forcing a rate makes ffmpeg resample every sample; on a square-ish keyer
    sidetone that lifts the noise between the harmonics ~6 dB and sounds
    rough. The device's own rate is passed straight through, and the decoder
    resamples to 8 kHz internally for the DSP only.
    """
    import wave

    from cw_decoder import cli

    seen = {}
    _fake_device(monkeypatch, native_rate=48000, seen=seen)
    out = tmp_path / "live" / "review.html"
    assert cli.main(["--live", "-D", "0", "-w", "20",
                     "--web-out", str(out)]) == 0

    assert seen["rate"] is None, "the CLI forced a capture rate"

    wav = out.parent / "session.wav"
    assert wav.is_file()
    with wave.open(str(wav)) as w:
        assert w.getframerate() == 48000      # the device's rate, untouched

    html = out.read_text(encoding="utf-8")
    assert '"audio_rate":48000' in html       # embedded at the device's rate
    assert '"rate":8000' in html              # while segments stay at 8 kHz


def test_capture_rate_can_still_be_forced(tmp_path, monkeypatch):
    """An explicit --capture-rate is honored (and does resample)."""
    from cw_decoder import cli

    seen = {}
    _fake_device(monkeypatch, native_rate=48000, seen=seen)
    assert cli.main(["--live", "-D", "0", "-w", "20", "-q",
                     "--capture-rate", "22050"]) == 0
    assert seen["rate"] == 22050


class _StubSoundDevice:
    """A stand-in for the `sounddevice` module.

    Feeds a known signal through the real _PortAudioStream/capture_samples
    code, so the backend is exercised end-to-end without opening the machine's
    audio hardware.
    """

    def __init__(self, sig, rate=48000, channels=1, block=1024,
                 overflow_at=None):
        self._sig = sig
        self._rate = rate
        self._channels = channels
        self._block = block
        self._overflow_at = overflow_at
        self.opened = None

    def query_devices(self, device=None, kind=None):
        info = {"name": "stub", "max_input_channels": self._channels,
                "default_samplerate": self._rate, "hostapi": 0}
        return info if device is not None else [info]

    def query_hostapis(self, i=0):
        return {"name": "stub-api"}

    def InputStream(self, **kw):                       # noqa: N802 - stub API
        self.opened = kw
        stub = self

        class _S:
            def start(self):
                cb = kw["callback"]
                n = 0
                for i in range(0, stub._sig.size, stub._block):
                    chunk = stub._sig[i:i + stub._block]
                    status = ("input overflow"
                              if stub._overflow_at == n else None)
                    cb(chunk.reshape(-1, kw["channels"]) if kw["channels"] > 1
                       else chunk.reshape(-1, 1), chunk.size, None, status)
                    n += 1

            def stop(self):
                pass

            def close(self):
                pass

        return _S()


def test_portaudio_backend_captures_and_reports_overflows(monkeypatch,
                                                          tmp_path):
    """The preferred backend records the device's own format and reports glitches.

    PortAudio surfaces input overflow through the callback status, which is why
    it's preferred over ffmpeg: a dropped buffer becomes a message instead of
    something you find by ear.
    """
    from cw_decoder import capture

    sig = synth.generate("CQ DE AB1CD", wpm=20, tone=600, rate=48000)
    stub = _StubSoundDevice(sig, rate=48000)
    monkeypatch.setattr(capture, "_sounddevice", lambda: stub)
    monkeypatch.setattr(capture, "available_backends",
                        lambda: ["portaudio", "ffmpeg"])

    out = tmp_path / "cap.wav"
    rate, backend, problems = capture.record(0, str(out), backend="portaudio",
                                       max_seconds=0.5)
    assert (rate, backend, problems) == (48000, "portaudio", [])
    assert capture.wav_rate(str(out)) == 48000

    # Nothing is asked of the driver but the device's own format: no rate
    # conversion, no downmix, and a generous buffer.
    assert stub.opened["samplerate"] == 48000
    assert stub.opened["dtype"] == "float32"
    assert stub.opened["latency"] == "high"
    assert stub.opened["blocksize"] == 0

    # It decodes, which means the samples arrived intact and in order.
    assert "CQ DE AB1CD" in core.decode_file(str(out)).text

    # And an overflow is reported rather than swallowed.
    stub2 = _StubSoundDevice(sig, rate=48000, overflow_at=3)
    monkeypatch.setattr(capture, "_sounddevice", lambda: stub2)
    _, _, problems = capture.record(0, str(out), backend="portaudio",
                                       max_seconds=0.5)
    assert any("overflow" in p for p in problems)


def test_capture_backend_ships_by_default():
    """`--live` is a headline feature, so its capture library isn't an extra.

    The ffmpeg fallback drops audio buffers on real hardware, so a default
    install that only had ffmpeg would ship a broken primary path.
    """
    import tomllib

    with open(Path(__file__).parent.parent / "pyproject.toml", "rb") as fh:
        cfg = tomllib.load(fh)
    deps = " ".join(cfg["project"]["dependencies"])
    assert "sounddevice" in deps, "capture must not be an optional extra"
    extras = cfg["project"].get("optional-dependencies", {})
    assert "live" not in extras, "the 'live' extra is gone; don't reintroduce it"


def test_capture_import_is_lazy():
    """Decoding a file shouldn't pay for the audio stack.

    `sounddevice` opens PortAudio on import, which is slow and can warn on a
    headless box, so it's imported inside the backend lookup instead.
    """
    import subprocess
    import sys

    probe = ("import sys, cw_decoder.capture, cw_decoder.core;"
             "print('sounddevice' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", probe],
                         capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False", "capture.py imported sounddevice eagerly"


def test_portaudio_is_preferred_and_backends_are_selectable(monkeypatch):
    from cw_decoder import capture

    monkeypatch.setattr(capture, "_sounddevice", lambda: object())
    monkeypatch.setattr(capture, "shutil", shutil)
    monkeypatch.setattr(capture, "available_backends",
                        lambda: ["portaudio", "ffmpeg"])
    assert capture.resolve_backend("auto") == "portaudio"
    assert capture.resolve_backend("ffmpeg") == "ffmpeg"

    # An unavailable backend explains itself rather than failing obscurely.
    monkeypatch.setattr(capture, "available_backends", lambda: ["ffmpeg"])
    assert capture.resolve_backend("auto") == "ffmpeg"
    with pytest.raises(RuntimeError, match="PortAudio"):
        capture.resolve_backend("portaudio")

    monkeypatch.setattr(capture, "available_backends", lambda: [])
    with pytest.raises(RuntimeError, match="no live-capture backend"):
        capture.resolve_backend("auto")
    with pytest.raises(RuntimeError, match="unknown capture backend"):
        capture.resolve_backend("nonsense")


def test_portaudio_capture_folds_a_stereo_device(monkeypatch, tmp_path):
    """A stereo device is folded by us, after capture, not by the driver."""
    from cw_decoder import capture

    mono = synth.generate("TEST", wpm=20, tone=600, rate=48000)
    stub = _StubSoundDevice(mono, rate=48000, channels=2)
    monkeypatch.setattr(capture, "_sounddevice", lambda: stub)
    monkeypatch.setattr(capture, "available_backends", lambda: ["portaudio"])

    out = tmp_path / "st.wav"
    rate, _, _ = capture.record(0, str(out), backend="portaudio",
                                       max_seconds=0.5)
    assert rate == 48000
    # channels=1 is requested of the driver; folding of anything wider happens
    # in to_mono afterwards.
    assert stub.opened["channels"] == 1


def test_stream_format_is_read_from_ffmpegs_header():
    """Preview mode learns the device's rate AND channels from the pipe header.

    That's what lets it stream the device's native format without forcing one
    — forcing either makes ffmpeg convert mid-capture.
    """
    import io

    from cw_decoder import capture

    def wav_header(rate, channels=1, extra=b""):
        fmt = (b"\x03\x00" + channels.to_bytes(2, "little")
               + rate.to_bytes(4, "little")
               + (rate * 4 * channels).to_bytes(4, "little")
               + (4 * channels).to_bytes(2, "little") + b"\x20\x00")
        return (b"RIFF\xff\xff\xff\xffWAVE"
                + extra
                + b"fmt " + len(fmt).to_bytes(4, "little") + fmt
                + b"data\xff\xff\xff\xff")

    for rate in (48000, 44100, 96000):
        for ch in (1, 2):
            pipe = io.BytesIO(wav_header(rate, ch) + b"\x00" * 64)
            assert capture._read_stream_format(pipe) == (rate, ch)

    # Chunks before `fmt ` are skipped, including an odd-length one (which is
    # word-aligned with a pad byte on the wire).
    lst = b"LIST\x05\x00\x00\x00INFO\x00\x00"
    pipe = io.BytesIO(wav_header(48000, 2, extra=lst) + b"\x00" * 64)
    assert capture._read_stream_format(pipe) == (48000, 2)

    # A stream that isn't WAV at all is reported, not silently misread.
    with pytest.raises(RuntimeError, match="unexpected audio stream header"):
        capture._read_stream_format(io.BytesIO(b"\x00" * 64))


class _ScriptedStream:
    """A LiveStream whose blocks arrive on a schedule the test controls.

    Models the real backends' shape: a queue a driver fills asynchronously,
    which `read` drains one block at a time and returns empty when there's
    nothing waiting. That's what lets a test say "this much audio was already
    queued when the user hit Ctrl-R".
    """

    def __init__(self, rate=8000, channels=1):
        import collections
        self.rate, self.channels, self.backend = rate, channels, "scripted"
        self._q = collections.deque()
        self._problems = []
        self.stopped = False

    def feed(self, value, blocks=1, size=64):
        import numpy as np
        for _ in range(blocks):
            self._q.append(np.full(size, value, dtype=np.float32))

    def read(self, timeout=0.2):
        import numpy as np
        return self._q.popleft() if self._q else np.zeros(0, dtype=np.float32)

    def stop(self):
        self.stopped = True

    def drain(self):
        import numpy as np
        return np.zeros(0, dtype=np.float32)

    def problems(self):
        return list(self._problems)

    def forget_problems(self):
        self._problems.clear()


def test_ctrl_r_restarts_the_take_on_the_same_stream(monkeypatch):
    """Ctrl-R throws the take away and starts over without reopening anything.

    The value in each block marks which take it came from, so the returned
    audio says exactly what survived.
    """
    import numpy as np

    from cw_decoder import capture

    stream = _ScriptedStream()
    monkeypatch.setattr(capture, "open_stream",
                        lambda *a, **kw: stream)

    stream.feed(1.0, blocks=3)               # take one
    stream._problems.append("input overflow")  # ...and a glitch during it
    restarts = []

    # One entry per pass of the capture loop. By the time "restart" fires, two
    # take-one blocks have been read and a third is still sitting in the
    # queue — that one has to be discarded too, not folded into take two.
    script = ["", "restart", "feed", "", "", "", "", "stop"]

    def fake_key():
        step = script.pop(0) if script else "stop"
        if step == "feed":                   # take two starts arriving
            stream.feed(2.0, blocks=4)
            return None
        return step or None

    monkeypatch.setattr(capture, "_read_key", fake_key)

    sig, rate, backend, problems = capture.capture_samples(
        0, max_seconds=30, on_restart=restarts.append)

    # Only take two came back, and all of it: the clock restarted too, or the
    # 30-second cap would have fired straight after the restart.
    assert np.unique(sig).tolist() == [2.0]
    assert sig.size == 4 * 64
    # One restart, numbered so the CLI can say "take 2".
    assert restarts == [1]
    # The glitch belonged to the take that was thrown away.
    assert problems == []
    assert (rate, backend) == (8000, "scripted")
    assert stream.stopped                    # still shut down cleanly


def test_restart_keys_are_the_only_special_ones(monkeypatch):
    """Enter stops, Ctrl-R restarts, and a stray key does neither.

    "Any input stops" was fine when a line-buffered terminal meant you had to
    press Enter for anything to arrive at all. Now that single keys come
    through immediately, an arrow key must not end a take.
    """
    from cw_decoder import capture

    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    # pytest's stdin has no fileno, and io.UnsupportedOperation is an OSError,
    # so without this every read would be swallowed as "nothing pressed".
    monkeypatch.setattr(sys.stdin, "fileno", lambda: 0, raising=False)
    reads = {}
    monkeypatch.setattr(capture.select, "select",
                        lambda *a: ([sys.stdin], [], []))
    monkeypatch.setattr(capture.os, "read",
                        lambda fd, n: reads["buf"])

    for buf, want in [
        (b"\r", "stop"),                     # Enter
        (b"\n", "stop"),
        (b"\x04", "stop"),                   # Ctrl-D
        (b"\x12", "restart"),                # Ctrl-R
        (b"x", None),                        # a stray letter
        (b"\x1b[C", None),                   # right arrow
        (b"\x12\r", "restart"),              # both at once: restart wins
    ]:
        reads["buf"] = buf
        assert capture._read_key() == want, f"{buf!r} should read as {want}"


def test_raw_keys_restores_the_terminal(monkeypatch):
    """cbreak mode is a loan, not a purchase — and a no-op off a terminal."""
    from cw_decoder import capture

    # Not a tty: nothing is touched, so piping input can't wedge the terminal.
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)
    with capture.raw_keys():
        pass

    termios = pytest.importorskip("termios")
    calls = []
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr(sys.stdin, "fileno", lambda: 0, raising=False)
    monkeypatch.setattr(termios, "tcgetattr", lambda fd: "SAVED")
    monkeypatch.setattr(termios, "tcsetattr",
                        lambda fd, when, attrs: calls.append(attrs))
    import tty
    monkeypatch.setattr(tty, "setcbreak", lambda fd: calls.append("cbreak"))

    with pytest.raises(RuntimeError):
        with capture.raw_keys():
            raise RuntimeError("boom")
    # Restored even when the body blows up, or Ctrl-C would leave no echo.
    assert calls == ["cbreak", "SAVED"]


def test_capture_folds_multichannel_to_mono():
    """Interleaved frames are folded by us, not by the capture backend.

    Asking the backend to downmix puts a conversion in the realtime path,
    which is a chance for it to fall behind and drop a buffer.
    """
    import numpy as np

    from cw_decoder import capture

    stereo = np.array([1.0, 3.0, 5.0, 7.0, 9.0, 11.0], dtype=np.float32)
    assert list(capture.to_mono(stereo, 2)) == [2.0, 6.0, 10.0]
    assert capture.to_mono(stereo, 1) is stereo          # mono is a no-op
    # A partial trailing frame is dropped rather than mis-aligning the rest.
    odd = np.array([1.0, 3.0, 5.0], dtype=np.float32)
    assert list(capture.to_mono(odd, 2)) == [2.0]


def _quiet_wav(path, peak=0.04, rate=44100, text="CQ DE AB1CD"):
    """A realistically quiet recording — a live capture sits ~30 dB down."""
    import numpy as np

    sig = synth.generate(text, wpm=20, tone=600, rate=rate) * peak
    synth.write_wav(str(path), sig.astype(np.float32), rate)
    return float(np.max(np.abs(sig)))


def test_playback_audio_preserves_the_recorded_level(tmp_path):
    """The page must play the recording, not a ~30 dB boost of it.

    The decode path peak-normalizes on purpose (the Otsu threshold works on
    absolute amplitude), but reusing that signal for playback made a quiet
    capture blare, and made the download differ from what was recorded.
    """
    import numpy as np

    src = tmp_path / "quiet.wav"
    peak = _quiet_wav(src, peak=0.04)
    res = core.decode_file(str(src), target_rate=8000, keep_signal=True)

    # The decode copy is normalized — that's what it's for.
    assert float(np.max(np.abs(res.signal))) == pytest.approx(1.0, abs=0.02)

    # The playback copy is not: it keeps the level it was recorded at.
    sig, rate = review.playback_audio(res, str(src))
    assert rate == 44100
    assert float(np.max(np.abs(sig))) == pytest.approx(peak, rel=0.05)

    # And the payload reports that peak so the page can set a listening gain
    # instead of the samples having one baked in.
    p = review.build_payload(res, source="quiet.wav", audio_path=str(src))
    assert p["audio_peak"] == pytest.approx(peak, rel=0.05)
    assert p["audio_rate"] == 44100
    assert p["rate"] == 8000              # segments still measured at 8 kHz


def test_playback_audio_rate_selection(tmp_path):
    """Embed the source's own rate, capped — never invent bandwidth."""
    hi = tmp_path / "hi.wav"
    _quiet_wav(hi, rate=44100)
    res = core.decode_file(str(hi), target_rate=8000, keep_signal=True)
    assert review.playback_audio(res, str(hi))[1] == 44100

    lo = tmp_path / "lo.wav"
    _quiet_wav(lo, rate=8000)
    res2 = core.decode_file(str(lo), target_rate=8000, keep_signal=True)
    assert review.playback_audio(res2, str(lo))[1] == 8000   # no upsampling

    # No path at all (a synthesized --demo): fall back to the decode copy.
    assert review.playback_audio(res2, None)[1] == 8000
    assert review.PLAYBACK_RATE_CAP >= 96000   # never resample real device rates


def test_decode_is_unaffected_by_the_playback_change(tmp_path):
    """Normalization still happens where the decoder needs it."""
    src = tmp_path / "quiet.wav"
    _quiet_wav(src, peak=0.02, text="CQ CQ DE W7YFR K")
    res = core.decode_file(str(src), target_rate=8000, target_wpm=20)
    assert res.text.strip() == "CQ CQ DE W7YFR K"   # a very quiet clip decodes


def _padded_device(monkeypatch, devices, lead=4.0, tail=3.0, rate=8000,
                   text="CQ DE AB1CD"):
    """A fake device whose capture has dead air at both ends."""
    import numpy as np

    from cw_decoder import capture

    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": devices)

    def fake_record(dev, out, **kw):
        keyed = synth.generate(text, wpm=20, tone=600, rate=rate)
        sig = np.concatenate([np.zeros(int(lead * rate), np.float32), keyed,
                              np.zeros(int(tail * rate), np.float32)])
        synth.write_wav(out, sig, rate)
        return rate, "stub", []

    monkeypatch.setattr(capture, "record", fake_record)


def test_live_trims_dead_air_to_the_padding(tmp_path, monkeypatch, capsys):
    """A live take shouldn't carry seconds of silence before you start keying."""
    import wave

    from cw_decoder import capture, cli

    lead, tail = 4.0, 3.0
    _padded_device(monkeypatch, [capture.Device(0, "Stub Input")],
                   lead=lead, tail=tail)
    save = tmp_path / "take.wav"
    assert cli.main(["--live", "-D", "0", "-w", "20",
                     "--save", str(save)]) == 0

    with wave.open(str(save)) as w:
        secs = w.getnframes() / w.getframerate()
    # Derive the expectation rather than hardcoding it: the keying itself plus
    # the default padding either side, and well short of the padded original.
    keyed = synth.generate("CQ DE AB1CD", wpm=20, tone=600, rate=8000).size / 8000
    want = keyed + 2 * core.TRIM_PAD
    assert secs == pytest.approx(want, abs=0.4), \
        f"trimmed to {secs:.2f}s, expected ~{want:.2f}s"
    assert secs < keyed + lead + tail - 4.0
    assert "trimmed" in capsys.readouterr().err
    # And it still decodes, so the trim didn't clip the keying.
    assert "CQ DE AB1CD" in core.decode_file(str(save)).text


def test_ctrl_c_discards_the_take(tmp_path, monkeypatch, capsys, no_browser):
    """Ctrl-C abandons the run: no decode, no grade, no review page.

    Enter is the "I'm done" key. Interrupting used to fall through to the full
    evaluation on a take you meant to throw away.
    """
    from cw_decoder import capture, cli

    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input")])

    def interrupted(dev, out, **kw):
        # A real capture writes as it goes, so leave a partial file behind.
        synth.write_wav(out, synth.generate("CQ", wpm=20, tone=600,
                                            rate=8000), 8000)
        raise KeyboardInterrupt

    monkeypatch.setattr(capture, "record", interrupted)

    out = tmp_path / "session" / "review.html"
    rc = cli.main(["--live", "-D", "0", "-w", "20", "--web-out", str(out)])
    cap = capsys.readouterr()

    assert rc == 130                          # conventional for SIGINT
    assert "canceled" in cap.err
    assert cap.out.strip() == ""              # nothing decoded
    assert not out.exists()                   # no review page
    assert not (out.parent / "session.wav").exists()   # recording thrown away
    assert no_browser == []                   # and no browser opened


def test_ctrl_c_removes_a_session_dir_it_created(tmp_path, monkeypatch,
                                                 no_browser, isolated_home):
    """The default session directory is ours to clean up; a chosen path is not."""
    from cw_decoder import capture, cli

    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input")])

    def interrupted(dev, out, **kw):
        raise KeyboardInterrupt

    monkeypatch.setattr(capture, "record", interrupted)
    assert cli.main(["--live", "-D", "0", "-w", "20", "--web-review"]) == 130
    sessions = isolated_home / ".cw-decoder" / "sessions"
    assert list(sessions.glob("*")) == [], "left an empty session directory"

    # A directory the user named is left alone, even when empty.
    chosen = tmp_path / "mine"
    assert cli.main(["--live", "-D", "0", "-w", "20",
                     "--web-out", str(chosen / "r.html")]) == 130
    assert chosen.is_dir()


def test_ctrl_c_does_not_remember_the_device(tmp_path, monkeypatch):
    """A canceled take shouldn't teach it a device preference."""
    from cw_decoder import capture, cli

    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input")])
    monkeypatch.setattr(capture, "record",
                        lambda dev, out, **kw: (_ for _ in ()).throw(
                            KeyboardInterrupt()))
    assert cli.main(["--live", "-D", "0", "-q"]) == 130
    assert cli._remembered_device("portaudio") is None


def test_target_audio_gets_the_same_padding(tmp_path, no_browser):
    """The generated target shouldn't stop dead on its last element."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    out = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "--web-out", str(out)]) == 0
    assert f'"pad_sec":{core.TRIM_PAD:g}' in out.read_text(encoding="utf-8")

    # And it tracks --trim-pad, so the two files stay consistent.
    assert cli.main([str(wav), "-w", "20", "--trim-pad", "1.5",
                     "--web-out", str(out)]) == 0
    assert '"pad_sec":1.5' in out.read_text(encoding="utf-8")


@node
def test_target_playback_is_padded_not_just_the_download(tmp_path, no_browser):
    """Live target playback must carry the padding too.

    The download applied it while playTarget() didn't, so the tone was
    scheduled to stop the moment the last element ended — audibly cut off.
    """
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path, text="CQ DE AB1CD K")
    page = tmp_path / "r.html"
    assert cli.main([str(wav), "-w", "20", "-e", "CQ DE AB1CD K",
                     "--web-out", str(page)]) == 0
    html = page.read_text(encoding="utf-8")
    payload = json.loads(re.search(r"window\.REVIEW = (\{.*?\});", html,
                                   re.S).group(1).replace("\\u003c", "<"))

    # What the ideal keying itself measures, from the same code the page runs.
    ideal = _run_js("""
      const t = RC.targetTiming(PAYLOAD.target.char_wpm,
                                PAYLOAD.target.farnsworth_wpm);
      console.log(JSON.stringify({
        duration: RC.idealTimeline(PAYLOAD.expected, t).duration }));
    """, payload)["duration"]

    stub = Path(__file__).parent / "dom_stub.js"
    proc = subprocess.run(["node", str(stub), str(page)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    span = json.loads(proc.stdout)["audio"]["targetPlaySeconds"]

    pad = payload["pad_sec"]
    assert span == pytest.approx(ideal + 2 * pad, abs=0.1), (
        f"target scheduled for {span:.2f}s; keying is {ideal:.2f}s and should "
        f"carry {pad}s either side")
    # The specific regression: it must not end at the last element.
    assert span > ideal + pad


def test_live_trim_is_configurable_and_optional(tmp_path, monkeypatch):
    import wave

    from cw_decoder import capture, cli

    def secs(path):
        with wave.open(str(path)) as w:
            return w.getnframes() / w.getframerate()

    _padded_device(monkeypatch, [capture.Device(0, "Stub Input")])

    wide = tmp_path / "wide.wav"
    assert cli.main(["--live", "-D", "0", "-q", "--trim-pad", "2",
                     "--save", str(wide)]) == 0
    tight = tmp_path / "tight.wav"
    assert cli.main(["--live", "-D", "0", "-q", "--trim-pad", "0.1",
                     "--save", str(tight)]) == 0
    raw = tmp_path / "raw.wav"
    assert cli.main(["--live", "-D", "0", "-q", "--no-trim",
                     "--save", str(raw)]) == 0

    assert secs(tight) < secs(wide) < secs(raw)
    assert secs(raw) > 9.0            # the original, dead air and all


# --------------------------------------------------------------------------- #
# Remembering the input device
# --------------------------------------------------------------------------- #
def test_device_is_remembered_by_name(tmp_path, monkeypatch, capsys):
    """Indices shift when hardware comes and goes; names don't."""
    from cw_decoder import capture, cli

    devices = [capture.Device(4, "USB Advanced Audio Device", "48000 Hz"),
               capture.Device(7, "MacBook Pro Microphone")]
    _padded_device(monkeypatch, devices)

    # Choose once by index.
    assert cli.main(["--live", "-D", "4", "-q"]) == 0
    assert cli._remembered_device("portaudio") == "USB Advanced Audio Device"

    # Next time, no -D needed — and it follows the *name* even though the
    # device has been re-indexed.
    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [
                            capture.Device(0, "MacBook Pro Microphone"),
                            capture.Device(2, "USB Advanced Audio Device")])
    capsys.readouterr()
    assert cli.main(["--live", "-q"]) == 0
    err = capsys.readouterr().err
    assert "remembered device [2] USB Advanced Audio Device" in err


def test_unavailable_remembered_device_falls_back_to_the_chooser(
        tmp_path, monkeypatch, capsys):
    """Unplugged the interface? Say so and offer the list again."""
    from cw_decoder import capture, cli

    _padded_device(monkeypatch, [capture.Device(4, "USB Advanced Audio Device")])
    assert cli.main(["--live", "-D", "4", "-q"]) == 0

    # That device is now gone.
    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [
                            capture.Device(0, "MacBook Pro Microphone")])
    capsys.readouterr()
    assert cli.main(["--live", "-q"]) == 1        # non-tty: can't prompt
    err = capsys.readouterr().err
    assert "remembered device is not available: USB Advanced Audio Device" in err
    assert "audio input devices" in err           # the chooser is shown
    assert "[0] MacBook Pro Microphone" in err


def test_device_can_be_named_or_reselected(tmp_path, monkeypatch, capsys):
    """-D takes a name or part of one; '-D ask' forgets and re-prompts."""
    from cw_decoder import capture, cli

    devices = [capture.Device(4, "USB Advanced Audio Device"),
               capture.Device(6, "BlackHole 2ch"),
               capture.Device(7, "MacBook Pro Microphone")]
    _padded_device(monkeypatch, devices)

    # A case-insensitive fragment is enough when it's unambiguous.
    assert cli.main(["--live", "-D", "blackhole", "-q"]) == 0
    assert cli._remembered_device("portaudio") == "BlackHole 2ch"

    # An ambiguous fragment is reported rather than guessed at.
    capsys.readouterr()
    assert cli.main(["--live", "-D", "o", "-q"]) == 1
    assert "matches several devices" in capsys.readouterr().err

    # A name that matches nothing, and an index that doesn't exist.
    assert cli.main(["--live", "-D", "nonesuch", "-q"]) == 1
    assert "no device matching" in capsys.readouterr().err
    assert cli.main(["--live", "-D", "99", "-q"]) == 1
    assert "no device with index 99" in capsys.readouterr().err

    # '-D ask' clears the memory and falls to the chooser (non-tty -> exit 1).
    assert cli._remembered_device("portaudio") == "BlackHole 2ch"
    assert cli.main(["--live", "-D", "ask", "-q"]) == 1
    assert cli._remembered_device("portaudio") is None
    err = capsys.readouterr().err
    assert "audio input devices" in err
    assert "remembered" not in err               # it forgot before listing


def test_device_memory_is_per_backend(tmp_path, monkeypatch):
    """PortAudio and ffmpeg number devices differently, so keep them apart."""
    from cw_decoder import cli

    cli._remember_device("portaudio", "USB Advanced Audio Device")
    cli._remember_device("ffmpeg", "BlackHole 2ch")
    assert cli._remembered_device("portaudio") == "USB Advanced Audio Device"
    assert cli._remembered_device("ffmpeg") == "BlackHole 2ch"
    assert cli._remembered_device("nonexistent") is None


def test_device_memory_survives_a_corrupt_config(tmp_path, monkeypatch):
    """Never fail a run over a convenience feature."""
    from cw_decoder import cli

    path = pathlib.Path(cli._config_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    for junk in ("", "not json", "[]", "null"):
        path.write_text(junk)
        assert cli._load_config() == {}
        assert cli._remembered_device("portaudio") is None
    # And it recovers by rewriting.
    cli._remember_device("portaudio", "Stub Input")
    assert cli._remembered_device("portaudio") == "Stub Input"


def test_live_duration_default_is_two_minutes(tmp_path, monkeypatch):
    """A 30 s cap cut real practice takes short; the default is now 120 s."""
    from cw_decoder import capture, cli

    src = _fixture_wav(tmp_path)
    seen = {}
    monkeypatch.setattr(capture, "list_audio_devices",
                        lambda backend="auto": [capture.Device(0, "Stub Input", "48000 Hz")])
    monkeypatch.setattr(capture, "record", _copy_recorder(src, seen))
    assert cli.main(["--live", "-D", "0", "-w", "20", "-q"]) == 0
    assert seen["max_seconds"] == 120.0
