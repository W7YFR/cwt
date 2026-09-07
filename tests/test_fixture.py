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
def test_fixture_accuracy(fname, expected, char_wpm, overall, exact):
    """With the intended text supplied, a clean recording scores ~100%."""
    path = os.path.join(DATA, fname)
    if not os.path.exists(path):
        pytest.skip(f"fixture not present: {fname}")

    res = core.decode_file(path)
    cmp = core.compare_text(expected, res.text)
    threshold = 0.98 if exact else 0.85
    assert cmp.accuracy >= threshold, cmp.diff
