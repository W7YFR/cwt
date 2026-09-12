/* The timing model: PARIS plus KE3Z Farnsworth.
 *
 * One dit is the unit everything else is measured in. At `charWpm` the word
 * PARIS takes 50 units, which fixes the unit at 1.2/wpm seconds.
 *
 * Farnsworth sends the characters at one speed and pads the spacing so the
 * *overall* rate is lower — the standard way to practice, because it keeps the
 * character sounds at their real shape while giving you time to write. The
 * KE3Z model distributes the extra delay over PARIS's 19 spacing units:
 *
 *     Ta = 60/S - 37.2/C     seconds of spacing per word
 *
 * where C is character speed and S is overall speed. When S = C it degenerates
 * to exactly one unit and the whole thing collapses back to standard timing.
 */

import type { Timing } from "@/types";

/** Spacing units in PARIS: 19 of the 50 are silence between elements. */
const SPACING_UNITS = 19;
/** Seconds of *element* time in one PARIS word at 1 wpm: 31 units x 1.2. */
const ELEMENT_SEC_PER_WPM = 37.2;

/** The ideal timing for a target character and overall speed.
 *
 * The thresholds and nominal gap lengths this produces are exactly what a
 * machine sender would key, which is what makes it usable both as the target
 * to grade against and as the score for the synthesized target audio. */
export function targetTiming(
  charWpm: number,
  farnsworthWpm?: number | null,
): Timing {
  const cw = charWpm;
  const fw = Math.min(farnsworthWpm ?? cw, cw);

  const unit = 1.2 / cw;
  const ta = 60 / fw - ELEMENT_SEC_PER_WPM / cw;
  // Never let Farnsworth compress below standard spacing: an overall speed
  // above the character speed is not a thing, and clamping here means every
  // downstream ratio stays sane instead of going negative.
  const fwUnit = Math.max(ta / SPACING_UNITS, unit);

  return {
    unitSec: unit,
    charWpm: cw,
    farnsworthWpm: fw,
    ditDahSplit: 2 * unit,
    elementCharSplit: 2 * unit,
    charWordSplit: 5 * fwUnit,
    charGapSec: 3 * fwUnit,
    wordGapSec: 7 * fwUnit,
    notes: [],
  };
}

/** Overall (Farnsworth) speed implied by a measured character gap.
 *
 * The inverse of the model above: given the character speed and how long the
 * sender actually left between characters, what overall rate is that? */
export function farnsworthFromCharGap(
  charWpm: number,
  charGapSec: number,
): number {
  const ta = (SPACING_UNITS * charGapSec) / 3;
  const denom = ta + ELEMENT_SEC_PER_WPM / charWpm;
  if (!(denom > 0)) return charWpm;
  return Math.min(60 / denom, charWpm);
}
