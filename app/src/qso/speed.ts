/* How fast the station sends, and how QRS and QRQ move it.
 *
 * The character speed starts at yours and the effective speed at your
 * effective speed. QRS and QRQ look for the effective speed you can copy by
 * halving: each one goes to the step nearest the middle of what is left.
 *
 * The station remembers, for one QSO, the slowest speed you asked it to slow
 * from (too fast) and the fastest you asked it to speed up from (too slow).
 * The right speed lies between them. QRS from 20, with nothing known below,
 * goes halfway down to the bottom step: 12. QRQ from there goes halfway back
 * up: 15. Each request moves at least one step.
 *
 * The character speed stays put, except that QRQ with the two equal raises
 * both a step. With a number, as in QRS 12, the effective speed goes straight
 * there, and the search starts over.
 */

export interface Speed {
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

/** What one QSO has learned of the speed you can copy. */
export interface Search {
  /** The fastest effective speed you asked to speed up from. */
  readonly tooSlow: number | null;
  /** The slowest effective speed you asked to slow down from. */
  readonly tooFast: number | null;
}

export const NO_SEARCH: Search = { tooSlow: null, tooFast: null };

/** The effective speeds QRS and QRQ land on. */
export const STEPS = [
  6, 7, 8, 9, 10, 12, 14, 15, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40,
] as const;

/** The slowest and fastest speed a number after QRS or QRQ may ask for. */
export const MIN_WPM = 5;
export const MAX_WPM = 50;

export interface Moved {
  readonly speed: Speed;
  readonly search: Search;
}

/** The step strictly between `low` and `high` nearest their middle, or null
 *  when there is none. A tie goes to the lower. */
function middle(low: number, high: number): number | null {
  const mid = (low + high) / 2;
  let best: number | null = null;
  for (const w of STEPS) {
    if (w <= low || w >= high) continue;
    if (best === null || Math.abs(w - mid) < Math.abs(best - mid)) best = w;
  }
  return best;
}

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

/** QRS: halfway down to the fastest speed known too slow, or to the bottom.
 *  With no step left between, one step down, and what was known below is
 *  dropped. */
export function qrs(s: Speed, search: Search): Moved {
  const now = s.farnsworthWpm;
  const floor = search.tooSlow !== null && search.tooSlow < now ? search.tooSlow : STEPS[0] - 1;
  const to = middle(floor, now);
  if (to !== null) return { speed: { ...s, farnsworthWpm: to }, search: { ...search, tooFast: now } };
  return { speed: slower(s), search: { tooSlow: null, tooFast: now } };
}

/** QRQ: halfway up to the slowest speed known too fast, or to the character
 *  speed. With no step left between, one step up, and what was known above
 *  is dropped. At the character speed, both go up a step. */
export function qrq(s: Speed, search: Search): Moved {
  const now = s.farnsworthWpm;
  const known = search.tooFast !== null && search.tooFast > now ? search.tooFast : null;
  const ceiling = Math.min(known ?? Infinity, s.charWpm + 1);
  const to = now < s.charWpm ? (middle(now, ceiling) ?? (known === null ? s.charWpm : null)) : null;
  if (to !== null) return { speed: { ...s, farnsworthWpm: to }, search: { ...search, tooSlow: now } };
  return { speed: faster(s), search: { tooSlow: now, tooFast: null } };
}

/** The effective speed set to `wpm`. Above the character speed, both go
 *  there. */
export function setTo(s: Speed, wpm: number): Speed {
  const w = Math.min(Math.max(Math.round(wpm), MIN_WPM), MAX_WPM);
  return w > s.charWpm ? { charWpm: w, farnsworthWpm: w } : { ...s, farnsworthWpm: w };
}
