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
