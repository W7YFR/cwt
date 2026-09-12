/* audio -> segments, the whole of it.
 *
 * One entry point, `segmentsFrom`, and everything it calls is a pure function
 * over a Float32Array. The Web Audio dependency lives one module over in
 * decode-audio.ts and is not imported here, which is what lets the Python
 * oracle test run this exact code path under Node.
 */

import type { Segment } from "@/types";
import { envelope, DEFAULT_BANDWIDTH } from "./envelope";
import { keyingThreshold } from "./threshold";
import { detectTone } from "./tone";
import { runLengths, debounce, percentile } from "./segments";

export * from "./envelope";
export * from "./filters";
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

  const binary = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) binary[i] = env[i]! > threshold ? 1 : 0;

  let segments = runLengths(binary, rate);

  // First-pass unit estimate for debounce, then re-segment.
  const marks = segments.filter((s) => s[0] === 1).map((s) => s[1]);
  if (marks.length > 0) {
    const roughUnit = percentile(marks, ROUGH_UNIT_PERCENTILE);
    segments = debounce(segments, DEBOUNCE_FRAC * roughUnit);
  }

  return { toneHz, segments, threshold };
}
