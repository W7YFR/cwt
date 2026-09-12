# CWT — CW Trainer

**See what your keying is doing, and get better at it.**

Key into your microphone — or into an app through a loopback device — and every
dit, dah and gap is measured against a perfect sender at the same speed. Your
sending and the ideal version are drawn on one chart, and you can play either of
them, one character at a time, to hear the difference — so the thing you need to
change is something you can hear, not just a number.

Everything runs in the browser. No account, no upload, no server: the audio
never leaves the machine it was recorded on.

```
npm install
npm run build
npm run dev        # then open the URL it prints
```

---

## Two halves, one analysis

The project is a browser app with a command-line front door.

| | |
|---|---|
| **`app/`** | The trainer. TypeScript + React. Records, decodes, grades and draws — the whole thing, client-side. Deploys as static files. |
| **`src/cw_decoder/`** | The CLI, `cw-decode`. Records or reads a file, runs its own DSP, and hands the result to the app. Also the oracle the port is checked against. |

The important part is what they *don't* both do. The CLI decodes audio into
segments — `(key down, 0.061 s)`, `(key up, 0.058 s)` — and stops there.
Everything downstream of that (the timing model, the grading, the alignment
against your intended message, the chart, the report) exists once, in
TypeScript. A session reviewed from the terminal and one recorded in the browser
go through the same code and cannot disagree.

---

## Using it

### In the browser

`npm run dev`, then:

1. Type what you're about to send (optional — timing works without it, but with
   it you get accuracy too).
2. Hit record and key.
3. Stop, and read.

Then record again from the review itself, without losing the speeds and
tolerance you have set — that is the loop. The name in the header takes you
back to the start when you want a clean slate.

Or drop a recording you already have onto the page. WAV, MP3, M4A, FLAC and OGG
all work.

A virtual loopback device (BlackHole, Loopback, VB-Cable) shows up as an
ordinary input, so you can key an app on the same machine and record it.

Reloading the page does not lose the session. The current take — audio and all
— is kept in IndexedDB along with the settings you were looking at it under, so
a refresh comes back to exactly where you were. It never leaves the machine,
and the last ten takes are kept so the audio cannot grow without a bound.

### From the terminal

```
cw-decode                                  # record from the default input
cw-decode -e "cq pota de w7yfr" -w 25 -f 14
cw-decode ~/recordings/practice.wav
cw-decode --demo "CQ CQ DE W1AW K"         # synthesize and analyze
```

Each of these writes a session bundle, serves it alongside the built app, and
opens a browser at it. Ctrl-C when you're done with the page.

| flag | |
|---|---|
| `-e TEXT\|FILE` | what you meant to send; enables accuracy scoring and fixes the gap classes |
| `-w`, `-f` | target character and overall (Farnsworth) speed |
| `--json` | machine-readable report to stdout; no browser |
| `--basic` | the plain terminal report; no browser |
| `--web-out DIR` | where to write the session (default `~/.cw-decoder/sessions/<stamp>/`) |
| `--app-dir DIR` | which build to serve (default: `dist/` beside the checkout) |
| `--no-open` | serve, but print the URL instead of launching a browser |
| `-D`, `--list-devices` | choose an input device |

`--json` and the review's own **↓ JSON report** button write the same shape, so a
directory of them from either source is one time series.

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
  It restarts after every rest, because stopping isn't drift.

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

## Development

```
make help          # everything below, with descriptions
make dev           # app with hot reload
make test          # pure + DOM tiers, and the Python suite
make test-all      # all of it, including real Chromium
make verify        # re-derive the oracle and hold the port to it
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
  io/         take building, the JSON report, storage, the CLI bundle
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

### The oracle

`make verify` runs the Python decoder over the fixture corpus, dumps what it
found, and holds the TypeScript to it. Two different standards, deliberately:

- **The grading must match exactly** — to 1e-9, fed the identical segments. It's
  a port, not a reimplementation, so any disagreement is a bug.
- **The DSP must match closely** — same segment count, every boundary within
  1.5 ms, same decoded text, and a measured speed within half a wpm of what the
  recording was *actually* sent at.

The DSP is deliberately not a line-for-line port. Python bandpassed with a
Butterworth and took the magnitude of the analytic signal via Hilbert transform,
at 8 kHz after resampling. TypeScript quadrature-demodulates and lowpasses with
cascaded zero-phase boxcars, at the recording's own rate. Same quantity, derived
rather than transformed, O(N), and with no resampler in the measurement path —
so two browsers can't disagree about a mark boundary because they round
differently.

That last point has one wrinkle worth knowing: `decodeAudioData` always
resamples to the rate of the context it's called on, so decoding through a plain
`AudioContext` would hand back whatever the hardware runs at. The decoder reads
the sample rate out of the WAV header first and decodes into an offline context
at exactly that rate; other formats get one fixed rate, so the answer still
doesn't depend on the machine.

### Deploying

`npm run build` writes static files to `dist/`. For a GitHub Pages project site,
set the base path to match the repo name:

```
PUBLIC_BASE=/your-repo-name/ npm run build
```

---

## License

MIT.
