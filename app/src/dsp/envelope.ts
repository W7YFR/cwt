/* Key-down power over time.
 *
 * Python bandpassed around the tone with a 4th-order Butterworth, took the
 * magnitude of the analytic signal via Hilbert transform, then smoothed. That
 * is three O(N log N)-or-worse operations and needs an FFT-based Hilbert.
 *
 * The same answer comes out of quadrature demodulation in one linear pass:
 * multiply by cos and -sin at the tone frequency to slide the carrier down to
 * DC, lowpass both arms to throw away the image at 2f, and take the magnitude
 * of the resulting complex baseband. That magnitude *is* the analytic-signal
 * envelope of the bandpassed input — the same quantity, derived rather than
 * transformed, at O(N) with small constants.
 *
 * It runs at the recording's own sample rate. The Python pipeline resampled to
 * 8 kHz first, which was a compute decision (filtfilt+hilbert over a minute of
 * 48 kHz audio is six times the work) and cost a resampler in the middle of the
 * measurement path. Here there is no resampler, so nothing depends on whether
 * Chrome and Firefox round the same way.
 */

import { smooth, widthForCutoff } from "./filters";

/** Full width of the effective passband around the tone, in Hz. */
export const DEFAULT_BANDWIDTH = 200;

/** Envelope smoothing window. Matches the Python pipeline's 5 ms average —
 *  long enough to flatten ripple, short enough that a 40 wpm dit (30 ms)
 *  keeps square-ish edges. */
export const SMOOTH_SEC = 0.005;

/** Cascade depth of the baseband lowpass. Three passes put the 2f image more
 *  than 70 dB down while keeping the impulse response short. */
const LOWPASS_PASSES = 3;

/** Key-down power at every sample, same length as the input.
 *
 * `bandwidth` is the full passband width; the lowpass on each quadrature arm
 * gets half of it, which is what makes the two-sided response match. */
export function envelope(
  samples: Float32Array,
  rate: number,
  toneHz: number,
  bandwidth = DEFAULT_BANDWIDTH,
): Float32Array {
  const n = samples.length;
  const inPhase = new Float32Array(n);
  const quad = new Float32Array(n);
  if (n === 0) return inPhase;

  // Incremental rotation instead of Math.cos/Math.sin per sample: two
  // multiplies and two adds, and no trig call in the inner loop. Re-seeded
  // every 4096 samples because the recurrence accumulates amplitude error
  // over a long clip, and an envelope that slowly shrinks would drag the
  // threshold with it.
  const w = (2 * Math.PI * toneHz) / rate;
  const stepCos = Math.cos(w);
  const stepSin = Math.sin(w);
  const RESEED = 4096;
  let c = 1;
  let s = 0;

  for (let i = 0; i < n; i++) {
    if ((i & (RESEED - 1)) === 0) {
      const phase = w * i;
      c = Math.cos(phase);
      s = Math.sin(phase);
    } else {
      const nc = c * stepCos - s * stepSin;
      s = s * stepCos + c * stepSin;
      c = nc;
    }
    const v = samples[i]!;
    inPhase[i] = v * c;
    quad[i] = -v * s;
  }

  // Lowpass both arms. Three cascaded centered boxcars give a stopband deep
  // enough to bury the 2f image while staying exactly zero-phase, so no mark
  // boundary moves. The width accounts for the cascade — see widthForCutoff,
  // where getting this wrong costs about a millisecond per edge.
  const width = widthForCutoff(rate, bandwidth / 2, LOWPASS_PASSES);
  const iLp = smooth(inPhase, width, LOWPASS_PASSES);
  const qLp = smooth(quad, width, LOWPASS_PASSES);

  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = iLp[i]!;
    const b = qLp[i]!;
    // The 2x recovers the original tone's amplitude: demodulating a real
    // signal splits its energy between the positive and negative frequency
    // images, and the lowpass keeps only one.
    mag[i] = 2 * Math.sqrt(a * a + b * b);
  }

  return smooth(mag, Math.max(1, Math.round(SMOOTH_SEC * rate)), 1);
}
