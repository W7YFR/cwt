/* audio -> segments, the whole of it.
 *
 * One entry point, `segmentsFrom`, and everything it calls is a pure function
 * over a Float32Array. The Web Audio dependency lives one module over in
 * decode-audio.ts and is not imported here, which is what lets the Python
 * oracle test run this exact code path under Node.
 */

import type { Segment } from "@/types";
import { envelope, DEFAULT_BANDWIDTH } from "./envelope";
import { thresholdCurve } from "./level";
import { fillRippleGaps } from "./ripple";
import { correctionWeight, edgeTransitionSec, refineEdges } from "./edges";
import { localPeak, LEVEL_WINDOW_SEC } from "./level";
import { keyingThreshold } from "./threshold";
import { detectTone } from "./tone";
import { runLengths, debounce, percentile } from "./segments";

export * from "./envelope";
export * from "./filters";
export * from "./level";
export * from "./ripple";
export * from "./edges";
export * from "./segments";
export * from "./threshold";
export * from "./tone";
export * from "./trim";
export * from "./decode-audio";

/** How short a run has to be, relative to the rough dit, before it's a glitch.
 *
 * Measured against a low percentile of mark lengths rather than the median:
 * the median can land on a dah in text that is dah-heavy, and 35% of a dah is
 * longer than a real dit. */
export const DEBOUNCE_FRAC = 0.35;
const ROUGH_UNIT_PERCENTILE = 20;

/** How many times the glitch floor may be re-estimated from its own output. */
const DEGLITCH_PASSES = 6;

/** Drop runs too short to be real keying, sizing "too short" from the keying.
 *
 * The floor is a fraction of the unit, and the unit is estimated from the
 * marks — which is circular, and the circularity has a direction. A clean
 * recording estimates its unit from real dits and gets a sensible floor. A
 * shattered one estimates it from the shards, gets a floor small enough to let
 * every shard through, and stays shattered: the worse the input, the less this
 * does about it.
 *
 * Re-estimating breaks the loop. Each pass removes the runs the current floor
 * condemns, measures the unit again on what survived, and re-runs from the
 * ORIGINAL segments rather than from the previous pass — so the floor rises
 * toward the truth without any pass compounding the last one's mistakes. It
 * stops as soon as the estimate holds still.
 *
 * On a recording with nothing wrong with it the first pass removes nothing, so
 * the second estimate equals the first and it stops immediately, having done
 * exactly what it did before. */
function deglitch(segments: readonly Segment[]): Segment[] {
  const unitOf = (segs: readonly Segment[]): number => {
    const marks = segs.filter((s) => s[0] === 1).map((s) => s[1]);
    return marks.length > 0 ? percentile(marks, ROUGH_UNIT_PERCENTILE) : 0;
  };

  let unit = unitOf(segments);
  if (!(unit > 0)) return segments.slice();

  let out = debounce(segments, DEBOUNCE_FRAC * unit);
  for (let pass = 1; pass < DEGLITCH_PASSES; pass++) {
    const next = unitOf(out);
    // Only ever upward, and only when it actually moved: a floor that shrank
    // would re-admit shards this pass had already established were not real.
    if (!(next > unit * 1.000001)) break;
    unit = next;
    out = debounce(segments, DEBOUNCE_FRAC * unit);
  }
  return out;
}

export interface SegmentationResult {
  readonly toneHz: number;
  readonly segments: Segment[];
  /** The amplitude that counted as key-down, for diagnostics. */
  readonly threshold: number;
}

export interface SegmentOptions {
  /** Skip tone detection and use this frequency. */
  readonly toneHz?: number;
  readonly bandwidth?: number;
}

/** Detect the tone, find the keying, and return it as timed runs.
 *
 * `samples` should be peak-normalized — see `normalized()` — because the
 * threshold works on absolute amplitude. */
export function segmentsFrom(
  samples: Float32Array,
  rate: number,
  options: SegmentOptions = {},
): SegmentationResult {
  const bandwidth = options.bandwidth ?? DEFAULT_BANDWIDTH;
  const toneHz = options.toneHz ?? detectTone(samples, rate);

  const env = envelope(samples, rate, toneHz, bandwidth);
  const threshold = keyingThreshold(env);

  // One number cannot separate marks from gaps when the marks are not all the
  // same height, so the decision boundary follows the local signal level. It
  // is exactly `threshold` wherever the level is steady, and inert wherever
  // the envelope is nowhere near it — see level.ts.
  const curve = thresholdCurve(env, rate, threshold);
  const crossed = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) crossed[i] = env[i]! > curve[i]! ? 1 : 0;

  // A mark whose envelope ripples can cross back under the threshold without
  // the key ever having come up. Close those, judged by how far the dip fell
  // rather than by how long it lasted — see ripple.ts.
  const binary = fillRippleGaps(crossed, env, curve);

  // Detection is done; measurement is a separate question. Where the edges
  // are slower than the envelope's own resolution — a room, not a keyer — the
  // threshold no longer sits at an unbiased height on them, so the boundaries
  // are re-placed at half the local steady level. Weighted by how slow they
  // actually are, which is zero for a recording that never needed it.
  const peak = localPeak(env, rate, LEVEL_WINDOW_SEC);
  const weight = correctionWeight(edgeTransitionSec(binary, env, peak, rate));
  const raw = weight > 0
    ? refineEdges(binary, env, peak, rate, weight)
    : runLengths(binary, rate);
  const segments = deglitch(raw);

  return { toneHz, segments, threshold };
}
