/* The schedule a paced recording runs on.
 *
 * One target timeline, read three ways: where the count-in aims, when each
 * character is due, and when the whole thing is over. All three are the same
 * arithmetic — a moment in the target, shifted onto the recorder's clock — and
 * keeping them together is what stops the cursor, the flash card and the
 * auto-stop drifting into three slightly different ideas of when "now" is.
 *
 * Deliberately free of React and of the canvas, so it can be checked against a
 * timeline directly rather than by running a recording.
 */

import type { Timeline } from "@/types";
import { opensWord } from "@/timing/timeline";

/** One character, and the moment on the recorder's clock it should be sent. */
export interface Beat {
  readonly char: string;
  readonly at: number;
}

/** Where the count-in aims: the start of the target's first character.
 *
 * Its lead gap when it has one, because that is where the target's own axis
 * begins and where the cursor has to enter from. Zero for an empty message,
 * which makes every derived time zero too — there is nothing to pace. */
export function pacedStart(ideal: Timeline): number {
  const first = ideal.chars[0];
  if (!first) return 0;
  return first.leadGap ? first.leadGap.t0 : first.t0;
}

/** When each character is due, on the recorder's clock.
 *
 * The cursor reaches the first character exactly as the count-in runs out, so
 * every later one is that moment plus however far into the target it falls. */
export function beatsFor(ideal: Timeline, leadSec: number): Beat[] {
  const from = pacedStart(ideal);
  return ideal.chars.map((c) => ({ char: c.char, at: leadSec + (c.t0 - from) }));
}

/** When a paced recording should stop itself, or null if there is nothing to
 *  pace.
 *
 * Measured from the end of the last ELEMENT, not from the last character's
 * start — a take that cut off halfway through its final dah would be missing
 * the one thing it was recorded to measure. */
export function pacedEnd(
  ideal: Timeline,
  leadSec: number,
  afterSec: number,
): number | null {
  const last = ideal.chars[ideal.chars.length - 1];
  if (!last) return null;
  return leadSec + (last.t1 - pacedStart(ideal)) + afterSec;
}

/** One word of the target, as a span of beats.
 *
 * Indices rather than times, because the card already knows which beat is next
 * and asking "which word is that in" is the whole question. `beatsFor` maps
 * `ideal.chars` one to one and in order, so a beat index is a character index
 * and the two can be lined up without searching. */
export interface Word {
  /** Index of this word's first beat. */
  readonly from: number;
  /** One past the last, so `to - from` is its length. */
  readonly to: number;
  readonly chars: readonly string[];
}

/** The target split into words, in order.
 *
 * A word break is a word gap or a pause in front of a character — the same
 * rule the chart highlights by. The first character always opens one, having
 * nothing in front of it to be separated from. */
export function wordsFor(ideal: Timeline): Word[] {
  const out: Word[] = [];
  ideal.chars.forEach((c, i) => {
    const last = out[out.length - 1];
    if (!last || opensWord(c)) {
      out.push({ from: i, to: i + 1, chars: [c.char] });
    } else {
      out[out.length - 1] = {
        from: last.from,
        to: i + 1,
        chars: [...last.chars, c.char],
      };
    }
  });
  return out;
}

/** Which word a beat belongs to, or -1.
 *
 * Past the end returns the last word rather than -1: when every character has
 * been sent the word you were on is still the word you were on, and blanking
 * the preview at the final letter would take it away exactly as it completes. */
export function wordAt(words: readonly Word[], beat: number): number {
  if (words.length === 0) return -1;
  if (beat < 0) return -1;
  const i = words.findIndex((w) => beat < w.to);
  return i === -1 ? words.length - 1 : i;
}
