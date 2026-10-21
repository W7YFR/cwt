# Changelog

What each release of cwt changes, newest first. The Development group lists
changes to the build, CI and tooling. Unreleased lists changes merged to main
that no tagged version holds yet. These are Development changes, which ship
nothing to the site. The next release carries them.

## Unreleased

### Added

- On the **QSO** page, **Enter copy as** sets a box per line or a slot per character for the station's lines, while **Its lines show** is **Copy**.

### Changed

- The **QSO** page shows its state in a word over the log, as the **Copy** page does, with what to do next beside it.
- The guide on the **Copy** page, before you open a recording, is shorter and plainer.

## v1.15.0 — 2026-10-21

### Added

- The **Copy** page plays a recording of CW for you to copy. Open or drop a file, and each over shows as a line, with a box to type in, as it plays.
- A line locks when the next line starts, or on Enter, and shows what you got right. **Show answers** shows what was sent under each line.
- **Copy again** plays the whole recording once more as a new attempt. Each attempt stays, and **When I copy again, show** sets which earlier attempts show over each line.
- Buttons skip back or on by a line, 15 s, 5 s or a word. Click a word of the answer, or select part of it, to hear it again.
- Space plays or pauses, and the arrow keys skip a word. In a box, Enter locks the line and Esc leaves the box.
- **Copy in** sets a box per line or a slot per character. **Its lines show** can show each line as sent or whole, to listen along.
- With **Hide each call until I copy it**, a station shows as Station 1 or Station 2 until you copy its call.
- The recording and your attempts stay in the browser across a reload.

### Changed

- The **Practice** page is now **Send**. The pages are **Send**, **Copy** and **QSO**.

### Fixed

- On the **QSO** page, a graded copy no longer shows a gap in the station's line where you typed a space it did not send.

## v1.14.0 — 2026-10-20

### Changed

- With **Times** above 1, a break separates the passes, as a line break does in the message. The gap between passes is not graded, and the target holds it for **Rest at each break**.

### Removed

- The **Pause between repeats** setting.

## v1.13.1 — 2026-10-19

### Fixed

- After an update, a reload no longer hangs on "looking for your last session…" while CWT is open in another tab. The page asks you to close that tab, then opens.

## v1.13.0 — 2026-10-19

### Added

- On the **QSO** page, each line has a play button to hear it again while the microphone is off.
- A QSO that is over has **Play QSO**, which plays both sides with the long pauses cut, and **Download**, which saves it as a WAV file.
- **Play buttons** in the **QSO** settings, under **After a QSO**, sets when the play buttons show: **Never**, **Always** or **At end**. **Show Download** shows or hides **Download**.

### Changed

- On the **QSO** page, the session stops when a QSO ends. **Start** begins the next one.
- The **QSO** page's settings are grouped by subject, **The other station**, **You** and **After a QSO**. Each setting says what it does, such as **How much it sends** for Length, and a line under each choice explains the option chosen.
- The **Practice** page's settings take the same form: **While I record**, **The message**, **Grading**, **The chart** and **On the page**, each setting named for what it does, such as **Shrink long pauses** for Collapse rests. **Listening level** is now **Playback volume** on both pages.
- In the settings, each setting's explanation shows from a **?** at the end of its row, not as a tooltip over the whole setting.

## v1.12.0 — 2026-10-19

### Changed

- On the **QSO** page, the station opens a line with both calls now and then by its own habit, and more often when you do. It no longer sends them at the start of nearly every line.

### Fixed

- With **Lock when I send**, your copy locks at your first character, not a few characters later.
- A sound from the microphone as it opens no longer reads as keying. In **Zen** mode, no dots show before you start.

## v1.11.0 — 2026-10-19

### Added

- **Restart** beside **Continue** on the **QSO** page clears the log and starts a new QSO with a new station.
- **Replay on Continue** in the **QSO** settings sets whether **Continue** sends the station's last line again. It is on by default.

### Fixed

- On the **QSO** page, AGN or QRS after the station answers a question gets that answer again, not the line before it.
- An item of the station's exchange sent back with a `?`, such as `SALEM OR ?`, gets it confirmed, and the station waits for you to go on. It no longer sends its last line again.
- A question sent with more of your exchange gets its answer, and the station goes on in the same line. It no longer waits, or sends again a piece it gave as an answer.
- When the station answers a question and still waits for a piece of your exchange, it asks for that piece in the same line.
- Noise on the microphone input no longer reads as keying, on either page, or locks your **QSO** copy before you finish.

## v1.10.2 — 2026-10-19

### Development

- The QSO tests run on a fake clock, in seconds, in the dom tier. One QSO still runs in real audio in the browser tier.

## v1.10.1 — 2026-10-18

### Development

- The QSO browser tests are in five files, which run side by side.
- The QSO browser tests send their exchange without calls, so a misread call no longer fails them.
- CI runs the browser tests in their own `browser` job, beside `test`.
- The mic debug transcript also logs the audio track's settings, skipped audio, clicks, the level, each **QSO** over and the live copy's passes. It and the last two minutes of over audio are always kept in memory, and `__cwtMicDebug(true)` in the console, or `?micdebug`, prints them and shows **Save log** and **Save audio** on the **QSO** page.

## v1.10.0 — 2026-10-18

### Added

- Paste a QSO with notes such as `(your call)` or `(your QTH)` into a drill, and each note goes in as its slot. In **Intended message** and **New session**, it goes in as your value from **User**.
- A warning names a note whose value is not set, with a link to **User**. In **Intended message**, the note fills in once the value is set.

### Changed

- A banner at the top of the page lines up with the header.

### Fixed

- A message pasted into **Intended message** keeps its line breaks as breaks.

### Development

- Claude runs `make pr` when the contributor asks for it in that message.

## v1.9.0 — 2026-10-18

### Added

- A **QSO** page, opened from the **Practice** and **QSO** switch in the header. Call CQ, and a made-up station answers in CW and works you through report, name and QTH to 73, with an example QSO to show what to send.
- The station words its replies differently each time, and goes on only once you have sent back each part. It asks again when it cannot copy you, answers NAME?, QTH?, RST? or part of its call with a ?, and takes a correction after the error sign.
- QRS makes the station send its last line again, slower, and QRQ makes it send faster. QRS 12 or QRQ 20 asks for that speed.
- **Station text** in the **QSO** page's settings sets what shows of the station's lines: **Whole**, **As sent**, **Blurred**, **Copy** or **Off**. **Blur call with copy** blurs the station's call while its text is not shown.
- With **Copy**, you type what you hear, and your copy is graded against the station's line, character by character. **Once locked, show** sets what shows of it before the QSO ends.
- The **QSO** page's settings set **Length** (**Mixed** varies it), **Copy** (**Lenient** or **Strict**), **Your text**, and **Speed** for each side, which shows the speed each line was sent at. The speed sliders and the **Audio** settings, **Calibration** among them, are the practice page's, and either page sets them for both.
- The station's call stays out of the log's labels until you have copied it.
- A reload keeps the **QSO** page's log. **Pause** (Enter) stops listening, and **Continue** (R or Enter) goes on with the QSO, with the station's last line played again.

### Changed

- **Follow**, **Live grading** and **Live progress** read your sending through the **Calibration** you choose, as the review does afterwards.

## v1.8.1 — 2026-10-15

### Changed

- Hovering a track's name on the chart shows its play button, for any track, and the button lights under the pointer. Only the button plays, and on another run it picks that run up and plays it in one click.
- While a take records, the controls, scores, tables, settings and header buttons are locked. **Stop and review**, **Restart** and **Cancel** stay.
- The characters on the chart are labeled in larger, white text in every view.

### Fixed

- With a button focused, space presses the button instead of playing the selection.
- Play buttons no longer play audio over a take that is recording.
- Dropping a run while audio plays no longer leaves the audio and the cursor running on the next run.
- While pacing, a rest in the message sits right after the text before it, and the cursor slows through it instead of jumping past an empty stretch.

## v1.8.0 — 2026-10-14

### Changed

- The start screen leads with **Start practicing**, and Enter presses it, with the microphone, its calibration and **or open a recording** under it. Recording and the intended message are on the practice screen only.
- A returning visit skips the start screen and opens on the practice screen.
- Before the browser allows the microphone, the record button reads **Allow microphone**.
- The calibration setup sits on a card, with left-aligned text. **Keyer speed** and **Microphone** sit side by side, and the microphone is named even when there is only one.
- The calibration result sits on a card too. A failed one says **Let’s try that again…**, and **Your setup** names the speed it judges, such as **At 25 wpm**.
- A successful calibration says **Success!**, and a short tail is rated **Excellent**.
- When the calibration drills disagree but the setup is fine, the result says so and asks only for a new recording.
- A calibration result with nothing to save no longer shows the **With this calibration** chart.
- A user icon beside the settings cog opens **Configuration**, in place of the **Advanced** button. It shows whether the settings are open or not.
- **Configuration** sits on a card like the calibration screens, with **Done** at the bottom. A switch shows one part at a time: **User**, **Drills** or **Calibration**.
- **Need help?** explains how to get your keying into CWT in shorter, plainer words.
- On the practice screen, the header, the chart settings, the speeds and message, and the scores sit on panels like the rest of the app.
- Under **Calibration recordings**, a recording saved as a calibration shows that calibration's name, and **Save** puts the name at the front of the file.

### Fixed

- The list of calibration prompts no longer runs into its border.
- Opening the settings no longer shifts the page sideways when a scrollbar appears.
- A successful calibration's explanation no longer contradicts the correction it found.
- Clicking the charts on a calibration result plays the target or your recording. The note under a single chart no longer says **Both**.
- A calibration result has a play button for every drill, named, rather than **Other keying**. A drill with nothing in it is grayed out, and its tooltip says it was not captured.

### Development

- On the dev server, `?calexample` lists one real calibration for each result, and `?calexample=success`, `clean`, `noisy` or `failed` opens one. Builds leave it out.
- Raise `LANDING_VERSION` in `app/src/ui/Landing.tsx` to show the start screen once more to returning visitors.

## v1.7.0 — 2026-10-14

### Added

- **Plain**, **Paced** and **Zen**, beside the record button, pick how the next take records. They replace the **Zen mode** and **Pacing cursor** checkboxes.
- In **Plain** mode, the take stops itself a second or so after the last character, and a message wider than the chart slides the next word into view as you begin a word's last letter. **Follow**, under **Recording modes** › **Plain**, turns both off.
- **Live grading**, under **Recording modes** › **Plain**, puts a dot under each target character on the chart as you key it. The dot turns blue if you sent the character right and red if not.

### Changed

- **Settings** groups its settings in sections: **Audio**, **Target**, **Grading**, **Chart** and **Page**, and **Plain**, **Zen** and **Pacing** under **Recording modes**.
- A setting that another setting rules out stays in place, dimmed, and its tooltip says why.
- **Microphone**, **Calibration**, **Listening level** and **Loop** are in **Audio**, under **Settings**.
- **Ignore character construction** is now **Spacing only**, and **Clock axis while pacing** is now **Clock axis**.
- The track that plays always shows its stop button on the chart.
- A first visit starts at 25 wpm, with a **Repeat pause** of 5 s, and with **Spacing only**, Zen's **Live progress** and Plain's **Live grading** on.

### Removed

- The **Your sending** and **Target** buttons, the stop button above the chart and the playback clock. Play and stop a track from the chart, or press space or T.
- The flash card and **Word preview**.

### Fixed

- A reload on the practice screen stays there, even before anything is recorded.
- A reload keeps the chart's zoom.
- A reload keeps **Settings** open if it was open.

## v1.6.0 — 2026-10-13

### Added

- **Live progress**, under **Zen mode**, turns each character of the message blue as you start to key it. The take stops itself a second or so after the last character.
- **Live grading**, under **Live progress**, puts a dot under each character, in place of the blue letters. The dot turns blue if you sent the character right and red if it was wrong or left out.

### Changed

- **Zen mode** stays on when you reload the page or come back later.

### Development

- `source-map-js` is updated to 1.2.2.

## v1.5.0 — 2026-09-29

### Added

- Drag along the ruler to pick a range of the target's characters to play. The range stays on those characters when you pick another run or the target.
- With a range picked, **Your sending**, **Target**, space and a click inside the range play only the range.
- Esc stops playback. With nothing playing, Esc clears the range.
- **Loop**, or L, replays the range or the whole track each time it reaches its end.
- N and P pick and play the next and previous track, in the order the rows are drawn. P on the first run plays the target, and N on the target plays the selected run.
- The name of the track in hand, at the left of the chart, shows a play button while the pointer is over it. It shows a stop button while that track plays.

### Fixed

- A click on the ruler while the target plays now plays the target from that point. It no longer restarts the target.

## v1.4.0 — 2026-09-28

### Added

- Daily Sending › Warm Up ends with a drill of the first four warm-ups, with a break between each. Daily Sending › Exercise ends with all four exercises the same way.
- **Edit** on a custom drill in Configuration › Drills loads it into the text box. **Save changes** updates the drill in its place in the list.
- An **Insert slot** menu adds a slot, such as `{rig_model}`, at the cursor in a custom drill. An **Insert** menu in **New session** adds a value from User, such as your callsign.

### Changed

- **New session** opens with **Times** at 1.

### Fixed

- A recording no longer cuts off at five minutes while the message is still being sent. It finishes itself 30 s after the target's end.
- A correctly sent character shows as the intended text spells it, in a run's caption and in **Decoded**. For example, a keyed `<DN>` shows as `<DN>`, not `/`. The built-in drills write `/` in place of `<DN>`.
- The target row shows no caption over an extra character. It no longer shows a dot there.

### Development

- `CHANGELOG.md` holds one entry per release. A branch writes its entry under Unreleased, and `make bump` moves it under the new version. CI fails a release with no entry.
- `make pr` bumps the version, pushes the branch, and opens or updates its pull request. The body is the branch's changelog entry.
- `make release` uses the entry as the tag message and the GitHub release notes. It stops unless the branch's pull request is merged.
- `CLAUDE.md` describes the contributor workflow and the changelog rules. `/changelog-check` checks a branch's entry against its diff.
- Claude suggests a one-line commit message for each staged part.

## v1.3.0 — 2026-09-27

### Added

- Custom drills. Write and save your own in Configuration › Drills. They show under **Custom** in the drill picker and take the same slots, such as `{callsign}`.
- Breaks. A line break in a drill or message is a long pause, so one drill can hold both sides of a QSO. The pause is never graded.
- A **Timing** row in the cog panel: Delay start, Break length (default 3 s) and Repeat pause (default 0 s).

### Changed

- Delay start moved from Practice aids to the Timing row.

### Development

- CI fails, in place of skipping the deploy, when the commit a push to main started from is missing from the clone.

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

### Development

- `make release` updates main, tags and pushes the version, and offers to delete the merged branch.
- A change that touches no build input needs no version bump and deploys nothing.

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

### Development

- `make dev-device` serves the dev server over HTTPS on the LAN, so a phone can use the microphone. `make uninstall:cert` removes the certificate.
- The dev server serves only `app/`, `node_modules/` and `package.json`. Before, any device on the LAN could fetch any file in the repository.

## v1.0.1 — 2026-09-20

### Added

- **Grant Mic Access** on the landing screen when the browser has not granted the microphone. A denied microphone shows a warning.
- A touch drag pans the chart. Page scroll and pinch zoom work over it.
- A new "CW" icon. The footer version links to the repository.

### Fixed

- Below 700px the review header wraps instead of squeezing.
- A take opened from a file shows Calibrate beside the device picker.
- The record button no longer flashes live before the device list loads.

### Development

- `make icons` builds the `.ico` and PNG icons from `app/public/favicon.svg`.
- Node 24.

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

### Development

- CI tests every pull request and deploys every merge to main that changes a build input.
- `make bump` sets the version from the branch prefix: `feat/` is a minor, `fix/` and `chore/` are patches.
