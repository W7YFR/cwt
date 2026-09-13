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
import { applyReleaseOffset, type Calibration } from "./calibrate";
import { localPeak, LEVEL_WINDOW_SEC } from "./level";
import { keyingThreshold } from "./threshold";
import { tonePresence, type Presence } from "./presence";
import { detectTone } from "./tone";
import { runLengths, debounce, roughUnitSec } from "./segments";

export * from "./envelope";
export * from "./filters";
export * from "./level";
export * from "./presence";
export * from "./quality";
export * from "./ripple";
export * from "./edges";
export * from "./calibrate";
export * from "./sections";
export * from "./segments";
export * from "./threshold";
export * from "./tone";
export * from "./trim";
export * from "./decode-audio";

/** How short a run has to be, relative to the rough dit, before it's a glitch. */
export const DEBOUNCE_FRAC = 0.35;

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
  // The floor is a fraction of the unit that marks AND gaps agree on — see
  // roughUnitSec, where taking whichever is shorter is what stops a drill of
  // nothing but dahs from condemning every gap in the recording and merging
  // the whole thing into a single eleven-second mark.
  let unit = roughUnitSec(segments);
  if (!(unit > 0)) return segments.slice();

  let out = debounce(segments, DEBOUNCE_FRAC * unit);
  for (let pass = 1; pass < DEGLITCH_PASSES; pass++) {
    const next = roughUnitSec(out);
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
  /** Whether there was anything here to decode — see presence.ts. When there
   *  was not, `segments` is empty rather than full of invented elements. */
  readonly presence: Presence;
}

export interface SegmentOptions {
  /** Skip tone detection and use this frequency. */
  readonly toneHz?: number;
  readonly bandwidth?: number;
  /** A measured profile for this microphone and room.
   *
   * Its presence changes two things. The edge correction runs at full strength
   * rather than in proportion to how slow the edges look, because a measured
   * profile is better evidence than that estimate; and the profile's release
   * offset comes off every mark. Absent — which is the default, and what every
   * recording gets until somebody runs a calibration — none of this happens
   * and the pipeline behaves exactly as it did. */
  readonly calibration?: Calibration;
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

  // Before anything else: is there a tone in here at all? Everything below
  // will find structure in whatever it is handed, so silence decodes as a
  // hundred invented elements unless something is willing to say no.
  const presence = tonePresence(samples, rate);
  if (!presence.keyed) return { toneHz, segments: [], threshold: 0, presence };

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
  const cal = options.calibration;
  // A measured profile outranks the estimate: correct fully, then take off the
  // offset the room was measured to add. Without one, the correction is scaled
  // by how slow the edges look, which is zero on a recording that never needed
  // it — see edges.ts.
  const weight = cal ? 1 : correctionWeight(edgeTransitionSec(binary, env, peak, rate));
  const raw = weight > 0
    ? refineEdges(binary, env, peak, rate, weight)
    : runLengths(binary, rate);
  const corrected = cal ? applyReleaseOffset(raw, cal.releaseOffsetSec) : raw;
  const segments = deglitch(corrected);

  return { toneHz, segments, threshold, presence };
}
