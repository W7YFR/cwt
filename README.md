# cw-decoder

Decode Morse code (CW) from an audio recording into text. It auto-detects the
tone frequency and speed, decodes the message, and — optionally — grades your
keying against a target speed and scores it against the message you *meant* to
send. Built for CW practice (CWops, LCWO, etc.).

---

## Install

```sh
make install
```

This creates an isolated `.venv`, installs the package (editable) into it, and
symlinks `cw-decode` into `~/.local/bin` so it works from anywhere:

```sh
cw-decode ~/recordings/qso.wav
```

If `~/.local/bin` isn't on your `PATH`, add it. `make uninstall` removes the
symlink; `make clean` removes the venv. Because the install is editable, edits to
the source take effect immediately — no reinstall needed.

---

## Quick start

```sh
cw-decode recording.wav                 # decode; speed/tone report + text
cw-decode recording.mp3 -q              # just the decoded text
cw-decode -w 25 -f 12 recording.wav     # grade my keying against 25/12 wpm
cw-decode -e message.txt recording.wav  # score accuracy vs the intended text
cw-decode --web-review recording.wav    # ...and see it drawn in a browser
```

Everything prints to **stdout**: the decoded text, plus any report lines
(prefixed with `#`). Only real errors go to stderr. To get *just* the decoded
text, use `-q`; for a machine-readable report, use `--json`:

```sh
cw-decode recording.wav              # report (#-lines) + decoded text
cw-decode -q recording.wav           # decoded text only
cw-decode -q recording.wav > out.txt # save just the text
cw-decode --json recording.wav       # structured JSON, nothing else
```

---

## Options

| Flag | Meaning |
|------|---------|
| `input` | Audio file. WAV is read directly; other formats go through ffmpeg. |
| `-t, --tone HZ` | Force the CW tone frequency. Default: auto-detect. |
| `-b, --bandwidth HZ` | Bandpass half-width around the tone (default 200). Narrow it (e.g. `-b 100`) on a crowded/noisy band. |
| `-r, --rate HZ` | Internal sample rate (default 8000; rarely needs changing). |
| `-w, --target-wpm N` | Your target **character** speed. Turns on the practice report. |
| `-f, --target-farnsworth N` | Your target **overall** (Farnsworth) speed. Defaults to `--target-wpm`. Only meaningful with `-w`. |
| `-T, --tolerance PCT` | Grading tolerance in percent (default 30). Smaller = stricter. |
| `-e, --expected TEXT\|FILE` | The intended message — literal text (`-e "CQ DE AB1CD"`) or a path to a text file. Scores decode accuracy against it. |
| `-q, --quiet` | Print only the decoded text (suppresses all reports). |
| `--json` | Emit a single structured JSON object to stdout (text + speeds + grading + accuracy) and nothing else. |
| `--color auto\|always\|never` | Colorize the report — green/yellow/red for good/marginal/bad (default `auto`: only on a terminal, honors `NO_COLOR`). Never applied to `--json`. |
| `--web-review` | Also build an interactive review page (your keying drawn against perfect timing, spacing annotated, both playable) and open it in a browser. See [Web review](#web-review-see-your-spacing). |
| `--web-out FILE` | Where to write that page (implies `--web-review`). Default: `~/.cw-decoder/sessions/<timestamp>/review.html`. |
| `--live` | Trainer mode: capture from an audio input device (live keying) instead of a file, then decode and grade. |
| `--capture-backend` | `auto` (default), `portaudio`, or `ffmpeg`. PortAudio buffers properly and reports overflows; ffmpeg is the macOS-only fallback and **drops buffers on some devices**. **Device indices differ between backends** — list and select with the same one. |
| `--preview` | With `--live`, also print the decode in **real time** as you key (requires `-w`). |
| `--list-devices` | List available audio input devices and exit. |
| `-D, --device` | Audio input device for `--live`: an index, or the device's **name** (or any unambiguous part of it, case-insensitive). Remembered by name for next time, so it survives re-indexing. `-D ask` forgets it and asks again. |
| `--duration SEC` | Max live-capture length; also stops early on Enter (default 120, prevents runaway recordings). |
| `--capture-rate HZ` | Force a capture rate. Default: **the device's own rate, no resampling**. Forcing one makes ffmpeg resample every sample, which audibly roughens a keyer sidetone. Only affects the saved/played-back audio — the decoder resamples internally regardless. |
| `--trim-pad SEC` | Dead air to keep at each end of a live capture; the rest is trimmed (default 0.75). |
| `--no-trim` | Keep a live capture exactly as recorded, dead air and all. |
| `--save WAVFILE` | Keep the captured audio (default: discarded after decoding). |
| `--demo [TEXT]` | Decode a synthesized signal instead of a file (self-test); pairs with `--demo-wpm`, `--demo-farnsworth`, `--demo-noise`. |

---

## Reading the basic report

Without a target, you get tone and measured speed:

```
# tone           : 700.3 Hz
# character speed: 25.3 wpm (126 cpm)
# overall speed  : 18.7 wpm (Farnsworth)
```

- **character speed** — the element (dit/dah) speed, `1.2 / dit_seconds` (PARIS).
- **overall speed** — the effective speed including inter-character/word spacing.
  If it's lower than the character speed, the sending is Farnsworth-spaced.

---

## Practice mode: grade against a target speed

Tell it what you were *trying* to send (`-w` character speed, optional `-f`
overall speed) and it decodes against that **ideal** timing and grades you:

```sh
cw-decode -w 25 recording.wav           # target 25 wpm, standard spacing
cw-decode -w 25 -f 12 recording.wav     # 25 wpm characters, 12 wpm overall
cw-decode -w 25 -f 12 -T 15 rec.wav     # same, but stricter (±15%) grading
```

```
# ===== practice report =====
#   character speed :  25.3 wpm  (target 25.0, +0.3)  OK
#   overall speed   :  18.7 wpm  (target 25.0, -6.3)  **   <- spacing too loose for 25
#   target unit     : 48.0 ms/dit
#
#   element / spacing (in target units; 'OK' within 15%):
#     dit            : 0.98u avg  (target 1.00)  jitter ±0.00u  n=126 OK
#     dah            : 2.99u avg  (target 3.00)  jitter ±0.00u  n=102 OK
#     intra-char gap : 1.08u avg  (target 1.00)  jitter ±0.08u  n=153 OK
#     character gap  : 3.70u avg  (target 3.00)  jitter ±0.66u  n=19  OK
#     word gap       : 7.57u avg  (target 7.00)  jitter ±2.53u  n=44  OK
#   consistency     : 95% of elements within tolerance
#   (11 long inter-transmission pause(s) ignored)
#   largest deviations:
#     t=  2.80s  word-gap     13.57u (target 7.00) after "R O B"
```

How to read it:

- Everything is in **target units** — `1u` is one dit at your target speed. The
  ideal is dit `1`, dah `3`, intra-character gap `1`, character gap `3`, word gap
  `7` (character/word gaps stretch under Farnsworth, and the report shows the
  correct stretched targets).
- **jitter** (`±`) is the standard deviation — how *consistent* you were. Low
  jitter with an off average means a consistent bias; high jitter means uneven.
- **`OK` / `~` / `**`** flag each average as good / marginal / off (within
  tolerance / within 2×tolerance / beyond). On a terminal these are colored
  green / yellow / red so you can scan the report at a glance.
- **largest deviations** are timestamped and labeled with the text they follow,
  so you can find the exact spot in your recording.
- **Long pauses** between transmissions are detected and excluded so they don't
  count as spacing errors.

Note: if your sending doesn't match the target, decoding against it will
**over-segment** (loose character spacing splits letters apart, e.g. `R O B`) —
that's the point, it shows where you drifted. Drop `-w/-f` for a clean read.

---

## Compare against the intended text

Pass the message you meant to send with `-e` — either directly as text or as a
path to a text file:

```sh
cw-decode -e "CQ CQ DE AB1CD K" recording.wav     # literal text
cw-decode -e message.txt recording.wav            # or a file
```

If the value names an existing file it's read; otherwise it's used as the text
(the report's `source:` line shows `(inline text)` in that case). As a typo
guard, a value ending in `.txt` that *doesn't* exist is treated as a mistyped
filename and errors out rather than being graded as literal text.

**Sibling auto-discovery:** if you don't pass `-e`, it automatically looks for a
text file with the same base name as the audio in the same directory and uses it
if present. So if you keep `qso.wav` and `qso.txt` together, this just works:

```sh
cw-decode qso.wav          # uses qso.txt if it exists
```

An explicit `-e FILE` always wins over the sibling. The report's `source:` line
shows which text it compared against.

```
# ===== accuracy vs intended text =====
#   accuracy : 96.7%  (8 error(s) in 91 symbols: 0 sub, 5 extra, 3 missed)
#   diff ([exp→got] substitution, [+extra], [-missed]):
#     ROB DE W7YFR ROB DE W7YFR ROB DE [+WZEEE]W7YFR ROB DE W7YFR ROB DE W7YFR
#     ROB DE W7YFR 73[- ]73[- ]W7YFR[- ]<BK>
```

- **accuracy** — matched symbols ÷ intended symbols, with a breakdown into
  substitutions, **extra** symbols (in the decode but not intended), and
  **missed** symbols (intended but not decoded).
- **diff** annotations: `[X→Y]` you sent Y where X was intended; `[+Y]` extra;
  `[-X]` missing. In the example above, `[+WZEEE]` is a fumbled correction and
  the `[- ]` marks show `7373W7YFR` was sent too tight (spaces missing).
- Comparison is case-insensitive and understands prosigns (`<BK>` is one symbol).
- Alignment is true minimal-edit (Levenshtein), so repeated text (a call sent
  several times) localizes errors correctly instead of smearing them.

`-w`/`-f`, `-T`, and `-e` combine freely — e.g. grade timing *and* score accuracy
at once:

```sh
cw-decode -w 25 -f 12 -T 20 -e message.txt recording.wav
```

(`-q` suppresses the reports, including accuracy — omit it to see them.)

---

## Trainer: key live and get graded

Instead of recording a file first, `--live` captures straight from an audio
input (your rig's sidetone into an interface, a keyer's audio, or a mic) and then
decodes and grades it — the same reports as above. Add `--preview` to watch it
decode in real time as you key. (macOS only for now.)

```sh
cw-decode --list-devices                        # see input devices
cw-decode --live -D 1                            # just decode what you key
cw-decode --live -D 1 -w 20                      # + grade timing vs 20 wpm
cw-decode --live -D 1 -w 20 -e "CQ DE AB1CD K"  # + score against a message
cw-decode --live -D 1 -w 20 -e message.txt      # target from a file instead
```

`--live` means "capture my keying" (as opposed to decoding a file). Both `-w`
(target speed) and `-e` (intended message) are **optional**: add `-w` for the
timing/spacing report, add `-e` for the accuracy score, or use neither to just
decode. (Add `--preview`, below, to watch it decode in real time.)

When you supply the target text (via `-e` or a sibling `.txt`), it prints the
message to send before recording, so you know what to key:

```
# send this:
#   CQ CQ DE AB1CD K
#
# recording on device 1 — key your message, then press Enter to stop.
```

Pick the input with `-D` (index from `--list-devices`); omit it and you'll get a
prompt. Recording stops when you **press Enter**, or automatically after the
`--duration` cap (default **30 s**). Add `--save practice.wav` to keep the take.

A typical practice loop — put the target in a text file once, then repeat:

```sh
echo "CQ CQ DE AB1CD K" > message.txt
cw-decode --live -D 1 -w 20 -e message.txt   # key it, read the grade, repeat
```

You get the spacing breakdown and the accuracy diff each time, so you can watch
your word timing tighten up. Notes:

- First use may trigger a macOS microphone-permission prompt for your terminal.
- The capture goes through the same pipeline as a file, so tone auto-detect,
  `-t`, and `-b` all work the same.
- `--save` pairs well with the fixture workflow: a good take can be dropped into
  `tests/data/` as a regression fixture.

### Real-time preview (`--preview`)

Add `--preview` to `--live` and it decodes *while* you key — characters stream to
the screen instead of appearing only at the end. It needs a target speed (`-w`)
to lock its timing; `-e` is optional (add it only if you want the accuracy
score):

```sh
cw-decode --live --preview -D 1 -w 20                     # live decode + timing report
cw-decode --live --preview -D 1 -w 20 -e "CQ DE AB1CD K"  # + score against a message
```

```
# send this:
#   CQ DE AB1CD K
# live decode (20 wpm) on device 1 — key now; Enter to stop (auto after 30s).
CQ DE AB1CD K            <- this line grows as you send

# ===== practice report =====     <- full report + accuracy at stop
#   character speed : 19.8 wpm (target 20.0) OK
#   ...
```

How it works and what to expect:

- The live line refreshes a few times a second and uses your `-w` target for
  timing (so it doubles as "am I on speed"). A character shows up about one
  character-gap after you finish it — you have to key the gap for the decoder to
  know the character ended.
- When you stop (Enter or the `--duration` cap), it runs the **full batch decode
  and grading** on the complete audio — that report is the authoritative result;
  the live line is just feedback.
- The live text is inherently a bit less precise than the final pass (it decodes
  causally, without seeing the whole recording), so trust the report for grading.
- Works with `--save` (keep the take) and `--json` (the live line goes to stderr;
  the final JSON is the only thing on stdout).

## Web review: see your spacing

The terminal report tells you *that* your character gaps ran long. `--web-review`
shows you **where**, drawn against what perfect keying would have looked like:

```sh
cw-decode -w 25 -f 12 -e message.txt --web-review recording.wav
cw-decode --live -w 20 -e message.txt --web-review        # after a live take
cw-decode --web-out ~/cw/2026-09-08.html recording.wav    # keep it somewhere
```

It writes one self-contained HTML file and opens it. Two stacked tracks — **YOU**
over **TGT** — with every mark as a block and every gap as a labelled span:

```
        ┌ C ─────────┐        ┌ Q ─────────────┐            ┌ D ─────┐
 YOU    ▇▇▇ ▇ ▇▇▇ ▇   ╎ 3.4 ╎  ▇▇▇ ▇▇▇ ▇ ▇▇▇   ╎   9.1   ╎   ▇▇▇ ▇ ▇
                          ~                        **           OK
 TGT    ███ █ ███ █   ╎ 3.0 ╎  ███ ███ █ ███   ╎   7.0   ╎   ███ █ █
```

**Three views, and the differences matter.**

| View | What it's for |
|------|---------------|
| **Per character** (default) | Every character pair starts at the same x, so element *shape* is readable. Accumulated speed drift is invisible here — which is why there's a **drift strip** underneath plotting your running timing error. |
| **Absolute time** | Both tracks on one wall clock, so drift shears them apart. Honest, but harder to read locally. |
| **Overlay** | The two tracks superimposed and translucent on one clock. Where you match the target you see a blend; where you don't, a colored fringe — drift read directly instead of inferred, with a leader line from each character to where the target put it. |

**Downloads.** Three buttons under the chart: your recording, the target audio (rendered fresh at whatever speed the
sliders are on, so the filename carries the wpm), and a PNG of the whole
analysis — the full session, not just the visible slice. Very long sessions get
zoomed out just enough to stay inside the browser's canvas limit.

**Levels are never altered.** The decode path peak-normalizes on purpose (the
Otsu threshold works on absolute amplitude), but the embedded audio and the
download are the recording at the level it was made — bit-identical to the
source. The **Listening level** slider starts at unity (0 dB) and boosts at
playback via a gain node when you want it, applied equally to your track and
the target so A/B compares timing rather than loudness. That slider changes
nothing about the files.

**Listening.** Your recording is embedded in the page, so you can replay
yourself and A/B against the target. It plays from a buffer decoded once on
first play — not an `<audio>` element, which on some `file://`/`data:`
combinations routes through Web Audio as silence. In **largest deviations**, each row's
*yours* and *target* figures are separate play controls — click back and forth
to hear the difference, with the characters either side included since spacing
is only audible in context. The target isn't a baked file — it's
synthesized with Web Audio at **the tone frequency detected in your recording**
(shown in the header), which is what lets it re-render instantly when you move
the speed slider instead of going stale. It's rendered at your recording's peak
too, so the two are level-matched. Click any character to hear just that character, on either track. Click a
row in "largest deviations" to jump to that moment.

**Re-grading without re-running.** The page ships the raw segment timings in
seconds rather than pre-divided into units, so the sliders re-derive the whole
grading client-side: character speed, Farnsworth spacing, tolerance, even a
different intended message. Useful for "was that actually 22 wpm sending?" and
for finding the speed at which your spacing stops being the problem.

The one thing it *can't* redo is the signal processing that produced those
segments — tone, bandwidth, threshold, debounce. Change those and re-run the
command.

Notes:

- **Opt-in and offline.** Nothing is written unless you pass the flag, and the
  page has no external references at all — no CDN, no fonts, no network. It works
  from `file://` forever and can be archived or mailed as a single file.
- **Dead air is trimmed.** A live take gets cut back to 0.75 s of silence
  either side of your keying (`--trim-pad`, or `--no-trim` to keep it all), so
  the review timeline starts at your sending instead of after however long it
  took you to reach the paddle. Detection runs through the same
  bandpass-and-threshold the decoder uses, so it keys off the *tone* — noise or
  hum on an idle input won't defeat it — and it declines to trim at all rather
  than risk clipping audio it can't account for.
- **The device is remembered**, by name rather than index, since indices shift
  as hardware comes and goes. `-D` accepts a name or a fragment of one
  (`-D blackhole`), the choice is saved once a capture actually succeeds, and
  `-D ask` forgets it and re-prompts. If the remembered device isn't there any
  more you're told so and get the chooser. State lives in
  `~/.cw-decoder/config.json`, per backend.
- **Capture backend.** Live capture prefers **PortAudio** (`pip install
  'cw-decoder[live]'`, bundled in the wheel), falling back to ffmpeg. This is
  not a preference — ffmpeg's macOS avfoundation audio path drops capture
  buffers on real hardware even with its input queue raised to 8192 and every
  conversion removed from the realtime path. PortAudio takes a generous
  driver-side buffer and *reports* input overflow through its callback, so a
  glitch is a message instead of something you find by ear.

  Whichever backend runs, capture is a passthrough: the device's own rate and
  channel count, no filters. Folding to mono and resampling to the decoder's
  8 kHz working rate happen afterwards, off the clock.
- **Dropped-buffer detection.** After a live capture the recording is checked
  for dropped audio buffers and you get a warning naming the count and the
  timestamps. A dropped buffer splices the waveform at a random phase: it
  clicks, it shortens whatever dit or dah it landed in, and because the unit
  estimate averages the dit with a third of the dah, it makes the report read
  *faster* than you keyed. That used to be discoverable only by ear.
- **The header shows** the detected tone, the measured speeds, the recording's
  peak level in dBFS, and its sample rate. The tone is worth watching: it's what
  the decoder locked onto, so a wrong reading there explains a bad decode —
  force it with `-t/--tone`.
- **Audio fidelity: nothing resamples on the listening path.** Live capture
  passes no `-ar` to ffmpeg, so it records at the device's native rate, and the
  page embeds those samples unchanged — bit-identical to the capture. The
  decoder resamples to its own 8 kHz working rate internally, which is plenty
  to decode a sub-1 kHz tone; block times are in seconds, so the timeline lines
  up at any rate.

  This matters more than it sounds. Forcing a rate made ffmpeg resample every
  sample, and on a square-ish keyer sidetone a 48 kHz → 44.1 kHz conversion
  leaves the harmonics intact while lifting the noise *between* them by ~6 dB
  (worse in practice). That is what "crunchy" sounds like. `--capture-rate` is
  still there if you want a smaller file, at that cost.
- **Size** is dominated by the embedded audio: ~96 KB/s at 48 kHz, ~20 KB/s at
  8 kHz. A 30-second take at 48 kHz is roughly 3.8 MB; `--capture-rate 8000`
  brings the same take to about 300 KB. The stderr line reports the actual size
  and rate.
- **Live takes are kept.** `--live --web-review` records straight into the
  session directory as `session.wav`, at the full capture rate, so the take
  stays usable in Audacity or anything else — unless `--save` already put one
  where you asked. Without `--web-review`, live audio is still discarded as
  before.
- **No `-e`?** The target track falls back to your own decode: character grading
  is meaningless then, but spacing grading — the point — still works.
- **No `-w`?** The target defaults to your own measured speed, i.e. "what you
  sent, keyed perfectly."
- **The terminal practice report is suppressed** when a review page is
  requested — the page *is* the report, so printing it twice is just noise. The
  decoded text still goes to stdout, and the stderr lines naming the files
  written still appear. Drop `--web-review` if you want the report in the
  terminal.
- **`--json` is unaffected**; it's an explicit machine-readable request, so you
  can log a session and open the page from the same run.

## JSON output

For logging practice over time or feeding another tool, `--json` emits one object
with everything — decoded text, measured/target speeds, per-element grading, and
accuracy:

```sh
cw-decode -w 25 -f 12 -e message.txt --json recording.wav > session.json
```

```jsonc
{
  "text": "ROB DE W7YFR ...",
  "tone_hz": 700.4,
  "measured": { "char_wpm": 24.98, "farnsworth_wpm": 6.83, "unit_ms": 48.04 },
  "target":   { "char_wpm": 25.0,  "farnsworth_wpm": 6.0,  "unit_ms": 48.0 },
  "analysis": {
    "tolerance": 0.15,
    "within_tolerance_frac": 0.79,
    "pauses_ignored": 5,
    "elements":  [ { "name": "dit", "n": 140, "mean_units": 1.0,
                     "std_units": 0.003, "target_units": 1.0, "ok": true }, ... ],
    "deviations":[ { "time_sec": 71.3, "kind": "char-gap", "value_units": 2.85,
                     "target_units": 28.0, "context": "OB DE WZEE" }, ... ]
  },
  "comparison": { "accuracy": 0.956, "n_expected": 91, "substitutions": 0,
                  "insertions": 5, "deletions": 3, "diff": "..." }
}
```

`target`, `analysis`, and `comparison` are `null` unless you pass `-w`/`-f` and
`-e` respectively. Pipe to `jq` to extract fields, e.g. accuracy over a folder:

```sh
for f in *.wav; do
  acc=$(cw-decode -e message.txt --json "$f" | jq -r '.comparison.accuracy')
  echo "$f: $acc"
done
```

---

## Supported formats

WAV is read directly. Anything ffmpeg can decode also works — **mp3, flac,
m4a/aac, aiff, ogg/opus**. An Audacity `.aup3` project is a database, not audio;
export it to WAV first (File → Export → Export as WAV).

---

## Prosigns

Prosigns (letters keyed run-together as one character) are decoded in angle-bracket
form: `<BK> <AR> <SK> <KN> <AS> <CT> <SN> <CL> <AA> <SOS> <HH>`. Where a prosign
shares its dit/dah pattern with a punctuation mark, the on-air reading wins
(`.-.-.` → `<AR>`, not `+`) — except `-...-`, which stays `=` (the separator hams
write literally) rather than `<BT>`.

---

## How it works

`load audio → detect tone (FFT) → bandpass + Hilbert envelope → adaptive threshold
→ run-length segments → cluster marks (dit/dah) and gaps (element/char/word) →
derive speeds → map through the Morse table`.

Character speed comes from the dit length (`WPM = 1.2 / dit_seconds`). Farnsworth
overall speed is recovered from the stretched inter-character spacing using the
KE3Z timing model. The same model runs in reverse to build the *ideal* timing a
`--target-wpm/-f` refers to.

`core.build_timeline()` is the single source of truth for "what did the sender
actually key": it returns the decoded text, the per-character grouping, and every
mark and gap measured against a reference timing. `decode_segments`, `analyze`,
and the web review payload are all layers over it.

Because the review page re-grades client-side, `web/review-core.js` is a port of
that timing logic into JavaScript. It's a port, not a re-imagining — every
function has a named counterpart in `core.py`, and `test_js_grading_matches_python`
runs both over the same segments and asserts they agree to 1e-9. Change one side,
change the other, and let that test tell you if you drifted.

---

## Develop / test

```sh
make dev      # editable install + test deps into the venv
make test     # round-trip tests: synthesize known CW, decode, compare
make demo     # decode a synthesized message end-to-end
```

Self-test without any audio file (synthesizes, decodes, and scores itself):

```sh
cw-decode --demo "CQ CQ DE W7YFR <AR> K" --demo-wpm 22 --demo-farnsworth 13 --demo-noise 0.15
```

The web-review tests need `node` on `PATH` (they run the JavaScript against the
Python, and boot the real page under a stub DOM to catch anything that would
otherwise only show up as a blank browser tab). They skip cleanly without it.

---

## License

MIT — see [LICENSE](LICENSE).
