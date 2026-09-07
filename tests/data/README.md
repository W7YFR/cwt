# Test fixtures

Short **real** CW recordings used by `tests/test_fixture.py`. They exercise the
decoder against genuine keying (envelope shape, timing jitter, background noise)
that the synthetic tests can't reproduce.

Keep them small and generic — a few seconds, mono, ideally 8 kHz so the file is
well under ~200 KB. Content uses the example callsign `AB1CD` (no real stations).

## Fixtures

| File | Message | Speed |
|------|---------|-------|
| `cq-ab1cd-20wpm-k3ng.wav` | `CQ CQ DE AB1CD K` | 20 wpm, standard spacing; k3ng keyer, programmatically sent (clean, machine-timed) |

## How to (re)generate

Produce a mono WAV of the message at the stated speed with any CW-audio tool
(keyer sidetone recording, `ebook2cw`, fldigi, an online generator, etc.):

```sh
# example with ebook2cw (github.com/fkurz/ebook2cw):
printf 'CQ CQ DE AB1CD K\n' > msg.txt
ebook2cw -w 20 -f 600 -o cq-ab1cd msg.txt      # -> cq-ab1cd0000.mp3

# then convert to a small mono 8 kHz WAV:
ffmpeg -i cq-ab1cd0000.mp3 -ac 1 -ar 8000 cq-ab1cd-20wpm.wav
```

Any WAV the decoder can read is fine (it resamples internally); 8 kHz mono just
keeps the committed file tiny. A couple of seconds of message plus a little
leading/trailing silence is plenty. Real hand-sent or off-air audio is even more
valuable than tool-generated — the point is to test on non-ideal keying.

To add a fixture: drop the WAV here and add a row to `FIXTURES` in
`tests/test_fixture.py` with its expected message and speed.
