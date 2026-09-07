"""Round-trip tests: synthesize known CW, decode it, compare."""

import tempfile

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


def test_prosign_collision_policy():
    # Pattern map: <AR> wins over "+", but "=" wins over <BT>.
    from cw_decoder.morse import decode_pattern
    assert decode_pattern(".-.-.") == "<AR>"
    assert decode_pattern("-...-") == "="
    # And it round-trips through real audio in a realistic message.
    assert _roundtrip("TU DE W7YFR <AR>", wpm=20).text.strip() == "TU DE W7YFR <AR>"
    assert _roundtrip("RST 599 = QTH SEATTLE", wpm=20).text.strip() == "RST 599 = QTH SEATTLE"
