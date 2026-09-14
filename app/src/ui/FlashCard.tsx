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
import type { Beat, Word } from "./pacing";
import { wordAt } from "./pacing";

export type { Beat, Word };

export interface FlashCardProps {
  readonly beats: readonly Beat[];
  /** Light the card on the beat, as well as showing it. */
  readonly cue: boolean;
  /** How far ahead of the beat to light it, seconds. */
  readonly leadSec: number;
  /** The recorder's clock while one is running, or null when nothing is. */
  readonly elapsed: (() => number) | null;
  /** The target's words, for the preview row. Empty means don't show one. */
  readonly words: readonly Word[];
}

/** Shown when there is no character to show: no message, or the last one sent. */
const NOTHING = "·";

export function FlashCard({
  beats,
  cue,
  leadSec,
  elapsed,
  words,
}: FlashCardProps): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const letter = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /* The preview's own state, kept out of React for the same reason the rest
       of the card is: `done` changes on every beat and the word changes on
       every word, and neither is worth a re-render of the screen behind it.
       Both start impossible so the first frame always paints. */
    let shownWord = -1;
    let shownDone = -1;

    /** Spell a word, green as far as `next`.
     *
     * `next` is the index of the character not yet due, so every letter before
     * it has been sent — which makes the count of green letters and the index
     * of the next one the same number.
     *
     * Which word to spell is a separate question, and `near` answers it: the
     * character nearest in time, which inside a word is the same word either
     * way and at a boundary is the interesting case. Following `next` there
     * would swap in the coming word the instant the last letter of the old one
     * passed — so the last letter of every word would go green in the same
     * frame it disappeared, and you would never see a word complete. Following
     * the nearest instead holds the finished word through the first half of the
     * gap and previews the next through the second half. */
    const spell = (next: number, near: number) => {
      const el = word.current;
      if (!el) return;
      const wi = wordAt(words, near);
      if (wi !== shownWord) {
        shownWord = wi;
        shownDone = -1;
        el.textContent = "";
        for (const ch of words[wi]?.chars ?? []) {
          const span = document.createElement("span");
          span.textContent = ch;
          el.append(span);
        }
      }
      const w = words[wi];
      const done = w ? Math.min(Math.max(next - w.from, 0), w.chars.length) : 0;
      if (done !== shownDone) {
        shownDone = done;
        const kids = el.children;
        for (let k = 0; k < kids.length; k++) {
          kids[k]!.classList.toggle("done", k < done);
        }
      }
    };

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
      spell(0, 0);
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
      /* Nearer the character just sent than the one coming? Then that is
         where you are. Only the boundary between two words can be affected. */
      const prev = beats[i - 1];
      const near = prev && next && t - prev.at < next.at - t ? i - 1 : i;
      spell(i, near);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      root.current?.classList.remove("now");
    };
  }, [beats, cue, elapsed, leadSec, words]);

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
      {/* Under the timing, and only when there is a word to show. The card
          says what is next; this says where next SITS — which letter of which
          word, and so how near the end of it you are. A card alone cannot say
          that, and the spacing decision at a word boundary is the operator's.

          Deliberately childless here: the effect owns what is inside it, and
          giving React children of its own to reconcile against spans it did
          not create is how stale letters would survive a re-render. */}
      {words.length > 0 && (
        <div className="fcword" ref={word} data-testid="flashcard-word" />
      )}
    </section>
  );
}
