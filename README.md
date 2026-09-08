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
| `--live` | Trainer mode: capture from an audio input device (live keying) instead of a file, then decode and grade. |
| `--preview` | With `--live`, also print the decode in **real time** as you key (requires `-w`). |
| `--list-devices` | List available audio input devices and exit. |
| `-D, --device N` | Audio input device index for `--live` (see `--list-devices`). |
| `--duration SEC` | Max live-capture length; also stops early on Enter (default 30, prevents runaway recordings). |
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

---

## License

MIT — see [LICENSE](LICENSE).
