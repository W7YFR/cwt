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
import tempfile
from pathlib import Path

import pytest

from cw_decoder import core, morse, review, synth, webpage

CORE_JS = Path(core.__file__).parent / "web" / "review-core.js"
node = pytest.mark.skipif(shutil.which("node") is None,
                          reason="node not installed")


def _decode(text="CQ CQ DE W7YFR K", wpm=22, farns=None, rate=8000,
            target_wpm=None, target_farns=None, noise=0.0):
    sig = synth.generate(text, wpm=wpm, farnsworth_wpm=farns, tone=600,
                         rate=rate, noise=noise)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, rate)
        return core.decode_file(tf.name, target_rate=rate,
                                target_wpm=target_wpm,
                                target_farnsworth=target_farns,
                                keep_signal=True)


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
                  target_wpm=tgt_wpm, target_farns=tgt_farns)
    payload = review.build_payload(res, source="test", tolerance=0.30)

    got = _run_js("""
      const t = RC.targetTiming(PAYLOAD.target.char_wpm,
                                PAYLOAD.target.farnsworth_wpm);
      const tl = RC.buildTimeline(PAYLOAD.segments, t);
      const g = RC.grade(tl, PAYLOAD.tolerance);
      console.log(JSON.stringify({
        timing: [t.unitSec, t.ditDahSplit, t.elementCharSplit,
                 t.charWordSplit, t.charGapSec, t.wordGapSec],
        text: tl.text,
        kinds: tl.blocks.map(b => b.kind),
        units: tl.blocks.map(b => b.units),
        targets: tl.blocks.map(b => b.targetUnits),
        chars: tl.chars.map(c => c.char + ':' + c.pattern),
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
    a = core.analyze(tl, ref, res.timing, tolerance=payload["tolerance"])

    assert got["timing"] == pytest.approx(
        [ref.unit_sec, ref.dit_dah_split, ref.element_char_split,
         ref.char_word_split, ref.char_gap_sec, ref.word_gap_sec], abs=1e-12)
    assert got["text"] == tl.text
    assert got["kinds"] == [b.kind for b in tl.blocks]
    assert got["units"] == pytest.approx([b.units for b in tl.blocks], abs=1e-9)
    assert got["targets"] == pytest.approx([b.target_units for b in tl.blocks],
                                           abs=1e-9)
    assert got["chars"] == [f"{c.char}:{c.pattern}" for c in tl.chars]
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
    stretched gap, a missed word space, a clipped dah, and a long pause.
    """
    import numpy as np

    from cw_decoder.morse import CHAR_TO_MORSE

    unit = 1.2 / wpm
    rng = np.random.default_rng(7)
    on = [(False, 0.15)]
    for wi, word in enumerate(text.split(" ")):
        if wi > 0:
            gap = 3.0 if wi == 3 else 7.0      # wi==3 -> the space is missed
            if wi == 2:
                gap = 20.0                     # a long inter-transmission pause
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


@node
def test_page_boots_and_draws(tmp_path):
    """Boot the real page under a stub DOM and drive every control.

    This is the guard against the failure that only shows up as a blank page:
    app.js throwing during boot, layout, or draw. It asserts the page painted,
    annotated spacing, flagged the faults, and wired up audio — not how it
    looks.
    """
    wav = tmp_path / "sloppy.wav"
    _sloppy_wav(wav)
    res = core.decode_file(str(wav), target_rate=8000, target_wpm=20,
                           keep_signal=True)
    page = tmp_path / "review.html"
    webpage.write(str(page), review.build_payload(
        res, source="sloppy.wav", expected="CQ CQ DE W7YFR K",
        expected_source="(inline text)", tolerance=0.30))

    stub = Path(__file__).parent / "dom_stub.js"
    proc = subprocess.run(["node", str(stub), str(page)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, f"page failed to run:\n{proc.stderr}"
    d = json.loads(proc.stdout)

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
    # level it was made, and boosting is an explicit choice.
    assert d["initial"]["gainOut"] == "0 dB", \
        f"listening level defaulted to {d['initial']['gainOut']!r}"

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

    # Three downloads, offered in every view. The recording rides along as the
    # payload's data URI; the target is rendered fresh (so its filename carries
    # the speed it was rendered at) and the chart is a full-width PNG.
    dl = d["downloads"]
    yours = [x for x in dl if x["name"].endswith("-yours.wav")]
    target = [x for x in dl if "-target-" in x["name"]]
    charts = [x for x in dl if x["name"].endswith(".png")]
    assert yours and target and charts
    assert yours[0]["scheme"] == "data" and yours[0]["size"] > 10_000
    assert target[0]["scheme"] == "blob" and target[0]["size"] > 10_000
    assert "wpm" in target[0]["name"]
    # The target render carries padding at both ends rather than stopping dead
    # on its last element; see test_target_audio_gets_the_same_padding for the
    # value itself.
    pad = 0.75
    assert d["audio"]["offlineSeconds"] > 2 * pad
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
    assert d["title"].startswith("CW review")
    # Clearing the intended message drops accuracy but keeps spacing grading,
    # which is the whole point of the no-target fallback.
    assert "accurate" not in d["scoresWithoutTarget"]
    assert "consistent" in d["scoresWithoutTarget"]


def test_write_returns_size(tmp_path):
    res = _decode(target_wpm=22)
    p = review.build_payload(res, source="x.wav")
    out = tmp_path / "review.html"
    size = webpage.write(str(out), p)
    assert size == out.stat().st_size > 10_000


# --------------------------------------------------------------------------- #
# CLI wiring
# --------------------------------------------------------------------------- #
@pytest.fixture
def no_browser(monkeypatch):
    """Capture the URL the CLI would open instead of launching a browser."""
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    return opened


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


def test_cli_without_web_review_writes_nothing(tmp_path, no_browser):
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20"]) == 0
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


def test_report_still_prints_without_web_review(tmp_path, capsys):
    """Regression guard: the suppression must not leak into normal runs."""
    from cw_decoder import cli

    wav = _fixture_wav(tmp_path)
    assert cli.main([str(wav), "-w", "20", "--color", "never"]) == 0
    out = capsys.readouterr().out
    assert "practice report" in out
    assert "consistency" in out
    assert "CQ DE AB1CD" in out


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
    """An explicit --capture-rate is honoured (and does resample)."""
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
    # 0.75 s either side, and well short of the padded original.
    keyed = synth.generate("CQ DE AB1CD", wpm=20, tone=600, rate=8000).size / 8000
    assert secs == pytest.approx(keyed + 2 * 0.75, abs=0.4), \
        f"trimmed to {secs:.2f}s, expected ~{keyed + 1.5:.2f}s"
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
    assert "cancelled" in cap.err
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
    """A cancelled take shouldn't teach it a device preference."""
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
    assert '"pad_sec":0.75' in out.read_text(encoding="utf-8")

    # And it tracks --trim-pad, so the two files stay consistent.
    assert cli.main([str(wav), "-w", "20", "--trim-pad", "1.5",
                     "--web-out", str(out)]) == 0
    assert '"pad_sec":1.5' in out.read_text(encoding="utf-8")


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
