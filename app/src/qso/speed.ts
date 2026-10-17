/* How fast the station sends, and how QRS and QRQ move it.
 *
 * The character speed starts at yours and the effective speed at your
 * effective speed. QRS and QRQ move the effective speed one step along
 * `STEPS`. The character speed stays put, except that QRQ with the two equal
 * raises both. With a number, as in QRS 12, the effective speed goes straight
 * there.
 */

export interface Speed {
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

/** The effective speeds QRS and QRQ step through. */
export const STEPS = [
  6, 7, 8, 9, 10, 12, 14, 15, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40,
] as const;

/** The slowest and fastest speed a number after QRS or QRQ may ask for. */
export const MIN_WPM = 5;
export const MAX_WPM = 50;

/** One step slower. The character speed stays. At the bottom step, no
 *  change. */
export function slower(s: Speed): Speed {
  const below = [...STEPS].reverse().find((w) => w < s.farnsworthWpm);
  return below === undefined ? s : { ...s, farnsworthWpm: below };
}

/** One step faster. The effective speed stops at the character speed. When
 *  it is already there, both go up a step. At the top step, no change. */
export function faster(s: Speed): Speed {
  if (s.farnsworthWpm < s.charWpm) {
    const above = STEPS.find((w) => w > s.farnsworthWpm) ?? s.charWpm;
    return { ...s, farnsworthWpm: Math.min(above, s.charWpm) };
  }
  const above = STEPS.find((w) => w > s.charWpm);
  return above === undefined ? s : { charWpm: above, farnsworthWpm: above };
}

/** The effective speed set to `wpm`. Above the character speed, both go
 *  there. */
export function setTo(s: Speed, wpm: number): Speed {
  const w = Math.min(Math.max(Math.round(wpm), MIN_WPM), MAX_WPM);
  return w > s.charWpm ? { charWpm: w, farnsworthWpm: w } : { ...s, farnsworthWpm: w };
}
