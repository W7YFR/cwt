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
import { AppName } from "./Wordmark";

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
        <h2 id="soundpath-title">Getting your keying into <AppName /></h2>

        {/* The scrolling part. The title and the way out are outside it, so
            neither can be read off the bottom of a short window. */}
        <div className="prose">
          <p>
            <AppName /> times every dit, dah and gap you send. If the sound keeps ringing
            after you let go of the key, it eats into the gap that follows, and
            your timing looks worse than it is.
          </p>

          <h3>Best: a direct connection</h3>
          <p>
            Connect your keyer&rsquo;s sidetone straight to your computer: a
            cable from your radio&rsquo;s line out, an audio interface, or a
            virtual audio device. <AppName /> then hears exactly what you sent, and you
            do not need to calibrate.
          </p>

          <h3>Using a microphone</h3>
          <p>
            A microphone also hears the sound bounce off the walls. That makes
            every dit and dah ring on a little after you let go. The closer the
            microphone is to the speaker, the less of this it hears.
          </p>
          <p>
            Calibration measures the ring and corrects for it. It cannot fix a
            ring so long that it runs into the next dit, or a level that keeps
            changing.
          </p>

          <h3>Tips</h3>
          <ul>
            <li>Put the microphone close to the speaker, pointing at it.</li>
            <li>Turn off automatic level control and any sound enhancement.</li>
            <li>Start at a slower speed than you normally send.</li>
            <li>
              Calibrate again whenever you move the microphone. A calibration
              only fits the spot where you made it.
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
