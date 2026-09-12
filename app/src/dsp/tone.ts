/* Find the CW carrier frequency.
 *
 * Python did this with one FFT over the whole clip and an argmax inside the
 * band. A full FFT is the wrong shape in the browser — we only care about
 * 200-1500 Hz, which is under 3% of a 48 kHz spectrum, so computing the other
 * 97% and throwing it away is most of the work.
 *
 * Instead: decimate to a rate that comfortably covers the band, then sweep
 * Goertzel over it. Goertzel is one bin of a DFT at the cost of one multiply
 * and two adds per sample, so a coarse sweep followed by a fine one around the
 * winner costs a fraction of a transform.
 *
 * The catch, and the reason the two stages use different block lengths: a
 * Goertzel bin is as narrow as its block is long. Run it over a 12-second clip
 * and the bin is 0.08 Hz wide, so stepping the sweep by 0.5 Hz samples the
 * spectrum through a picket fence and can miss the carrier by a couple of
 * hertz. The coarse stage therefore uses short blocks — wide bins, no gaps
 * between them — and the fine stage uses the full signal, stepped finely
 * enough that its narrow bins overlap.
 *
 * Precision here is for the *display* and for synthesizing the target track:
 * the envelope detector has a 200 Hz-wide passband and tolerates being tens of
 * hertz out, but a target that beats against your own recording sounds wrong
 * even when the timing is right.
 */

import { decimate } from "./filters";

export const TONE_MIN_HZ = 200;
export const TONE_MAX_HZ = 1500;

/** Sample rate to survey at: above 2x the top of the band, with margin. */
const SURVEY_RATE = 4000;

/** Coarse bin width, Hz. Short blocks, so the coarse sweep cannot fall
 *  between bins and lose the carrier. */
const COARSE_BIN_HZ = 8;
/** Coarse sweep step, Hz. At or below the bin width, so bins overlap. */
const COARSE_STEP_HZ = 6;
/** How far either side of the coarse winner the fine sweep looks. */
const FINE_SPAN_HZ = 12;
/** Fine sweep step, Hz — the precision of the reported frequency. */
const FINE_STEP_HZ = 0.1;
/** Cap on the fine stage's analysis length. Past a few seconds the bin is
 *  already far narrower than the step, and the extra samples only cost time. */
const FINE_MAX_SEC = 20;

/** Squared magnitude at `freq` over `x[from..to)`, via the Goertzel recurrence.
 *
 * Unnormalized: only ever compared against other frequencies over the same
 * samples, so the scale cancels. */
export function goertzelPower(
  x: Float32Array,
  rate: number,
  freq: number,
  from = 0,
  to = x.length,
): number {
  if (to <= from) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s = x[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Total power at `freq`, summed over consecutive blocks of `blockLen`.
 *
 * Blocking is what sets the bin width: each block resolves rate/blockLen, and
 * summing their powers averages the noise down without narrowing the bin. */
function blockedPower(
  x: Float32Array,
  rate: number,
  freq: number,
  blockLen: number,
): number {
  let total = 0;
  for (let at = 0; at + blockLen <= x.length; at += blockLen) {
    total += goertzelPower(x, rate, freq, at, at + blockLen);
  }
  return total;
}

/** The dominant frequency in [fmin, fmax], in Hz. */
export function detectTone(
  samples: Float32Array,
  rate: number,
  fmin = TONE_MIN_HZ,
  fmax = TONE_MAX_HZ,
): number {
  if (samples.length === 0) return fmin;

  const factor = Math.max(1, Math.floor(rate / SURVEY_RATE));
  const x = decimate(samples, factor);
  const r = rate / factor;

  // Nothing above the survey Nyquist can be resolved, whatever was asked for.
  const hi = Math.min(fmax, r / 2 - 10);
  const lo = Math.min(fmin, hi);
  if (!(hi > lo)) return lo;

  // Coarse: wide bins from short blocks, stepped at or under the bin width.
  const blockLen = Math.max(16, Math.min(x.length, Math.round(r / COARSE_BIN_HZ)));
  let coarse = lo;
  let coarseBest = -Infinity;
  for (let f = lo; f <= hi + 1e-9; f += COARSE_STEP_HZ) {
    const p = blockedPower(x, r, f, blockLen);
    if (p > coarseBest) {
      coarseBest = p;
      coarse = f;
    }
  }

  // Fine: the whole signal (capped), so bins are narrow, stepped finely
  // enough that they overlap rather than leaving gaps.
  const fineLen = Math.min(x.length, Math.round(FINE_MAX_SEC * r));
  const from = Math.max(lo, coarse - FINE_SPAN_HZ);
  const to = Math.min(hi, coarse + FINE_SPAN_HZ);
  let best = from;
  let bestP = -Infinity;
  for (let f = from; f <= to + 1e-9; f += FINE_STEP_HZ) {
    const p = goertzelPower(x, r, f, 0, fineLen);
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  return Math.round(best * 10) / 10;
}
