# CWT — CW Trainer

**See what your keying is doing, and get better at it.**

Key into your microphone — or into an app through a loopback device — and every
dit, dah and gap is measured against a perfect sender at the same speed. Your
sending and the ideal version are drawn on one chart, and you can play either of
them, one character at a time, to hear the difference — so the thing you need to
change is something you can hear, not just a number.

Everything runs in the browser. No account, no upload, no server: the audio
never leaves the machine it was recorded on.

### A short tour

[![A brief overview of CWT](https://img.youtube.com/vi/GNOEatmSevQ/maxresdefault.jpg)](https://youtu.be/GNOEatmSevQ)

```
npm install
npm run build
npm run dev        # then open the URL it prints
```

---

## What it is

A browser app. TypeScript and React, no server: it records from your input
device, decodes, grades and draws, entirely client-side, and deploys as static
files.

Audio never leaves the machine. Recordings live in IndexedDB along with the
settings you were looking at them under.

---

## Using it

`npm run dev`, then:

1. Say what you're about to send, and at what speed.
2. Hit record and key it.
3. Stop, and read.
4. Record again.

That fourth step is the point. Attempts **stack**: a second recording joins the
first rather than replacing it, and the chart draws them one under another
against the same target, on the same columns. Reading down a column is then a
real question — did I drop that letter every time, or only once — and the drift
traces share one axis, so a wander getting smaller is a wander you can see
getting smaller.

Click a run's name in the gutter to read it in detail; the scores, the tables
and the audio follow. **Drop run N** throws one attempt away and keeps the
rest. **Sort** reorders the rows — newest first while you're still going, most
consistent first when you're hunting for the one that went right. A run keeps
the number it was recorded with wherever it lands.

A session is several attempts at **one message at one speed** — that's what
makes the rows comparable. **New session** is where those change; the intended
message stays editable for fixing a typo, where re-grading
every attempt is exactly what you want.

Or open a recording you already have — the button beside record, or drop the
file anywhere on the page. WAV, MP3, M4A, FLAC and OGG all work. A file carries
its own speed, so it can start a session but not join one.

A virtual loopback device (BlackHole, Loopback, VB-Cable) shows up as an
ordinary input, so you can key an app on the same machine and record it.

Reloading does not lose the session: every attempt — audio and all — is kept in
IndexedDB with the settings you were looking at them under, and a refresh comes
back to the one you were reading. Nothing leaves the machine, and the last ten
recordings are kept so the audio cannot grow without a bound.

The review's **↓ JSON report** button writes a stable, documented shape, so a
directory of them is one time series.

---

## Reading the chart

**Per character** lines every character pair up at the same left edge, so the
shape of your elements is readable. **Absolute time** puts both on one wall
clock, so accumulated drift shears them apart. **Overlay** superimposes them.

- Blue is within tolerance, amber up to 2× off, red worse.
- A dashed outline is a character that should have been there and wasn't.
- Purple with a wavy spine is a **rest** — you stopping between transmissions.
  Not graded, and drawn at a fixed width with its real length on the label.
- The **DRIFT** strip is how far ahead or behind the ideal clock you've fallen.
  It restarts after every rest, because stopping isn't drift. Every attempt in
  the session draws a trace, all against one axis — scaled to its own worst
  moment, a run half as bad would draw an identical picture.

Scroll to zoom, drag or shift-scroll to pan, click a character to hear it, click
the ruler to seek. In the deviations table, click **yours** and then **target**
to hear one fault back to back — which tells you far more than "1.49u" does.

---

## What the numbers mean

One **dit** is the unit. At the target speed everything else follows from it:
a dah is 3, the gap inside a character is 1, between characters 3, between words
7. Farnsworth sends the characters at full speed and stretches only the spacing,
using the KE3Z model — `Ta = 60/S − 37.2/C` seconds of spacing per word, spread
over PARIS's 19 spacing units.

**Consistent** is the share of your elements inside tolerance. It's the figure
that matters for keying, and it needs no intended message.

**Accurate** is how much of your intended message came back correctly. It only
appears when you gave one, because scoring a decode against itself is a
meaningless 100%.

Two things are worth knowing about how gaps get classified:

- **Your intended text decides gap classes, not their length.** Send Farnsworth
  against a tighter target and your letter gaps overshoot the char/word split;
  read by duration they'd be graded as word gaps, average out flatteringly, and
  the character-gap row would vanish from the report. The alignment against what
  you meant to send fixes each gap's class before anything is graded.
- **A single-letter drill is ambiguous, and the text settles it.** `A B C D E F`
  has no character gaps at all, so the most common silence in it is a *word*
  gap. Reading that as a character gap puts the overall speed out by a factor of
  7/3 — 8 wpm reported for sending that was 14. Nothing in the audio can tell
  the two apart; the intended text can, and does.

---

## What calibration does

If your keyer's sidetone reaches the computer directly, skip this — there is
nothing in the path to correct. Calibration is for when a microphone is
listening to a speaker.

**A room delays every release.** Let up the paddle and the direct sound stops,
but the reflections don't: the envelope stays above the threshold for a few
more milliseconds. Every mark reads long and every gap reads short, by the same
amount. It is a systematic bias, not noise — one webcam four feet from a
speaker adds about twelve milliseconds to dits, dahs, iambic, isolated elements
and ordinary text alike.

That constant is worth removing because everything here is **ratios**. A dit is
1 unit, a dah 3, the gap inside a character 1, between characters 3, between
words 7. A constant added to every mark and taken from every gap skews all of
them at once, and skews the two halves in opposite directions, so the error
doubles in every ratio it touches:

| | uncorrected | corrected | keyed |
|---|---|---|---|
| dit | 87.55 ms | 79.63 ms | 80 ms |
| speed | 14.30 wpm | 15.00 wpm | 15 wpm |
| dit : dah | 2.88 | 3.04 | 3.00 |

That is the difference between being told your dahs are short and being told
nothing is wrong.

**Which is why the wizard asks you to hold a paddle.** Nothing in a single
recording reveals the offset, because nothing in it says what the element
lengths were *meant* to be. A keyer holding a dit is a machine: the elements
are exactly one unit whatever your skill, because the keyer supplies the timing
and you supply only the intent. Send a few seconds of that at a stated speed
and the difference between what came back and what must have been sent is the
number.

**What it is not.** One number, applied by moving it from each mark into the
gap that follows — the recording's total length never changes. It cannot
rescue marks a room has broken into pieces, or undo AGC, or anything else that
isn't a constant. So when the two drills disagree, calibration **refuses**
rather than storing a number that would be confidently wrong on every later
recording. A profile also carries how much the drills disagreed and how many
elements stood behind the answer, which is what that refusal is decided on.

Everything else the decoder does to cope with a room — following the signal
level, closing dips that aren't key-ups, placing edges on slow transitions —
needs no calibration and runs on every recording. The release offset is the
one thing that cannot be inferred without being told what was sent.

---

## Development

```
make help          # everything below, with descriptions
make dev           # app with hot reload
make test          # pure + DOM tiers
make test-all      # all of it, including real Chromium
make serve:latest  # build, then serve it at localhost:4173
```

### The module layout

```
app/src/
  types/      the shared vocabulary — every shape, in one place
  dsp/        audio → segments. decode-audio.ts is the only Web Audio file
  timing/     segments + text → a graded review. Pure.
  render/     the canvas. Framework-free; React never enters the draw loop
  audio/      playback and the target synthesizer
  capture/    microphone and file input
  io/         take building, the JSON report, storage, calibration
  ui/         React
```

Two rules hold the rest up:

- **`dsp/` and `timing/` import from `types/` and nothing else.** They're pure
  functions over typed arrays and plain objects, they run under Node with no
  environment at all, and that's where most of the test value is.
- **Web Audio exists in exactly two places**: `dsp/decode-audio.ts` and
  `audio/`. Everything downstream works in *seconds*, so it's rate-agnostic by
  construction — which is why a 48 kHz recording and an 8 kHz synthesized target
  share one timeline without anything converting between them.

### Three test tiers

Chosen by filename, so a module can have a fast test for its math and a browser
test for its rendering without being split in two.

| | | |
|---|---|---|
| `*.test.ts` | node, no DOM | DSP, timing, grading, reports. Milliseconds. |
| `*.dom.test.tsx` | jsdom | controls, markup, wiring |
| `*.browser.test.ts` | real Chromium | canvas, Web Audio, the whole app mounted |

jsdom has no canvas context and no Web Audio at all, so anything touching those
lives in the third tier rather than behind a mock convincing enough to lie.

### What the tests are held to

Two recorded references, at two different standards, over a corpus of real
recordings in `tests/data`.

- **The oracle** (`app/test/oracle/`) holds decoding and grading to numbers
  derived independently. Grading must match **exactly**, to 1e-9, fed the same
  segments — nothing there depends on how the audio was measured, so a
  disagreement is a bug in the arithmetic. The DSP gets a stated tolerance
  instead: same segment count, every boundary within 1.5 ms, the same decoded
  text, and a measured speed within half a wpm of what the recording was
  *actually* sent at.
- **The clean-path lock** (`app/test/lock/`) holds the DSP to its own previous
  answer, bit for bit. The oracle's 1.5 ms would let a change move every
  boundary on every clean recording and still pass; work on poor-quality audio
  has to leave good audio untouched, and bit-identical is the only version of
  that promise a test can enforce. `make lock` re-records it, deliberately, and
  the diff is a diff in what users get.

The envelope detector is why the oracle's DSP half has a tolerance at all. It
quadrature-demodulates and lowpasses with cascaded zero-phase boxcars at the
recording's own rate — the same quantity a Butterworth-plus-Hilbert gives,
derived rather than transformed, at O(N) and with no resampler in the
measurement path, so two browsers can't disagree about a mark boundary because
they round differently.

That last point has one wrinkle worth knowing: `decodeAudioData` always
resamples to the rate of the context it's called on, so decoding through a plain
`AudioContext` would hand back whatever the hardware runs at. The decoder reads
the sample rate out of the WAV header first and decodes into an offline context
at exactly that rate; other formats get one fixed rate, so the answer still
doesn't depend on the machine.

### Deploying

`npm run build` writes static files to `dist/`. Serve them from anywhere — asset
paths are relative, so the same build works at a domain root, under a project
subpath like `/cwt/`, or straight off disk. Nothing to configure.

---

## License

MIT.
