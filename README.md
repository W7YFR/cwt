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

Click a name in the gutter to pick that track up — the scores, the tables and
the audio follow — and click it again to play it. **TGT** is one of them, so
the target is picked up and played the same way an attempt is. The trash icon
throws one attempt away and keeps the rest.

**Show** is how many attempts the chart draws: all of them, the last few, or
only the newest — the comparison, or the loop. **Sort** reorders whatever is
drawn, newest first while you're still going, most consistent first when you're
hunting for the one that went right. A run keeps the number it was recorded
with wherever it lands.

Under the cog are the **practice aids**, which run while you record. The
**pacing cursor** walks the target track in real time after a count-in, and the
**flash card** puts the character you owe next on screen large. **Zen mode** is
the other kind: it clears the page for the take and leaves only the message in
type you can read at a glance, with the clock, the level and the way to stop.
It can't run with the other two — there is no beat to meet, and the take ends
when you say it does — so turning it on switches them off. It shows every pass **Times** asks for, one per line, sized to whatever fits
the window so you never have to scroll it. The keys work the
same behind it: enter finishes, r restarts, esc throws the take away. Unlike
every other aid it isn't remembered: it stays on through the sitting you turn
it on in and is off again next time, because a box ticked last week blanking
the screen mid-record is not a setting anyone would connect to a choice.

**Times** is how many passes of the message make up one take. The box still
holds one copy — that's what you're practicing, and typing a callsign out five
times to drill five of them is copying rather than practice. Everything the
target is realized as carries that many, separated by a word gap: the audio you
play, the row the chart draws, the pacing schedule, and what your sending is
graded against. Repetition is most of how sending is practiced, and the first
pass is rarely the one that goes wrong. It applies only to takes you key: a
recording opened from disk holds whatever it holds, so the control is barred
and the grading ignores it.

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

**Marks only** draws each character as one shape instead of the dits and dahs
inside it: a tick at the moment it starts in the per-character view, where the
axis is about order and silence, and the character's own extent on the clock
axes, where position already is time.

Scroll to zoom, drag or shift-scroll to pan, click a character to hear it,
click the ruler to seek — into whichever track you were last listening to. In
the deviations table, click **yours** and then **target** to hear one fault back
to back — which tells you far more than "1.49u" does.

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
listening to a speaker. **Need help?** under the calibration panel on the
landing screen says the same thing in the app, with the measurements behind it.

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
recordings in `app/test/data`.

- **The oracle** (`app/test/oracle/`) holds decoding and grading to numbers
  derived independently. Grading must match **exactly**, to 1e-9, fed the same
  segments — nothing there depends on how the audio was measured, so a
  disagreement is a bug in the arithmetic. The DSP gets a stated tolerance
  instead: same segment count, every boundary within 1.5 ms, the same decoded
  text, and a measured speed within half a wpm of what the recording was
  *actually* sent at.

  Four numbers in `cq-de-w7yfr` were re-derived rather than inherited: the
  measured character gap and the three figures that follow from it. The
  original derivation counted the dead air at the ends of the recording as
  spacing, and on that one file the pads happen to be the same size as its real
  character gaps, so they passed for two more of them. An independent reference
  is only worth having while it is independent *and* right; this one was the
  first, and the mark-derived numbers beside it are untouched.
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

### Versioning

The version lives in `package.json` and shows up in the page footer, so a bug
report can name the build it came from. It moves on your branch, before the
pull request:

```
make bump:dry   # what this branch would release, nothing written
make bump       # write it and make the release commit
```

`scripts/version.mjs` takes the bump from the branch you are standing on —
`feat/` is a minor, `fix/` and `chore/` are patches, an unrecognized prefix is
a patch rather than an error. It writes `package.json`, keeps the lockfile in
step, and commits the pair as `chore: release vX.Y.Z`. That commit rides in
with the change, so merging is what publishes the new version, and `main` is
never written to by a machine.

CI's only job about versions is to check that you did it. The `version` job
compares the merged result against the base and fails if the bump is missing or
weaker than the branch prefix asks for, naming the command that fixes it. A
*stronger* bump passes: somebody who ran `--release major` on a `fix/` branch
meant it.

While the major is 0 a breaking change bumps the minor, because pre-1.0 that is
the breaking axis; going to 1.0.0 is `--release major`, on purpose, by hand.

Two people cannot both claim `0.2.0`: whichever branch merges second fails the
check, and rebasing on `main` drops the now-duplicate release commit so
`make bump` gives it the next number.

Tags are not automatic. `make tag` annotates the current version at `HEAD`,
which is a thing to do on `main` after merging, if you want one.

#### Why CI cannot write anything

Every job in `.github/workflows/ci.yml` runs with `contents: read`. There is no
token, no deploy key, and no secret in the repository — the only elevated
permission anywhere is `pages: write` on the job that uploads the built site,
which cannot touch the repository at all.

That is the reason the bump is yours to make rather than the pipeline's. A
workflow that moved the version would need write access to `main`, and write
access is the thing worth stealing. The attacks people get hit with here are
not subtle: a pull request edits the workflow, CI runs it, and the job's
credentials leave the building. On the `pull_request` trigger GitHub gives a
fork's job no secrets and a read-only token, so there is nothing to take — but
that guarantee is specifically about `pull_request`. **Never change it to
`pull_request_target`**, which runs with the base repository's secrets and
write access; that trigger, combined with checking out the incoming code, is
how those attacks actually work.

The repository settings that complete this, neither of which lives in the repo:

- **Pages source: GitHub Actions** (Settings → Pages), or `deploy-pages` has
  nothing to publish to.
- **A ruleset on `main`** (Settings → Rules) requiring the `test` and `version`
  checks and a pull request, with force-pushes and deletion blocked. Repository
  admins are in the bypass list, so a direct push still works when you mean it.

### Deploying

`npm run build` writes static files to `dist/`. Serve them from anywhere — asset
paths are relative, so the same build works at a domain root, under a project
subpath like `/cwt/`, or straight off disk. Nothing to configure.

---

## License

MIT.
