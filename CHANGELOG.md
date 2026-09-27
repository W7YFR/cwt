# Changelog

What each release of cwt changes for the people who use it, newest first. A
change that ships nothing to the site has no entry.

## Unreleased

## v1.3.0 — 2026-09-27

### Added

- Custom drills. Write and save your own in Configuration › Drills. They show under **Custom** in the drill picker and take the same slots, such as `{callsign}`.
- Breaks. A line break in a drill or message is a long pause, so one drill can hold both sides of a QSO. The pause is never graded.
- A **Timing** row in the cog panel: Delay start, Break length (default 3 s) and Repeat pause (default 0 s).

### Changed

- Delay start moved from Practice aids to the Timing row.

## v1.2.0 — 2026-09-27

### Added

- **Fit WPM** sets both target speeds to the selected run's measured speeds.
- **Ignore character construction** grades only the gaps between characters and words.
- The grade strip shows one verdict for each character and one for the gap before it. It also shows in the absolute time view.
- An alphanumeric warm-up drill: each letter and number sent three times.
- Downloads name the run and both target speeds, for example `microphone-run2-25wpm-10farns-yours.wav`.
- The header stays pinned to the top of the page.

### Changed

- Every run shows its number and a delete button. Deleting the only run leaves an empty session.
- Opening the settings from down the page scrolls up to them. Closing them scrolls back.

### Fixed

- The measured character speed read high: a keyer at 25 WPM read 27. Character and Farnsworth speeds now read true.
- Advanced no longer covers Calibrate. A long microphone name no longer runs off the page.

## v1.1.1 — 2026-09-26

### Fixed

- A prosign caption at the end of a message, such as `<SK>`, is no longer cut off.
- An unknown pattern decodes as `▯`, not `?`, so it never grades as a correct question mark.
- Speeds are saved, and the practice page and calibration share them. A deploy no longer resets your settings.

## v1.1.0 — 2026-09-26

### Added

- Drills. A **Drill** picker in New session and in the review. The catalog has Daily Sending (Warm Up, Exercise, Drill) and QSO (CQ, Name & QTH, Exchange), from the CW Academy Fundamental curriculum.
- User details in Configuration: name, callsign, QTH, rig and more. Drills fill slots such as `{callsign}` from them.
- **Advanced** beside the cog opens Configuration.
- The prosign `<DN>`.

### Fixed

- The prosign drill sends each run of five as one word.
- The calibration picker sits in the button row.

## v1.0.2 — 2026-09-20

### Added

- `?micdebug` in the URL shows the microphone state on screen.

### Changed

- Buttons use SVG icons in place of Unicode glyphs.

### Fixed

- Microphone access on iOS Safari. The access step clears after a grant.
- Each screen opens at the top.
- The landing callsign no longer overlaps the wordmark on narrow screens.

## v1.0.1 — 2026-09-20

### Added

- **Grant Mic Access** on the landing screen when the browser has not granted the microphone. A denied microphone shows a warning.
- A touch drag pans the chart. Page scroll and pinch zoom work over it.
- A new "CW" icon. The footer version links to the repository.

### Fixed

- Below 700px the review header wraps instead of squeezing.
- A take opened from a file shows Calibrate beside the device picker.
- The record button no longer flashes live before the device list loads.

## v1.0.0 — 2026-09-19

The first release. Key into a microphone or a loopback device, and cwt measures every dit, dah and gap against a perfect sender at the same speed.

### Added

- Recording, decoding and grading in the browser. Audio never leaves the machine.
- A chart of your sending against the target, in per-character, absolute-time and overlay views, with a drift strip. Click a character to hear it.
- Sessions. Attempts stack against one target. **Show** and **Sort** pick which runs the chart draws.
- Consistent and Accurate scores, a deviations table and a JSON report.
- Practice aids: pacing cursor, flash card and zen mode. **Times** repeats the message within one take.
- Farnsworth timing, from the KE3Z model.
- Calibration, which removes the delay a room adds to every key release.
- Open WAV, MP3, M4A, FLAC or OGG files, or drop them on the page.
- The session and the last ten recordings survive a reload.
