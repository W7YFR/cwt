/* What the app is listening through, and why it matters more than it sounds.
 *
 * Every number this tool reports is a length of time, and the thing being
 * measured is mostly silence: the gap inside a character, the gap between two
 * of them, the gap between words. Anything in the path that makes a note keep
 * sounding after the key comes up spends that silence, and the app reads the
 * mark as longer than it was sent.
 *
 * Reference reading in the middle of a decision, so it opens over the screen
 * and gives it back — going somewhere else would throw away the message typed
 * and the input picked.
 *
 * What it says was measured before it was written — docs/microphone-work.md
 * has the recordings and the method — but the numbers stay there. Somebody
 * asking this question wants to know what to plug in and where to put it, and
 * a decay figure from one afternoon's test setup is not an answer to that.
 *
 * Nothing here claims to know which path a reader is on. That is exactly what
 * the app cannot see, which is why all of it is written conditionally.
 */

import { useEffect, useRef } from "react";

export function SoundPathHelp({ onClose }: { onClose(): void }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);

  /* Focus lands on the dialog itself. There is nothing to fill in here — it is
     a page to read — and Escape only reaches a handler on it if focus is
     inside it. */
  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog soundpath"
        role="dialog"
        aria-modal="true"
        aria-labelledby="soundpath-title"
        data-testid="sound-path"
        tabIndex={-1}
        ref={box}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2 id="soundpath-title">Getting the signal in</h2>

        {/* The scrolling part. The title and the way out are outside it, so
            neither can be read off the bottom of a short window. */}
        <div className="prose">
          <p>
            What this tool grades is mostly silence — the gap inside a character,
            the gap between two of them, the gap between words. Anything that
            keeps a note sounding after the key comes up spends that silence, and
            the mark reads longer than you sent it.
          </p>

          <h3>Plug in if you can</h3>
          <p>
            Line out from the radio, a soundcard interface, or a virtual audio
            device carrying the sidetone straight into the browser. The sound
            never becomes air, so nothing gets added to it on the way and the app
            reads what you keyed. There is nothing here to calibrate.
          </p>

          <h3>A microphone hears the room too</h3>
          <p>
            Point one at a speaker and it picks up the sound twice: once
            directly, then again off the walls a moment later. Those reflections
            arrive after the key is already up, so every mark trails off into the
            gap behind it. Distance is what governs how much — the closer the
            microphone, the less room there is in what it hears.
          </p>
          <p>
            Calibration can measure that trail and take it back off your timing.
            What it cannot undo is anything that changes from one mark to the
            next — a level that moves on its own, or sending fast enough that the
            trail covers a whole dit.
          </p>

          <h3>If you are on a microphone</h3>
          <ul>
            <li>Move it close, and point it at the speaker.</li>
            <li>Turn off any automatic level or enhancement.</li>
            <li>Start slower than you think you need to.</li>
            <li>
              Then calibrate, and read the verdict beside it. A calibration
              belongs to a microphone <i>in a position</i> — move it and it is no
              longer describing your setup.
            </li>
          </ul>
        </div>

        <div className="confirm">
          <button className="primary" data-testid="sound-path-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
