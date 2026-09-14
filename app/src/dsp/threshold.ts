/* Where the key goes down.
 *
 * A direct port of core.py's otsu_threshold / keying_threshold, including the
 * reason the second one exists.
 */

/** Otsu's method on the envelope amplitude histogram.
 *
 * The value that best separates the sample into two classes by maximizing the
 * variance between them — here, silence-and-noise versus tone. */
export function otsuThreshold(env: Float32Array, bins = 256): number {
  let lo = Infinity;
  let hi = -Infinity;
  let count = 0;
  let sum = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
    count++;
  }
  if (count === 0) return 0;
  if (!(hi > lo)) return lo;

  const hist = new Float64Array(bins);
  const scale = bins / (hi - lo);
  for (let i = 0; i < env.length; i++) {
    const v = env[i]!;
    if (!Number.isFinite(v)) continue;
    // The top edge belongs to the last bin, matching numpy.histogram.
    const b = Math.min(bins - 1, Math.floor((v - lo) * scale));
    hist[b] = hist[b]! + 1;
  }

  const binWidth = (hi - lo) / bins;
  const center = (b: number) => lo + (b + 0.5) * binWidth;

  let muTotal = 0;
  for (let b = 0; b < bins; b++) muTotal += hist[b]! * center(b);

  let wAcc = 0;
  let muAcc = 0;
  let best = -Infinity;
  let bestBin = -1;
  for (let b = 0; b < bins; b++) {
    wAcc += hist[b]!;
    muAcc += hist[b]! * center(b);
    const denom = wAcc * (count - wAcc);
    if (denom === 0) continue;
    const num = muTotal * wAcc - muAcc;
    const between = (num * num) / denom;
    if (between > best) {
      best = between;
      bestBin = b;
    }
  }
  if (bestBin < 0) return sum / count; // constant input: no split exists
  return center(bestBin);
}

/** Threshold for key-down detection.
 *
 * Otsu finds the boundary between the off class and the on class, but that
 * boundary sits high on the on-plateau and biases every mark short. Take the
 * midpoint of the two class *means* instead, which lands near the 50%
 * amplitude crossing — unbiased for raised-cosine keying, and robust to noise
 * because the off-class mean tracks the noise floor rather than zero. */
export function keyingThreshold(env: Float32Array): number {
  const boundary = otsuThreshold(env);
  let offSum = 0;
  let offN = 0;
  let onSum = 0;
  let onN = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i]!;
    if (!Number.isFinite(v)) continue;
    if (v <= boundary) {
      offSum += v;
      offN++;
    } else {
      onSum += v;
      onN++;
    }
  }
  if (offN === 0 || onN === 0) return boundary;
  return (offSum / offN + onSum / onN) / 2;
}
