"""Round-trip tests: synthesize known CW, decode it, compare."""

import tempfile

import numpy
import pytest

from cw_decoder import core, synth


def _roundtrip(text, wpm=20, farnsworth=None, tone=600, noise=0.0, rate=8000):
    sig = synth.generate(text, wpm=wpm, farnsworth_wpm=farnsworth,
                         tone=tone, rate=rate, noise=noise)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, rate)
        return core.decode_file(tf.name, target_rate=rate)


@pytest.mark.parametrize("text", [
    "CQ CQ DE W1AW K",
    "THE QUICK BROWN FOX",
    "PARIS PARIS PARIS",
    "599 5NN TU",
])
def test_clean(text):
    res = _roundtrip(text, wpm=20)
    assert res.text.strip() == text


def test_speed_estimate():
    res = _roundtrip("PARIS PARIS PARIS PARIS", wpm=25)
    assert abs(res.timing.char_wpm - 25) < 2.5


def test_farnsworth():
    res = _roundtrip("CQ TEST DE K1ABC", wpm=25, farnsworth=13)
    assert res.text.strip() == "CQ TEST DE K1ABC"
    assert abs(res.timing.char_wpm - 25) < 3
    assert res.timing.farnsworth_wpm < res.timing.char_wpm


def test_noisy():
    res = _roundtrip("CQ DE W1AW", wpm=18, noise=0.15)
    assert res.text.strip() == "CQ DE W1AW"


def test_tone_detection():
    res = _roundtrip("TEST", wpm=20, tone=750)
    assert abs(res.tone_hz - 750) < 15


@pytest.mark.parametrize("text", [
    "CQ CQ DE W7YFR <AR> K",
    "R FB TU 73 <SK> <BK>",
    "SOMEONE IS CALLING <BK> GO AHEAD",
])
def test_prosigns(text):
    res = _roundtrip(text, wpm=22)
    assert res.text.strip() == text


def _roundtrip_target(text, wpm, farns, tgt_wpm, tgt_farns, rate=8000):
    sig = synth.generate(text, wpm=wpm, farnsworth_wpm=farns, tone=600, rate=rate)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, rate)
        return core.decode_file(tf.name, target_rate=rate,
                                target_wpm=tgt_wpm, target_farnsworth=tgt_farns)


def test_target_matching_is_clean():
    # Sending exactly at the target -> tight stats, no deviations.
    res = _roundtrip_target("CQ CQ DE W7YFR K", 25, 12, 25, 12)
    a = res.analysis
    assert a is not None
    assert a.within_tol_frac > 0.95
    assert a.deviations == []
    by = {s.name: s for s in a.stats}
    assert abs(by["dit"].mean_units - 1.0) < 0.2
    assert abs(by["dah"].mean_units - 3.0) < 0.2
    assert abs(by["char-gap"].mean_units - by["char-gap"].target_units) < 0.6


def test_target_mismatch_flags_speed():
    # Sending slower than the target should show up as a low overall speed.
    res = _roundtrip_target("CQ DE W7YFR K", 18, 18, 25, 25)
    a = res.analysis
    assert a.measured.char_wpm < a.ref.char_wpm - 4  # ~18 vs 25


def test_target_ignores_long_pauses():
    # A big pause between two words shouldn't count as a spacing error.
    res = _roundtrip_target("TEST", 20, 20, 20, 20)
    assert res.analysis is not None  # smoke: analysis produced


def test_json_output(capsys, tmp_path):
    import json as _json

    from cw_decoder import cli
    wav = tmp_path / "t.wav"
    synth.write_wav(str(wav), synth.generate("CQ DE W7YFR", wpm=20, tone=600,
                                             rate=8000), 8000)
    exp = tmp_path / "e.txt"
    exp.write_text("CQ DE W7YFR")
    rc = cli.main([str(wav), "-w", "20", "-e", str(exp), "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    d = _json.loads(out)                       # entire stdout must be valid JSON
    assert d["text"].strip() == "CQ DE W7YFR"
    assert d["target"]["char_wpm"] == 20
    assert d["comparison"]["accuracy"] == 1.0
    assert d["analysis"]["elements"]


def test_quick_decode_fixed_timing():
    """The live/streaming decode path decodes correctly against fixed timing."""
    timing = core.target_timing(20)
    sig = synth.generate("CQ DE AB1CD K", wpm=20, tone=600, rate=8000)
    assert "CQ DE AB1CD K" in core.quick_decode(sig, 8000, 600.0, timing)
    # Too-short / silent input yields no text (no crash).
    assert core.quick_decode(sig[:50], 8000, 600.0, timing) == ""
    assert core.quick_decode(sig * 0, 8000, 600.0, timing) == ""


def test_quick_decode_partial_prefix():
    """A prefix of the audio decodes to a prefix of the message (streaming)."""
    timing = core.target_timing(20)
    sig = synth.generate("PARIS PARIS", wpm=20, tone=600, rate=8000)
    full = core.quick_decode(sig, 8000, 600.0, timing).strip()
    part = core.quick_decode(sig[: int(sig.size * 0.4)], 8000, 600.0, timing).strip()
    assert full == "PARIS PARIS"
    assert part and full.startswith(part[:3])


def test_live_preview_decimates_for_dsp():
    """Capture runs at 44.1 kHz; the live preview decodes a decimated copy.

    Decoding at the capture rate directly costs ~5x more, and the preview
    re-decodes the whole buffer several times a second — so the decimation has
    to be both cheap and lossless enough to decode correctly.
    """
    from cw_decoder import stream

    text = "CQ DE AB1CD K"
    sig = synth.generate(text, wpm=20, tone=600, rate=44100)
    dsp = stream._for_dsp(sig, 44100, 8000)
    assert abs(dsp.size - sig.size * 8000 / 44100) < 100      # right length
    assert dsp.dtype == numpy.float32

    timing = core.target_timing(20)
    assert text in core.quick_decode(dsp, 8000, 600.0, timing)

    # A no-op when the rates already match, and safe on an empty buffer.
    assert stream._for_dsp(sig, 8000, 8000) is sig
    empty = numpy.zeros(0, dtype=numpy.float32)
    assert stream._for_dsp(empty, 44100, 8000).size == 0


def _drop_buffers(sig, rate, at_seconds, frames=512):
    """Excise `frames` samples at each time — what a dropped capture buffer does.

    The waveform then resumes at an arbitrary phase, which is the audible click
    and the reason the element it landed in comes out short.
    """
    keep = numpy.ones(sig.size, dtype=bool)
    for t in at_seconds:
        i = int(t * rate)
        keep[i:i + frames] = False
    return sig[keep]


def test_trim_silence_keeps_only_the_padding():
    """Dead air at each end is cut back to the requested padding."""
    rate, pad = 8000, 0.75
    keyed = synth.generate("CQ DE W7YFR", wpm=25, tone=600, rate=rate)
    lead, tail = 4.0, 3.0
    padded = numpy.concatenate([
        numpy.zeros(int(lead * rate), numpy.float32), keyed,
        numpy.zeros(int(tail * rate), numpy.float32)])

    out, cut_lead = core.trim_silence(padded, rate, pad=pad)
    # synth.generate already wraps the keying in 0.1 s of its own silence.
    assert cut_lead == pytest.approx(lead - pad, abs=0.15)
    assert out.size / rate == pytest.approx(
        keyed.size / rate + 2 * pad - 0.2, abs=0.3)
    # The keying itself survives intact: it still decodes.
    assert "CQ DE W7YFR" in core.quick_decode(out, rate, 600.0,
                                              core.target_timing(25))


def test_trim_silence_leaves_audio_it_cannot_account_for():
    """Refuse to trim rather than risk eating audio."""
    rate = 8000
    keyed = synth.generate("TEST", wpm=25, tone=600, rate=rate)

    # Nothing keyed at all: hand it back untouched.
    silence = numpy.zeros(5 * rate, dtype=numpy.float32)
    out, lead = core.trim_silence(silence, rate)
    assert out is silence and lead == 0.0

    # Already tight: nothing to gain, so don't rewrite it.
    out, lead = core.trim_silence(keyed, rate, pad=2.0)
    assert out is keyed and lead == 0.0

    # Degenerate inputs.
    empty = numpy.zeros(0, dtype=numpy.float32)
    assert core.trim_silence(empty, rate) == (empty, 0.0)
    tiny = numpy.zeros(100, dtype=numpy.float32)
    assert core.trim_silence(tiny, rate)[0] is tiny

    # A negative pad is a caller error, not license to trim everything.
    out, lead = core.trim_silence(keyed, rate, pad=-1)
    assert out is keyed and lead == 0.0


def test_trim_silence_keys_off_the_tone_not_the_level():
    """Broadband noise in the 'silence' must not defeat the trim.

    Level-based detection would find no silence at all here; the bandpass and
    threshold the decoder already uses look for the tone instead.
    """
    rate = 8000
    rng = numpy.random.default_rng(3)
    keyed = synth.generate("CQ DE W7YFR", wpm=25, tone=600, rate=rate)
    noise = lambda n: rng.normal(0, 0.05, n).astype(numpy.float32)  # noqa: E731
    padded = numpy.concatenate([noise(4 * rate), keyed + noise(keyed.size),
                                noise(3 * rate)])
    out, lead = core.trim_silence(padded, rate, pad=0.75)
    assert lead == pytest.approx(4.0 - 0.75, abs=0.3)
    assert out.size < padded.size - 5 * rate


def test_find_dropouts_flags_spliced_audio():
    """Detect dropped capture buffers, which are otherwise silent failures.

    Measured on real captures: clean recordings sit at ~1.04x their own
    99.9th-percentile slew, captures with dropped buffers at 4.1-5.2x.
    """
    rate = 48000
    clean = synth.generate("CQ CQ DE W7YFR K", wpm=25, tone=600, rate=rate)
    assert core.find_dropouts(clean, rate) == []

    # Drops land mid-mark, where a phase splice is detectable.
    holed = _drop_buffers(clean, rate, [1.0, 2.0, 3.0])
    found = core.find_dropouts(holed, rate)
    assert len(found) >= 2, f"missed the splices: {found}"

    # Noise must not trip it — a false alarm on good audio is worse than
    # missing a marginal glitch.
    for noise in (0.15, 0.3, 0.5):
        noisy = synth.generate("CQ DE W7YFR", wpm=25, tone=600, rate=rate,
                               noise=noise)
        assert core.find_dropouts(noisy, rate) == [], f"false alarm at {noise}"

    # Silence and tiny buffers are handled without blowing up.
    assert core.find_dropouts(numpy.zeros(4000, dtype=numpy.float32), rate) == []
    assert core.find_dropouts(numpy.zeros(8, dtype=numpy.float32), rate) == []


def test_dropped_buffers_inflate_the_measured_speed():
    """Why dropouts matter: they make the decoder read the sending as faster.

    The unit estimate averages the dit with a third of the dah, so shortening
    dahs — which happens three times as often, being three times as long —
    biases the speed upward. This is the mechanism behind a 25 wpm keyer
    reading back as ~28.
    """
    rate = 48000
    text = "PARIS PARIS PARIS PARIS"
    clean = synth.generate(text, wpm=25, tone=600, rate=rate)
    holed = _drop_buffers(clean, rate, numpy.arange(0.4, 4.0, 0.25))

    with tempfile.NamedTemporaryFile(suffix=".wav") as a, \
            tempfile.NamedTemporaryFile(suffix=".wav") as b:
        synth.write_wav(a.name, clean, rate)
        synth.write_wav(b.name, holed, rate)
        good = core.decode_file(a.name, target_rate=8000)
        bad = core.decode_file(b.name, target_rate=8000)

    # Relative, not absolute: synth.generate puts its raised-cosine ramp
    # *inside* the mark, so a 50%-threshold measurement of synthetic audio
    # reads (length - ramp) and lands ~2 wpm fast regardless of dropouts. On
    # real keyer audio the decoder is accurate to within 1 wpm; what matters
    # here is that excising buffers makes the reading worse.
    assert bad.timing.char_wpm > good.timing.char_wpm + 1.0


def test_capture_device_parser():
    from cw_decoder import capture
    # Sample of ffmpeg's avfoundation device listing (goes to stderr).
    sample = (
        "[AVFoundation indev @ 0x7f] AVFoundation video devices:\n"
        "[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera\n"
        "[AVFoundation indev @ 0x7f] AVFoundation audio devices:\n"
        "[AVFoundation indev @ 0x7f] [0] MacBook Pro Microphone\n"
        "[AVFoundation indev @ 0x7f] [1] USB Audio CODEC\n"
    )
    devices = capture._parse_devices(sample)
    assert devices == [(0, "MacBook Pro Microphone"), (1, "USB Audio CODEC")]


def _write_wav(path, text="CQ DE AB1CD", wpm=20):
    synth.write_wav(str(path), synth.generate(text, wpm=wpm, tone=600, rate=8000),
                    8000)


def test_sibling_text_autodiscovered(capsys, tmp_path):
    import json as _json

    from cw_decoder import cli
    wav = tmp_path / "msg.wav"
    _write_wav(wav)
    (tmp_path / "msg.txt").write_text("CQ DE AB1CD")
    assert cli.main([str(wav), "--json"]) == 0
    d = _json.loads(capsys.readouterr().out)
    assert d["comparison"] is not None
    assert d["comparison"]["expected_source"].endswith("msg.txt")
    assert d["comparison"]["accuracy"] == 1.0


def test_color_modes(capsys, tmp_path):
    from cw_decoder import cli
    wav = tmp_path / "m.wav"
    _write_wav(wav, text="CQ DE AB1CD")
    ESC = "\033["
    # 'never' -> no ANSI
    cli.main([str(wav), "-w", "20", "--color", "never"])
    assert ESC not in capsys.readouterr().out
    # 'always' -> ANSI present
    cli.main([str(wav), "-w", "20", "--color", "always"])
    assert ESC in capsys.readouterr().out
    # JSON never carries color, even with --color always
    cli.main([str(wav), "-w", "20", "--color", "always", "--json"])
    out = capsys.readouterr().out
    assert ESC not in out
    import json as _json
    _json.loads(out)  # and it's still valid JSON


def test_expected_accepts_literal_text(capsys, tmp_path):
    import json as _json

    from cw_decoder import cli
    wav = tmp_path / "msg.wav"
    _write_wav(wav, text="CQ DE AB1CD")
    # -e value is not a file -> treated as the literal intended message.
    assert cli.main([str(wav), "-e", "CQ DE AB1CD", "--json"]) == 0
    d = _json.loads(capsys.readouterr().out)
    assert d["comparison"]["expected_source"] == "(inline text)"
    assert d["comparison"]["accuracy"] == 1.0


def test_expected_missing_txt_file_errors(capsys, tmp_path):
    from cw_decoder import cli
    wav = tmp_path / "msg.wav"
    _write_wav(wav)
    # A .txt value that doesn't exist is a typo, not literal text -> error.
    rc = cli.main([str(wav), "-e", str(tmp_path / "typo.txt")])
    assert rc == 1
    assert "not found" in capsys.readouterr().err


def test_explicit_expected_overrides_sibling(capsys, tmp_path):
    import json as _json

    from cw_decoder import cli
    wav = tmp_path / "msg.wav"
    _write_wav(wav)
    (tmp_path / "msg.txt").write_text("TOTALLY WRONG")       # sibling
    other = tmp_path / "right.txt"
    other.write_text("CQ DE AB1CD")
    assert cli.main([str(wav), "-e", str(other), "--json"]) == 0
    d = _json.loads(capsys.readouterr().out)
    assert d["comparison"]["expected_source"].endswith("right.txt")
    assert d["comparison"]["accuracy"] == 1.0


def test_no_sibling_no_comparison(capsys, tmp_path):
    import json as _json

    from cw_decoder import cli
    wav = tmp_path / "msg.wav"
    _write_wav(wav)                                          # no .txt beside it
    assert cli.main([str(wav), "--json"]) == 0
    d = _json.loads(capsys.readouterr().out)
    assert d["comparison"] is None


def test_compare_exact():
    c = core.compare_text("ROB DE W7YFR", "ROB DE W7YFR")
    assert c.accuracy == 1.0
    assert (c.substitutions, c.insertions, c.deletions) == (0, 0, 0)


def test_compare_substitution():
    c = core.compare_text("CQ TEST", "CQ TES")   # missing final char
    assert c.deletions == 1
    c2 = core.compare_text("CQ TEST", "CQ TEXT")  # S->X
    assert c2.substitutions == 1
    assert "[S→X]" in c2.diff


def test_compare_extra_and_missed():
    c = core.compare_text("ROB DE W7YFR", "ROB DE XX W7YFR")
    assert c.insertions >= 2          # extra "XX"
    assert "[+" in c.diff


def test_compare_is_case_insensitive_and_handles_prosigns():
    c = core.compare_text("tu 73 <sk>", "TU 73 <SK>")
    assert c.accuracy == 1.0


def test_compare_repetitive_localizes_errors():
    exp = "PARIS " * 5
    got = "PARIS PARIS PARXS PARIS PARIS"  # one bad char in the middle
    c = core.compare_text(exp, got)
    assert c.accuracy > 0.9
    assert c.substitutions == 1


def test_timeline_groups_blocks_into_characters():
    """build_timeline preserves which marks/gaps produced which character."""
    res = _roundtrip("CQ DE", wpm=20)
    tl = res.timeline
    assert tl is not None
    assert tl.text == res.text
    assert "".join(c.char for c in tl.chars) == "CQDE"

    # Every character's blocks reconstruct its dit/dah pattern.
    from cw_decoder.morse import CHAR_TO_MORSE
    for c in tl.chars:
        marks = [b for b in c.blocks if b.kind in ("dit", "dah")]
        pattern = "".join("." if b.kind == "dit" else "-" for b in marks)
        assert pattern == c.pattern == CHAR_TO_MORSE[c.char]
        # A character spans exactly its own marks — no silence bleeding in.
        assert c.t0 == marks[0].t0
        assert c.t1 == marks[-1].t1

    # Characters are in time order and don't overlap.
    for a, b in zip(tl.chars, tl.chars[1:]):
        assert a.t1 <= b.t0

    # The gap between two characters is attributed to the later one.
    assert tl.chars[0].lead_gap is None                  # first char has none
    assert tl.chars[1].lead_gap.kind == "char-gap"       # C -> Q
    assert tl.chars[2].lead_gap.kind == "word-gap"       # Q -> D (word boundary)


def test_timeline_excludes_trailing_silence_from_the_last_character():
    """The final character must not absorb the recording's trailing silence.

    `t` advances past every segment including the edge silences, so closing the
    last character at the cursor would stretch it to the end of the file —
    which showed up as a phantom jump at the end of the drift plot, and made
    click-to-play run on through the silence.
    """
    timing = core.target_timing(20)
    u = timing.unit_sec
    # K = -.-  wrapped in a long trailing silence.
    segs = [(0, 0.1), (1, 3 * u), (0, u), (1, u), (0, u), (1, 3 * u),
            (0, 25 * u)]
    tl = core.build_timeline(segs, timing)
    assert tl.text == "K"
    last = tl.chars[-1]
    assert last.t1 == tl.blocks[-1].t1                 # ends at its last mark
    assert (last.t1 - last.t0) == pytest.approx(9 * u)  # -.- spans 9 units
    # The trailing silence produced no block at all.
    assert all(b.kind != "pause" for b in tl.blocks)


def test_timeline_measures_against_reference_timing():
    """Blocks are measured in the reference timing's units."""
    sig = synth.generate("PARIS", wpm=20, tone=600, rate=8000)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tf:
        synth.write_wav(tf.name, sig, 8000)
        res = core.decode_file(tf.name, target_rate=8000, target_wpm=20)
    tl = res.timeline
    for b in tl.blocks:
        if b.kind == "dit":
            assert b.target_units == 1.0 and abs(b.units - 1.0) < 0.3
        elif b.kind == "dah":
            assert b.target_units == 3.0 and abs(b.units - 3.0) < 0.3
        elif b.kind == "element-gap":
            assert b.target_units == 1.0 and abs(b.units - 1.0) < 0.3


def test_timeline_flags_long_silence_as_pause():
    """An inter-transmission silence becomes a `pause`, excluded from grading."""
    timing = core.target_timing(20)
    u = timing.unit_sec
    # dit, word gap, dit, a 30-unit silence, dit -- wrapped in edge silence.
    segs = [(0, 0.1), (1, u), (0, 7 * u), (1, u), (0, 30 * u), (1, u), (0, 0.1)]
    tl = core.build_timeline(segs, timing)
    kinds = [b.kind for b in tl.blocks]
    assert kinds == ["dit", "word-gap", "dit", "pause", "dit"]
    pause = tl.blocks[3]
    assert pause.target_units == 0.0            # carries no target
    a = core.analyze(tl, timing, timing)
    assert a.n_pauses == 1
    assert not any(d.kind == "pause" for d in a.deviations)
    assert all(s.name != "pause" for s in a.stats)


def test_prosign_collision_policy():
    # Pattern map: <AR> wins over "+", but "=" wins over <BT>.
    from cw_decoder.morse import decode_pattern
    assert decode_pattern(".-.-.") == "<AR>"
    assert decode_pattern("-...-") == "="
    # And it round-trips through real audio in a realistic message.
    assert _roundtrip("TU DE W7YFR <AR>", wpm=20).text.strip() == "TU DE W7YFR <AR>"
    assert _roundtrip("RST 599 = QTH SEATTLE", wpm=20).text.strip() == "RST 599 = QTH SEATTLE"
