/* The next character, large, with a countdown to it.
 *
 * At twenty-five words a minute the chart's captions are small, moving, and
 * exactly where you cannot look — your eyes are on a paddle, not on a row of
 * six-point type sliding leftward. So the one thing you need next is given its
 * own card, in type you can read out of the corner of an eye.
 *
 * It shows the TARGET's next character, never the decode: this is what you are
 * about to send, not what you just sent.
 *
 * Nothing here goes through React state. The countdown moves every frame and
 * the card lights for a tenth of a second; routing that through a re-render
 * would repaint the controls, the chart's props and both report tables ten
 * times a second to change one digit. The elements are written to directly,
 * which is the same reason the chart keeps its playhead out of React.
 *
 * A note on what this trains. The pacing cursor teaches you to KEEP time; a
 * card you react to teaches you to RESPOND to a cue, which is nearer reading
 * than sending — and is why the flash has a lead at all, since reacting has a
 * latency and an internal beat does not. Both stay opt-in for that reason.
 */

import { useEffect, useRef } from "react";
import { FLASH_SEC } from "@/render/geometry";
import type { Beat } from "./pacing";

export type { Beat };

export interface FlashCardProps {
  readonly beats: readonly Beat[];
  /** Light the card on the beat, as well as showing it. */
  readonly cue: boolean;
  /** How far ahead of the beat to light it, seconds. */
  readonly leadSec: number;
  /** The recorder's clock while one is running, or null when nothing is. */
  readonly elapsed: (() => number) | null;
}

/** Shown when there is no character to show: no message, or the last one sent. */
const NOTHING = "·";

export function FlashCard({
  beats,
  cue,
  leadSec,
  elapsed,
}: FlashCardProps): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const letter = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const set = (ch: string, time: string, lit: boolean) => {
      if (letter.current && letter.current.textContent !== ch) {
        letter.current.textContent = ch;
      }
      if (clock.current && clock.current.textContent !== time) {
        clock.current.textContent = time;
      }
      root.current?.classList.toggle("now", lit);
    };

    /* Idle: the first character and a dash, so the card is visibly armed and
       you can see what you are about to be asked for before starting. */
    if (!elapsed) {
      set(beats[0]?.char ?? NOTHING, "—", false);
      return;
    }

    let raf = 0;
    const tick = () => {
      const t = elapsed();
      /* The next character not yet due. It stays on the card through its own
         flash — the lead fires early, and what you are looking at while you
         send is the thing you are sending. */
      let i = 0;
      while (i < beats.length && beats[i]!.at <= t) i++;
      const next = beats[i];

      if (next) {
        const until = next.at - t;
        set(next.char, `${Math.max(until, 0).toFixed(1)}s`, cue && until <= leadSec && until > leadSec - FLASH_SEC);
      } else {
        set(NOTHING, "—", false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      root.current?.classList.remove("now");
    };
  }, [beats, cue, elapsed, leadSec]);

  return (
    /* Stacked, with the countdown under the letter it belongs to. Side by
       side the two competed for the same glance; one above the other, the
       letter is what you see and the number is what you check. */
    <section className="flashcard" ref={root} data-testid="flashcard">
      <span className="fclabel">next</span>
      <div className="fcletter" ref={letter} data-testid="flashcard-letter">
        {beats[0]?.char ?? NOTHING}
      </div>
      <div className="fcclock" ref={clock} data-testid="flashcard-clock">
        —
      </div>
    </section>
  );
}
