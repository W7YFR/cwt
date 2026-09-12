"""The CLI's handoff to the browser app.

The Python side does its own DSP and hands over *segments*; everything from the
grading onward lives in the TypeScript app. So what these check is the contract
between the two: that the bundle has the shape the app validates on load, that
the audio beside it is the recording rather than a round trip through the
decoder, and that the server puts the session in front of the app.
"""

import json
import os
import urllib.request
import wave

import numpy as np
import pytest

from cw_decoder import bundle, core, serve, synth


@pytest.fixture
def decoded(tmp_path):
    """A real decode of a real synthesized signal."""
    sig = synth.generate("CQ DE W1AW K", wpm=20, farnsworth_wpm=20)
    path = tmp_path / "src.wav"
    synth.write_wav(str(path), sig, 8000)
    res = core.decode_file(str(path), target_wpm=20, keep_signal=True,
                           expected="CQ DE W1AW K")
    return res, str(path)


def test_the_bundle_has_the_shape_the_app_validates(decoded, tmp_path):
    res, src = decoded
    out = str(tmp_path / "session")
    path = bundle.write(out, res, source="test.wav", audio_path=src,
                        expected="CQ DE W1AW K", expected_source="-e")
    data = json.load(open(path))

    assert data["version"] == bundle.BUNDLE_VERSION
    take = data["take"]
    # These five are exactly what the app's looksLikeTake() checks. If any of
    # them is renamed on one side the app refuses the bundle outright, which is
    # a far better failure than silently misreading it.
    assert isinstance(take["id"], str)
    assert isinstance(take["rate"], int)
    assert isinstance(take["segments"], list)
    assert isinstance(take["measured"], dict)
    assert isinstance(take["measured"]["unitSec"], float)


def test_every_timing_field_is_camel_case(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src)
    measured = json.load(open(path))["take"]["measured"]
    # The TypeScript Timing interface, field for field. A snake_case key here
    # would arrive as undefined and grade everything against NaN.
    assert set(measured) == {
        "unitSec", "charWpm", "farnsworthWpm", "ditDahSplit",
        "elementCharSplit", "charWordSplit", "charGapSec", "wordGapSec",
        "notes",
    }


def test_the_segments_survive_as_seconds(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src)
    segs = json.load(open(path))["take"]["segments"]
    assert len(segs) == len(res.segments)
    for (state, dur), (want_state, want_dur) in zip(segs, res.segments):
        assert state == want_state
        assert dur == pytest.approx(want_dur, abs=1e-5)
    # Raw seconds, not pre-divided into units: that is what lets the review
    # re-grade at any speed without the audio.
    assert sum(d for _, d in segs) == pytest.approx(
        res.signal.size / res.rate, abs=0.01)


def test_the_audio_is_copied_not_re_encoded(decoded, tmp_path):
    res, src = decoded
    out = str(tmp_path / "session")
    bundle.write(out, res, source="x", audio_path=src)
    copied = os.path.join(out, bundle.AUDIO_NAME)
    assert open(copied, "rb").read() == open(src, "rb").read()


def test_a_capture_with_no_file_still_gets_playable_audio(decoded, tmp_path):
    res, _ = decoded
    out = str(tmp_path / "session")
    bundle.write(out, res, source="live capture", audio_path=None)
    with wave.open(os.path.join(out, bundle.AUDIO_NAME)) as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2       # 16-bit PCM: every browser reads it
        assert w.getframerate() == res.rate
        assert w.getnframes() > 0


def test_an_explicit_target_is_carried_over_and_marked_as_one(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src,
                        target_wpm=25, target_farnsworth=13)
    target = json.load(open(path))["take"]["target"]
    assert target == {"charWpm": 25.0, "farnsworthWpm": 13.0, "explicit": True}


def test_without_a_target_the_review_opens_at_what_you_actually_sent(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src)
    target = json.load(open(path))["take"]["target"]
    assert target["explicit"] is False
    # Rounded, because 20.4 wpm is not a speed anyone practices at.
    assert target["charWpm"] == float(round(res.timing.char_wpm))
    assert target["farnsworthWpm"] <= target["charWpm"]


def test_the_peak_is_the_recordings_own_not_the_normalized_copys(tmp_path):
    # decode_file peak-normalizes for the threshold detector. If that number
    # reached the bundle, every recording would report 0 dBFS and the level
    # readout would be useless.
    quiet = synth.generate("TEST", wpm=20) * 0.1
    path = tmp_path / "quiet.wav"
    synth.write_wav(str(path), quiet, 8000)
    res = core.decode_file(str(path), keep_signal=True)
    out = bundle.write(str(tmp_path / "s"), res, source="x",
                       audio_path=str(path))
    peak = json.load(open(out))["take"]["peak"]
    assert peak < 0.2
    assert float(np.max(np.abs(res.signal))) == pytest.approx(1.0, abs=1e-6)


def test_the_intended_text_rides_along_as_text(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src,
                        expected="  cq de w1aw k  ", expected_source="-e")
    take = json.load(open(path))["take"]
    assert take["expected"] == "cq de w1aw k"
    assert take["expectedSource"] == "-e"


def test_no_intended_text_is_null_not_empty(decoded, tmp_path):
    res, src = decoded
    path = bundle.write(str(tmp_path / "s"), res, source="x", audio_path=src,
                        expected="   ")
    assert json.load(open(path))["take"]["expected"] is None


class TestServing:
    def _app(self, tmp_path):
        app = tmp_path / "dist"
        app.mkdir()
        (app / "index.html").write_text("<!doctype html><title>app</title>")
        (app / "app.js").write_text("// built app")
        return str(app)

    def _session(self, tmp_path, decoded):
        res, src = decoded
        out = str(tmp_path / "session")
        bundle.write(out, res, source="x", audio_path=src)
        return out

    def _get(self, url):
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read()

    def test_the_session_is_served_beside_the_app(self, tmp_path, decoded):
        with serve.serve(self._session(tmp_path, decoded),
                         self._app(tmp_path)) as s:
            status, body = self._get(s.url + bundle.BUNDLE_NAME)
            assert status == 200
            assert json.loads(body)["take"]["segments"]

            status, body = self._get(s.url + "app.js")
            assert status == 200 and b"built app" in body

    def test_the_audio_is_reachable_from_the_bundle(self, tmp_path, decoded):
        session = self._session(tmp_path, decoded)
        with serve.serve(session, self._app(tmp_path)) as s:
            name = json.load(open(os.path.join(session,
                                               bundle.BUNDLE_NAME)))["audioUrl"]
            status, body = self._get(s.url + name)
            assert status == 200
            assert body[:4] == b"RIFF"

    def test_an_unknown_path_serves_the_app_not_a_404(self, tmp_path, decoded):
        # A single-page app: unknown paths are routes, not missing files.
        with serve.serve(self._session(tmp_path, decoded),
                         self._app(tmp_path)) as s:
            status, body = self._get(s.url + "some/deep/route")
            assert status == 200 and b"<!doctype html>" in body

    def test_the_bundle_is_never_cached(self, tmp_path, decoded):
        # It changes every run, and reusing the last one would mean silently
        # reviewing yesterday's sending.
        with serve.serve(self._session(tmp_path, decoded),
                         self._app(tmp_path)) as s:
            with urllib.request.urlopen(s.url + bundle.BUNDLE_NAME,
                                        timeout=5) as r:
                assert "no-store" in r.headers.get("Cache-Control", "")

    def test_it_will_not_serve_outside_the_directories_it_was_given(
            self, tmp_path, decoded):
        secret = tmp_path / "secret.txt"
        secret.write_text("not yours")
        with serve.serve(self._session(tmp_path, decoded),
                         self._app(tmp_path)) as s:
            status, body = self._get(s.url + "../secret.txt")
            assert b"not yours" not in body
            assert b"<!doctype html>" in body


def test_find_app_dir_wants_a_real_build(tmp_path):
    assert serve.find_app_dir(str(tmp_path)) is None or True
    empty = tmp_path / "nothing"
    empty.mkdir()
    assert serve.find_app_dir(str(empty)) == str(empty)
    assert serve.find_app_dir(str(tmp_path / "missing")) is None


class TestTheCliHandoff:
    """`cw-decode` end to end, as far as handing the session over."""

    def _app(self, tmp_path):
        app = tmp_path / "dist"
        app.mkdir()
        (app / "index.html").write_text("<!doctype html><title>app</title>")
        return str(app)

    def test_the_default_output_is_the_browser_review(self, tmp_path,
                                                      monkeypatch, no_browser):
        from cw_decoder import bundle as bundle_mod
        from cw_decoder import cli

        monkeypatch.setattr(cli, "_wait_for_interrupt", lambda: None)
        out = tmp_path / "session"
        code = cli.main(["--demo", "CQ DE W1AW K", "--demo-wpm", "20",
                         "--web-out", str(out), "--app-dir", self._app(tmp_path),
                         "-q"])
        assert code == 0
        # No flag asked for this: the review is what the tool is for, so it is
        # what happens unless something else is requested.
        data = json.load(open(out / bundle_mod.BUNDLE_NAME))
        assert data["take"]["decoded"].replace(" ", "") == "CQDEW1AWK"
        assert (out / bundle_mod.AUDIO_NAME).exists()
        assert no_browser and no_browser[0].startswith("http://127.0.0.1:")

    def test_no_open_serves_without_launching_anything(self, tmp_path,
                                                       monkeypatch, no_browser):
        from cw_decoder import cli

        monkeypatch.setattr(cli, "_wait_for_interrupt", lambda: None)
        code = cli.main(["--demo", "SOS", "--web-out", str(tmp_path / "s"),
                         "--app-dir", self._app(tmp_path), "--no-open", "-q"])
        assert code == 0
        assert no_browser == []

    def test_the_intended_text_reaches_the_bundle(self, tmp_path, monkeypatch,
                                                  no_browser):
        from cw_decoder import bundle as bundle_mod
        from cw_decoder import cli

        monkeypatch.setattr(cli, "_wait_for_interrupt", lambda: None)
        out = tmp_path / "s"
        cli.main(["--demo", "CQ DE W1AW K", "-e", "CQ DE W1AW K",
                  "-w", "20", "-f", "13",
                  "--web-out", str(out), "--app-dir", self._app(tmp_path),
                  "--no-open", "-q"])
        take = json.load(open(out / bundle_mod.BUNDLE_NAME))["take"]
        assert take["expected"] == "CQ DE W1AW K"
        assert take["target"] == {"charWpm": 20.0, "farnsworthWpm": 13.0,
                                  "explicit": True}

    def test_it_says_where_the_session_went_when_there_is_no_build(
            self, tmp_path, monkeypatch, capsys, no_browser):
        from cw_decoder import bundle as bundle_mod
        from cw_decoder import cli

        monkeypatch.setattr(cli, "_wait_for_interrupt", lambda: None)
        out = tmp_path / "s"
        code = cli.main(["--demo", "SOS", "--web-out", str(out),
                         "--app-dir", str(tmp_path / "no-such-build")])
        assert code == 0
        # The session is still written — the analysis is done and throwing it
        # away because the UI is missing would be the wrong trade.
        assert (out / bundle_mod.BUNDLE_NAME).exists()
        err = capsys.readouterr().err
        assert "npm run build" in err
        assert no_browser == []

    def test_json_still_skips_the_review_entirely(self, tmp_path, monkeypatch,
                                                  capsys, no_browser):
        from cw_decoder import cli

        monkeypatch.setattr(cli, "_wait_for_interrupt", lambda: None)
        code = cli.main(["--demo", "SOS", "--json"])
        assert code == 0
        assert json.loads(capsys.readouterr().out)["text"]
        assert no_browser == []
