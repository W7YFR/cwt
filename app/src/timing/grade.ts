/* Grading the keying against a target.
 *
 * Every verdict here reads `targetKind`/`targetUnits`, never `kind`: what a
 * gap was *meant* to be is what it gets graded as. Blocks still classified as
 * rests carry no target and are counted separately rather than reported as
 * enormous spacing errors.
 */

import type {
  Analysis,
  Block,
  ClassStat,
  Deviation,
  GradedKind,
  Timeline,
  Timing,
} from "@/types";
import { GRADED_KINDS } from "@/types";

/** How many deviation rows the report shows. Worst first, so the cut is at
 *  the bottom — but it is a cut, and the UI says so. */
export const MAX_DEVIATIONS = 12;

/** Absolute floor on flagging a deviation, in units.
 *
 * A deviation has to be both proportionally and absolutely off. Without the
 * absolute floor, a 1-unit element wobbling by 0.3u is "30% out" and drowns
 * the report in noise that nobody can hear. */
export const MIN_DEVIATION_UNITS = 0.4;

export const DEFAULT_TOLERANCE = 0.3;

/** Where a score stops reading as good and starts reading as a problem.
 *
 * Here rather than beside either thing that draws one, because two of them do:
 * the figures under the chart and the per-attempt grades in its gutter. A
 * stack whose rows called 88% amber while the band below called it green would
 * be two opinions about one number.
 *
 * The two scores are not on the same scale and are not held to the same bar.
 * Consistency is a fraction of elements inside the tolerance and 90% of them
 * is keying somebody would be pleased with; accuracy is characters decoded
 * right, where one wrong character in twenty is already a call sign nobody can
 * read. */
export interface ScoreBands {
  readonly good: number;
  readonly ok: number;
}
export const CONSISTENT_BANDS: ScoreBands = { good: 0.9, ok: 0.75 };
export const ACCURATE_BANDS: ScoreBands = { good: 0.95, ok: 0.85 };

export type ScoreBand = "ok" | "warn" | "bad";

export function scoreBand(v: number, b: ScoreBands): ScoreBand {
  return v >= b.good ? "ok" : v >= b.ok ? "warn" : "bad";
}

/** Grade the keying in `timeline` against the ideal `ref` timing.
 *
 * `timeline` must have been built against `ref` — that is what makes its
 * `units` and `targetUnits` comparable — and should already have been through
 * `retarget` if the intended message is known. */
export function grade(
  timeline: Timeline,
  ref: Timing,
  measured: Timing,
  tolerance: number = DEFAULT_TOLERANCE,
): Analysis {
  let nPauses = 0;
  const graded: Block[] = [];
  for (const b of timeline.blocks) {
    if (b.targetKind === "pause") nPauses++;
    if (b.targetUnits > 0) graded.push(b);
  }

  const groups = new Map<string, { vals: number[]; target: number }>();
  for (const b of graded) {
    let g = groups.get(b.targetKind);
    if (!g) {
      g = { vals: [], target: b.targetUnits };
      groups.set(b.targetKind, g);
    }
    g.vals.push(b.units);
  }

  const stats: ClassStat[] = [];
  for (const kind of GRADED_KINDS) {
    const g = groups.get(kind);
    if (!g) continue;
    const n = g.vals.length;
    const mean = g.vals.reduce((a, v) => a + v, 0) / n;
    // Population standard deviation, matching numpy's ddof=0 default. The
    // sample version would read differently for the short classes, and the
    // recorded fixtures are the reference.
    const variance = g.vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
    stats.push({
      name: kind as GradedKind,
      n,
      meanUnits: mean,
      stdUnits: Math.sqrt(variance),
      targetUnits: g.target,
    });
  }

  let within = 0;
  const devs: Deviation[] = [];
  for (const b of graded) {
    const off = Math.abs(b.units - b.targetUnits);
    if (off / b.targetUnits <= tolerance) {
      within++;
    } else if (off >= MIN_DEVIATION_UNITS) {
      devs.push({
        timeSec: b.t0,
        kind: b.targetKind,
        valueUnits: b.units,
        targetUnits: b.targetUnits,
        context: b.context,
      });
    }
  }
  devs.sort(
    (x, y) =>
      Math.abs(y.valueUnits - y.targetUnits) / y.targetUnits -
      Math.abs(x.valueUnits - x.targetUnits) / x.targetUnits,
  );

  return {
    ref,
    measured,
    stats,
    deviations: devs.slice(0, MAX_DEVIATIONS),
    withinTolFrac: graded.length ? within / graded.length : 1,
    tolerance,
    nPauses,
  };
}
