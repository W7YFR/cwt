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
| `cq-de-w7yfr.wav` | `CQ DE W7YFR` | 25 wpm; keyer captured via Audacity, words run together (no word gaps) |

## Calibration corpora

Multi-file sets used by the TypeScript calibration tests. These **are**
committed, despite the blanket `*.wav` rule in `.gitignore` — there is a
matching exception for this directory, because without them the calibration
tests do not run at all and they cannot be regenerated: each is a particular
room on a particular afternoon.

They are stored at **8 kHz mono**, downsampled from the 44.1 kHz originals. That
costs nothing measurable — the whole corpus moves a room offset by about 0.3 ms
against effects of 13 to 34 ms, and the section split comes out identical — and
takes the set from 47 MB to under 10 MB. The tests still skip cleanly if a
corpus is missing, so a partial checkout is green rather than broken.

| Directory | What it is |
|---|---|
| `k3ng/` | The full sequence — silence, held dits, held dahs, iambic, isolated dits, a message — at 15 wpm, captured **simultaneously** through a loopback from the keyer and a webcam microphone four feet from the speaker. The loopback file is not a reference decode, it is the answer. Measured room offset: 13 ms. |
| `ft710/` | The same sequence with the keyer driving an FT-710, its sidetone reaching the microphone from 56 inches and off-axis. Roughly twice as reverberant; the message shatters and calibration correctly **refuses**. Kept as the negative case. |
| `ft710-close/` | The same again in one continuous take with the microphone a few inches from the radio's speaker. Room offset 2.5 ms, and the message reads correctly with no calibration at all. Also the recording whose section separators overlap with its own isolated-dit spacing, which is why sections cannot be split on a fixed amount of silence. |

Each set was keyed by a machine, so element lengths are known rather than
estimated — and each was captured through the loopback and the microphone
**simultaneously**, so the loopback file is not a second opinion, it is the
answer. That is what makes them usable for measuring what a room does.
`cq-de-w7yfr-mic-1.wav` and `-mic-2.wav` beside this file are the same idea in
miniature and *are* committed, being small.

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

**Fixtures must be intact recordings.** `test_fixture_has_no_dropouts` rejects
any file with dropped audio buffers — they click, shorten dits and dahs, and
read back faster than they were keyed, which would silently poison the speed
assertions. If a capture fails that check, the recording is the problem, not
the decoder: capture it again with a different input path.
