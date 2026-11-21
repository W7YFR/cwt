/* When the next station calls in a run, after your TU.
 *
 * On the air, a run's next caller often comes in right behind your TU, and
 * now and then only after a pause while stations tune in. When the band is
 * slow, nobody calls, and you call CQ again.
 */

import type { Rand } from "./station";

/** Immediate: always a few seconds. Varied: a wait that changes from one
 *  station to the next. Uncertain: varied, and now and then nobody. */
export type NextCaller = "immediate" | "varied" | "uncertain";

/** Immediate: the next station calls this many seconds after, at least and
 *  at most. */
export const IMMEDIATE_SEC = [2, 4] as const;

/** Varied: most callers come in quick, right behind your TU. */
export const QUICK_SEC = [0.5, 3] as const;

/** Varied: the rest come in after a pause. */
export const SLOW_SEC = [3, 6] as const;

/** Varied: how often the next caller comes after a pause. */
export const SLOW_SHARE = 0.3;

/** Uncertain: how often nobody calls. */
export const NOBODY_SHARE = 0.2;

/** The wait before the next station calls. With nobody to call, the wait
 *  before the page says so: as long as the longest pause. */
export interface NextCall {
  readonly sec: number;
  readonly calls: boolean;
}

function within([lo, hi]: readonly [number, number], rand: Rand): number {
  return lo + rand() * (hi - lo);
}

/** When the next station calls, and whether one does, for `when`. */
export function whenNext(when: NextCaller, rand: Rand): NextCall {
  if (when === "immediate") return { sec: within(IMMEDIATE_SEC, rand), calls: true };
  if (when === "uncertain" && rand() < NOBODY_SHARE) return { sec: SLOW_SEC[1], calls: false };
  return { sec: within(rand() < SLOW_SHARE ? SLOW_SEC : QUICK_SEC, rand), calls: true };
}
