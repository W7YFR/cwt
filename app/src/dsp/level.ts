/* Following a signal whose level moves.
 *
 * The threshold is a single number for the whole recording, chosen by Otsu's
 * method on the envelope's histogram. That works when every mark arrives at
 * the same height — a loopback capture, or a synthesized signal — because the
 * histogram is then honestly two humps and the split between them is obvious.
 *
 * A microphone in a room does not do that. Someone shifting in their chair
 * moves the level by a few dB; automatic gain in the capture chain moves it
 * more and faster; a room moves it mark by mark as reflections add and cancel.
 * The upper hump smears across a range, Otsu stops finding a boundary between
 * two classes and starts slicing the loudest tail off one, and the threshold
 * ends up above most of the marks. They are not measured badly at that point —
 * they disappear, and a missing element cannot be detected downstream, because
 * a shorter message is a perfectly legitimate thing for someone to have sent.
 *
 * So the threshold stops being one number and becomes a curve: the global
 * threshold, scaled down across stretches where the signal itself is quieter.
 *
 * What is deliberately NOT done here is touching the envelope. An automatic
 * gain applied to the envelope would work too, and was the obvious first
 * design, but it rewrites every sample — including the silence at the ends,
 * where the peak estimate is mid-sweep between noise and signal. That shifts
 * the histogram Otsu reads, and so moves the threshold on recordings that had
 * nothing wrong with them. Moving the decision boundary instead has a property
 * the gain version cannot have: where the envelope is nowhere near the
 * boundary, moving it changes nothing at all. Silence stays silent because
 * there was never anything there to cross, whatever the threshold does.
 *
 * That is what keeps clean recordings bit-identical — not a tolerance, and not
 * a gate that decides which pipeline to run, but the fact that the adjustment
 * is inert wherever it is not needed.
 */

import { boxcar } from "./filters";

export interface LevelOptions {
  /** How far back and forward the peak estimate looks, in seconds. */
  readonly windowSec?: number;
  /** How far the local peak may sit below the reference before the threshold
   *  starts to follow it down. */
  readonly deadband?: number;
  /** Floor under the scaling, so the threshold can never be dragged down into
   *  the noise however quiet a stretch gets. */
  readonly minScale?: number;
}

/** Window for the peak estimate.
 *
 * Short enough to follow variation between neighboring marks, which is what a
 * room does to a microphone — a longer window takes the loudest mark in each
 * neighborhood and smooths away the very differences that need correcting.
 * Still long enough to span a character and the gaps inside it, so the
 * estimate is of the local signal level rather than of one element. */
export const LEVEL_WINDOW_SEC = 0.4;

/** Level variation left alone.
 *
 * Sized from the corpus rather than picked: recordings that already decode
 * correctly hold their level to well within this over a whole take, so nothing
 * below it is worth following, and not following it is what keeps those
 * recordings untouched. */
export const LEVEL_DEADBAND = 0.05;

/** How far the threshold may be scaled down, at most.
 *
 * Sets the depth of level variation that can be followed — 0.3 is a little
 * over 10 dB — and, more importantly, stops a long silence from pulling the
 * threshold down to where its own noise would cross it. */
export const LEVEL_MIN_SCALE = 0.3;

/** Running maximum over a centered window, in O(n) via a monotonic deque.
 *
 * Centered rather than causal so the estimate has no phase lag: a lagging peak
 * estimate would lower the threshold slightly after the level actually fell,
 * which shows up as an asymmetry between the leading and trailing edge of
 * every mark. */
export function slidingMax(x: Float32Array, width: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const w = Math.max(1, Math.floor(width));
  const half = w >> 1;

  // Indices, kept in decreasing order of value; the front is the window max.
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;

  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i - half + w - 1);
    while (next <= hi) {
      const v = x[next]!;
      while (tail > head && x[dq[tail - 1]!]! <= v) tail--;
      dq[tail++] = next++;
    }
    const lo = Math.max(0, i - half);
    while (tail > head && dq[head]! < lo) head++;
    out[i] = x[dq[head]!]!;
  }
  return out;
}

/** The local peak of the envelope — the height of whatever marks are nearby. */
export function localPeak(env: Float32Array, rate: number, windowSec: number): Float32Array {
  const w = Math.max(1, Math.round(windowSec * rate));
  // Smoothed so the estimate wanders rather than stepping when the sliding
  // window drops a peak. A boxcar of a constant is that same constant, so
  // smoothing costs nothing where the level is steady.
  return boxcar(slidingMax(env, w), Math.max(1, w >> 1));
}

/** The global threshold, scaled to follow the local signal level.
 *
 * Returns exactly `base` at every sample where the local peak is inside the
 * deadband, and slides down proportionally below that, bottoming out at
 * `base * minScale`. Continuous at the deadband edge, because a step in the
 * threshold would read as an edge in the keying. */
export function thresholdCurve(
  env: Float32Array,
  rate: number,
  base: number,
  opts: LevelOptions = {},
): Float64Array {
  const windowSec = opts.windowSec ?? LEVEL_WINDOW_SEC;
  const deadband = opts.deadband ?? LEVEL_DEADBAND;
  const minScale = opts.minScale ?? LEVEL_MIN_SCALE;

  const n = env.length;
  // Float64, so that `base * 1` is `base` — storing it into a Float32Array
  // would round it, and the comparison against the envelope would then differ
  // from the plain `env[i] > threshold` this has to reduce to. The identity
  // is meant to be a property of the arithmetic, not a lucky miss.
  const out = new Float64Array(n);
  if (n === 0) return out;

  const peak = localPeak(env, rate, windowSec);
  let ref = 0;
  for (let i = 0; i < n; i++) if (peak[i]! > ref) ref = peak[i]!;
  if (!(ref > 0)) {
    out.fill(base);
    return out;
  }

  const target = ref * (1 - deadband);
  for (let i = 0; i < n; i++) {
    const p = peak[i]!;
    const scale = p >= target ? 1 : Math.max(minScale, p / target);
    out[i] = base * scale;
  }
  return out;
}
