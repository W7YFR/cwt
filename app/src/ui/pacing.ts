/* The schedule a paced recording runs on.
 *
 * One target timeline, read two ways: where the count-in aims, and when the
 * whole thing is over. Both are the same arithmetic — a moment in the target,
 * shifted onto the recorder's clock — and keeping them together is what stops
 * the cursor and the auto-stop drifting into two ideas of when "now" is.
 *
 * Deliberately free of React and of the canvas, so it can be checked against a
 * timeline directly rather than by running a recording.
 */

import type { ReviewSettings, Timeline } from "@/types";
import { blankTake } from "@/io/take";
import { reviewTake } from "@/timing";

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

/** How far past the target's end a recording may run before it stops. */
export const RECORD_OVERRUN_SEC = 30;

/** The longest a recording of the intended message may run, or null when
 *  there is no message to time.
 *
 * The target at the set speeds, with its passes, breaks and delay start, plus
 * `RECORD_OVERRUN_SEC`. */
export function recordLimit(settings: ReviewSettings): number | null {
  const { ideal } = reviewTake(
    blankTake({
      expected: settings.expected || null,
      charWpm: settings.charWpm,
      farnsworthWpm: settings.farnsworthWpm,
    }),
    settings,
  );
  return pacedEnd(ideal, settings.paceLeadSec, RECORD_OVERRUN_SEC);
}
