"""Full-pipeline test against committed real-audio fixtures.

Unlike the synthetic round-trip tests, these run against *real* CW recordings
committed to `tests/data/`, so the decoder is exercised on genuine keying
envelopes and edge shapes that a synthesized signal can't reproduce. Each
fixture is skipped automatically until its WAV is present.

To add a fixture, produce a short mono WAV of the stated message at the stated
speed with any keyer or CW-audio tool (see tests/data/README.md), drop it in
`tests/data/`, and add a row to FIXTURES. Content is deliberately generic
(example callsign AB1CD, standard practice phrases).
"""

import os

import pytest

from cw_decoder import core

DATA = os.path.join(os.path.dirname(__file__), "data")

# (filename, expected message, char wpm, overall wpm or None, exact_spacing)
# exact_spacing=True asserts the decode word-for-word (only clean, machine-timed
# recordings should use it); False compares ignoring spaces, for recordings whose
# word spacing is ambiguous.
FIXTURES = [
    ("cq-ab1cd-20wpm-k3ng.wav", "CQ CQ DE AB1CD K", 20, 20, True),
    # A 25 wpm keyer captured through Audacity. Run together without word
    # gaps, hence exact_spacing=False and no overall-speed assertion.
    ("cq-de-w7yfr.wav", "CQ DE W7YFR", 25, None, False),
]


def _letters(s: str) -> str:
    return "".join(s.split())


@pytest.mark.parametrize("fname,expected,char_wpm,overall,exact", FIXTURES)
def test_fixture(fname, expected, char_wpm, overall, exact):
    path = os.path.join(DATA, fname)
    if not os.path.exists(path):
        pytest.skip(f"fixture not present: {fname}")

    res = core.decode_file(path)
    if exact:
        assert expected in res.text, f"decoded {res.text!r}"
    else:
        assert _letters(expected) in _letters(res.text), f"decoded {res.text!r}"
    assert abs(res.timing.char_wpm - char_wpm) < 4
    if overall is not None:
        assert abs(res.timing.farnsworth_wpm - overall) < 4


@pytest.mark.parametrize("fname,expected,char_wpm,overall,exact", FIXTURES)
def test_fixture_has_no_dropouts(fname, expected, char_wpm, overall, exact):
    """Committed fixtures must be intact recordings.

    A capture with dropped buffers clicks, shortens elements, and reads back
    faster than it was keyed — so it would silently poison the speed
    assertions above. Checking it here documents the standard for adding a
    fixture, and catches a re-recorded one made with a broken capture path.
    """
    path = os.path.join(DATA, fname)
    if not os.path.exists(path):
        pytest.skip(f"fixture not present: {fname}")

    from cw_decoder import capture

    rate = capture.wav_rate(path)
    assert rate, f"could not read the sample rate of {fname}"
    # At the file's own rate: resampling smooths the splice and hides it.
    sig = core.load_audio(path, rate, normalize=False)
    hits = core.find_dropouts(sig, rate)
    assert hits == [], f"{fname} has {len(hits)} dropped buffer(s) at {hits[:5]}"


@pytest.mark.parametrize("fname,expected,char_wpm,overall,exact", FIXTURES)
def test_fixture_accuracy(fname, expected, char_wpm, overall, exact):
    """With the intended text supplied, a clean recording scores ~100%."""
    path = os.path.join(DATA, fname)
    if not os.path.exists(path):
        pytest.skip(f"fixture not present: {fname}")

    res = core.decode_file(path)
    if exact:
        cmp = core.compare_text(expected, res.text)
        threshold = 0.98
    else:
        # Same basis as test_fixture: this fixture's word spacing is ambiguous
        # (the keyer ran the words together), so scoring spaces would measure
        # the recording's spacing rather than the decoder's character accuracy.
        cmp = core.compare_text(_letters(expected), _letters(res.text))
        threshold = 0.85
    assert cmp.accuracy >= threshold, cmp.diff
