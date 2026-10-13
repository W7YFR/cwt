# Roadmap

Future work on CWT. Not in priority order. When an item is done, move it into `CHANGELOG.md` and delete it
here.

Each item has:
- **What:** the problem or the feature, as you'd notice it using the app.
- **How:** what to change, and anything already known about where.
- **Done when:** how to tell it works.

## Bugs

### Space plays the selection when a button has focus
- **What:** tab to a button (or click one, which leaves it focused) and press space. The selected audio plays, and
  the button does nothing. Space should press the focused button, as it does everywhere else.
- **How:** the keyboard transport in `ReviewScreen.tsx` (the `keydown` listener on `document`) skips `INPUT`,
  `SELECT` and `TEXTAREA`, but not `BUTTON`, and it calls `preventDefault()` on space, which also cancels the
  button's own activation. Skip focused buttons too (and anything else that takes space: `role="button"`,
  `role="checkbox"`, links, `contenteditable`), probably with one "does the focused element own this key" check.
  Decide whether the other transport keys (`t`, `n`, `p`, `l`, Escape, Home, End) should stay global while a
  button has focus; they don't clash with a button, so they likely should.
- **Done when:** with a button focused, space presses that button and plays nothing; with nothing focused (or the
  chart focused), space still starts and stops playback.

### Target audio plays during a recording, out of step with the pacing cursor
- **What:** while a recording runs, you can still start the target audio (for example with the hover play buttons
  on a track). It plays over the take, so through a loopback device it is recorded, and through speakers it is
  heard and graded as your sending. It also starts from its own position, not where the pacing cursor is, so it
  doesn't line up with what you are meant to be sending.
- **How:** the rule is already half there: the keyboard transport returns early while `rec.recorder` is set, and
  starting a recording calls `stop` (the `onStart` comment in `ReviewScreen.tsx`). The mouse paths aren't barred:
  `playTrack` (passed as `onPlayTrack` and to `onPlayYou` / `onPlayTarget`), `playDeviation` and the range
  controls can all reach `playTarget` / `playYou` mid-take. Gate playback in one place (`playTarget` / `playYou`,
  or `startTrack` and its callers) on `recording`, and hide or disable the play buttons while recording, as the
  range already is. Hearing the target in step with the cursor while recording could be a later feature (a guide
  tone), but it would have to be kept out of the take; not part of this fix.
- **Done when:** during a recording, no click or key starts any playback, and the play buttons aren't offered;
  after the recording stops, playback works as before.
