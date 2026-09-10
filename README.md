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

That's everything, including live capture. `ffmpeg` is only needed to read
non-WAV audio files. On Linux, live capture also wants a system PortAudio
(`apt install libportaudio2`); decoding files doesn't.

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
| `--web-review` | Also build an interactive review page and open it in a browser. See [Web review](#web-review-see-your-spacing). |
| `--web-out FILE` | Where to write that page (implies `--web-review`). Default: `~/.cw-decoder/sessions/<timestamp>/review.html`. |
| `--live` | Trainer mode: capture from an audio input device (live keying) instead of a file, then decode and grade. |
| `--capture-backend` | `auto` (default), `portaudio`, or `ffmpeg`. Device indices differ between the two, so list and select with the same one. |
| `--preview` | With `--live`, also print the decode in **real time** as you key (requires `-w`). |
| `--list-devices` | List available audio input devices and exit. |
| `-D, --device` | Input device for `--live`: an index, or a name fragment (`-D blackhole`). Remembered for next time; `-D ask` forgets it and asks again. |
| `--duration SEC` | Max live-capture length; also stops early on Enter (default 120, prevents runaway recordings). |
| `--capture-rate HZ` | Force a capture rate. Default: the device's own rate, with no resampling (which sounds better). Smaller rates make smaller files. |
| `--trim-pad SEC` | Dead air to keep at each end of a live capture; the rest is trimmed (default 0.5). |
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

**Add `-e` when you can.** On its own, the grader has to guess what each silence
was *meant* to be from how long it lasted, and if your spacing is loose that
guess goes wrong in a way that flatters you: letter gaps get read as word gaps
and average out to a passing word-gap score, while the character-gap row
disappears from the report entirely. Worse, a badly overlong word gap can pass
the pause floor and be written off as a rest — hiding the largest error in the
recording. Tell it the intended message and every gap is graded as the class the
text calls for, whatever it measured.

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
- The same alignment feeds the **timing** grade: where a decoded character pairs
  with an intended one, the gap before it is graded as the class the intended
  text calls for rather than the one its duration read as. See the note under
  the practice report above for why that matters.

`-w`/`-f`, `-T`, and `-e` combine freely — e.g. grade timing *and* score accuracy
at once:

```sh
cw-decode -w 25 -f 12 -T 20 -e message.txt recording.wav
```

(`-q` suppresses the reports, including accuracy — omit it to see them.)

---

## Trainer: key live and get graded

Instead of recording a file first, `--live` captures straight from an audio input
(your rig's sidetone through an interface, a keyer's audio, or a mic) and then
decodes and grades it — the same reports as above.

```sh
cw-decode --list-devices                         # see input devices
cw-decode --live -D 1                            # just decode what you key
cw-decode --live -D 1 -w 20                      # + grade timing vs 20 wpm
cw-decode --live -D 1 -w 20 -e "CQ DE AB1CD K"   # + score against a message
cw-decode --live -w 20 -e message.txt            # device remembered from before
```

Both `-w` and `-e` are optional: add `-w` for the timing report, `-e` for the
accuracy score, or neither to just decode. When a target message is known it's
printed before recording so you know what to key:

```
# send this:
#   CQ CQ DE AB1CD K
#
# recording on device 1 (portaudio) — key your message, then press Enter to stop.
```

**Press Enter** to stop, or let the `--duration` cap end it (default 120 s).
**Ctrl-C** cancels instead and throws the take away. `--save practice.wav` keeps
the audio.

A practice loop — put the target in a file once, then repeat:

```sh
echo "CQ CQ DE AB1CD K" > message.txt
cw-decode --live -w 20 -e message.txt --web-review   # key it, read the grade, repeat
```

Notes:

- **Capture uses PortAudio**, which buffers properly and reports problems. It's
  installed as a dependency, so this just works. If PortAudio can't load (Linux
  needs a system `libportaudio2`), capture falls back to ffmpeg (macOS only),
  which drops audio buffers on some devices — that clicks, shortens your dits
  and dahs, and makes the report read faster than you keyed. Either way the
  recording is checked afterward and you're warned if buffers were dropped.
- **The device is remembered** by name, so it survives re-indexing when hardware
  comes and goes. `-D` takes an index or a name fragment (`-D blackhole`), and
  `-D ask` forgets it and asks again. Device indices differ between the two
  capture backends, so list and select with the same one.
- **Dead air is trimmed** to 0.5 s either side of your keying (`--trim-pad`, or
  `--no-trim` to keep it).
- First use may trigger a macOS microphone-permission prompt for your terminal.
- Tone auto-detect, `-t`, and `-b` work exactly as they do for a file.

### Real-time preview (`--preview`)

Add `--preview` and it decodes *while* you key, streaming characters to the
screen instead of only showing them at the end. It needs `-w` to lock its timing:

```sh
cw-decode --live --preview -D 1 -w 20
```

```
# send this:
#   CQ DE AB1CD K
# live decode (20 wpm) on device 1 — key now; Enter to stop (auto after 120s).
CQ DE AB1CD K            <- this line grows as you send
```

A character appears about one character-gap after you finish it — the decoder
needs the gap to know the character ended. The live line is feedback; when you
stop, the full decode and grading run on the complete recording and that report
is the authoritative one.

## Web review: see your spacing

The terminal report tells you *that* your character gaps ran long. `--web-review`
shows you **where**, drawn against what perfect keying would have looked like:

```sh
cw-decode -w 25 -f 12 -e message.txt --web-review recording.wav
cw-decode --live -w 20 -e message.txt --web-review        # after a live take
cw-decode --web-out ~/cw/today.html recording.wav         # keep it somewhere
```

It writes one self-contained HTML file and opens it. Two stacked tracks — **YOU**
over **TGT** — with every mark as a block and every gap labeled in dit units:

```
        ┌ C ─────────┐        ┌ Q ─────────────┐            ┌ D ─────┐
 YOU    ▇▇▇ ▇ ▇▇▇ ▇   ╎ 3.4 ╎  ▇▇▇ ▇▇▇ ▇ ▇▇▇   ╎   9.1   ╎   ▇▇▇ ▇ ▇
                          ~                        **           OK
 TGT    ███ █ ███ █   ╎ 3.0 ╎  ███ ███ █ ███   ╎   7.0   ╎   ███ █ █
```

Blocks are colored green / yellow / red on the same thresholds as the terminal
report. Hover anything for its exact length; click a character to hear just that
character; click the ruler to seek.

**Three views** (the View selector):

| View | Shows |
|------|-------|
| **Per character** | Each character pair starts at the same x, so element *shape* is readable. The **drift strip** underneath plots your running timing error, which this view otherwise hides. |
| **Absolute time** | Both tracks on one clock, so speed drift shears them apart. |
| **Overlay** | The tracks superimposed and translucent — drift read directly rather than inferred. |

**Sliders re-grade instantly.** Character speed, Farnsworth spacing, tolerance,
and the intended message are all re-derived in the browser, so you can ask "was
that actually 22 wpm sending?" without re-running anything. Signal-processing
options (`-t`, `-b`) need a re-run.

**Listening.** Your recording is embedded, and the target is synthesized live at
the tone frequency detected in your audio, so it re-renders as you move the speed
slider. In **largest deviations**, each row's *yours* and *target* figures are
separate play buttons — click back and forth to hear the difference, with the
neighboring characters included since spacing is only audible in context. The
**Listening level** slider boosts playback only; it never alters the files.

**Downloads.** Your audio, the target audio (at the current speed), and a PNG of
the whole chart — not just the visible part.

Other things worth knowing:

- **Opt-in and offline.** Nothing is written without the flag. The page has no
  external references at all, so it works from `file://` forever and can be
  archived or emailed as one file. Size is mostly the embedded audio: about
  4 MB for a 30-second take at 48 kHz.
- **No `-e`?** The target track falls back to your own decode — spacing grading
  still works, character grading doesn't apply.
- **No `-w`?** The target defaults to your own measured speed: "what you sent,
  keyed perfectly."
- The terminal practice report is skipped when a page is requested, since the
  page is the report. The decoded text still prints, and `--json` still works.

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

`load audio → detect tone (FFT) → bandpass + Hilbert envelope → adaptive
threshold → run-length segments → cluster marks (dit/dah) and gaps
(element/char/word) → derive speeds → map through the Morse table`.

Character speed comes from the dit length (`WPM = 1.2 / dit_seconds`). Farnsworth
overall speed is recovered from the stretched inter-character spacing using the
KE3Z timing model, and the same model runs in reverse to build the ideal timing
that `-w`/`-f` grade against.

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

The web-review tests need `node` on `PATH`; they skip cleanly without it. Two
things worth knowing if you touch the review page: `core.build_timeline()` is
the single source of truth for what the sender actually keyed, and
`web/review-core.js` is a deliberate port of that timing logic into JavaScript
so the page can re-grade client-side. `test_js_grading_matches_python` runs both
over the same input and asserts they agree — change one side, change the other.

---

## License

MIT — see [LICENSE](LICENSE).
