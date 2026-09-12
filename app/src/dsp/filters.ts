/* Zero-phase smoothing primitives.
 *
 * Everything here is a *centered* moving average, and that is the whole point.
 * The Python decoder used scipy's `filtfilt`, which runs an IIR forward and
 * backward so the result has no phase shift; a plain causal filter would delay
 * the envelope and move every mark boundary. Rise and fall edges would not
 * even move by the same amount, so dit and dah lengths would come out wrong
 * rather than merely offset.
 *
 * A boxcar applied about its center is exactly zero-phase and costs two adds
 * per sample regardless of width. Cascading three of them approximates a
 * Gaussian closely enough for a stopband that kills the 2f image left by
 * quadrature demodulation, which is all the lowpass here has to do.
 */

/** Centered moving average of width `w`, in place-safe out-of-place form.
 *
 * Edges are handled by shrinking the window rather than zero-padding: a
 * zero-padded edge would dip toward silence and could read as a key-up at the
 * very start of a recording that opens mid-mark. */
export function boxcar(x: Float32Array, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const width = Math.max(1, Math.floor(w));
  if (width <= 1) {
    out.set(x);
    return out;
  }

  // Running sum over a window that is `half` either side of the cursor.
  const half = width >> 1;
  // Prefix sums in float64: a float32 accumulator over a million samples
  // loses the low bits and the window sum drifts visibly.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + x[i]!;

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i - half + width);
    out[i] = (pre[hi]! - pre[lo]!) / (hi - lo);
  }
  return out;
}

/** `passes` cascaded centered boxcars — a cheap near-Gaussian lowpass. */
export function smooth(x: Float32Array, w: number, passes = 1): Float32Array {
  let out = x;
  for (let i = 0; i < passes; i++) out = boxcar(out, w);
  return out;
}

/** Boxcar width whose -3 dB point lands near `cutoffHz` after `passes` of it.
 *
 * `passes` is not decoration. Cascading boxcars narrows the response, so
 * sizing a single one and then applying it three times lands nowhere near the
 * cutoff that was asked for — at 8 kHz and 100 Hz the naive width comes out
 * 35 samples and the cascade is actually 3 dB down by 61 Hz, over-smoothed by
 * a factor of 1.6. That rounds the keying edges wider than they are, and since
 * the threshold does not sit at exactly half the plateau, a wider edge moves
 * the crossing, and marks measure about a millisecond short against a machine
 * keyer whose true speed is known.
 *
 * n cascaded boxcars of width W approach a Gaussian with
 * sigma = W * sqrt(n/12) samples, which is 3 dB down at 0.1325/sigma_seconds.
 * Solving for W gives the width below. */
export function widthForCutoff(
  rate: number,
  cutoffHz: number,
  passes = 1,
): number {
  if (!(cutoffHz > 0)) return 1;
  const n = Math.max(1, passes);
  const sigmaSec = 0.1325 / cutoffHz;
  return Math.max(1, Math.round(sigmaSec * rate * Math.sqrt(12 / n)));
}

/** Decimate by an integer factor, lowpassing first so nothing aliases.
 *
 * Only used by tone detection, which wants a cheap survey of the spectrum
 * rather than a faithful signal. The main envelope path never decimates — it
 * runs at the recording's own rate, which is what keeps segment boundaries at
 * full resolution. */
export function decimate(
  x: Float32Array,
  factor: number,
): Float32Array {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return x;
  const lp = smooth(x, f, 2);
  const n = Math.floor(x.length / f);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lp[i * f]!;
  return out;
}
