/* The threshold that follows the signal, and the promise it makes to signals
 * that do not need it.
 *
 * The first describe block is the important one. Everything else here is
 * ordinary correctness; that block is the reason the clean-path lock can still
 * pass at all after the decoder learned to cope with a moving level.
 */

import { describe, expect, it } from "vitest";
import {
  LEVEL_DEADBAND,
  LEVEL_MIN_SCALE,
  LEVEL_WINDOW_SEC,
  localPeak,
  slidingMax,
  thresholdCurve,
} from "@/dsp/level";

const RATE = 8000;

/** An envelope with marks of a given height, one per `periodSec`. */
function keying(
  seconds: number,
  rate: number,
  heightAt: (t: number) => number,
  markSec = 0.06,
  periodSec = 0.12,
): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = t % periodSec;
    out[i] = phase < markSec ? heightAt(t) : 0.001;
  }
  return out;
}

describe("the sliding maximum", () => {
  it("is the largest value in the window around each sample", () => {
    const x = Float32Array.from([1, 5, 2, 8, 3, 0, 4, 9, 6, 1]);
    const w = 5;
    const got = slidingMax(x, w);
    for (let i = 0; i < x.length; i++) {
      let want = -Infinity;
      for (let k = Math.max(0, i - (w >> 1)); k < Math.min(x.length, i - (w >> 1) + w); k++) {
        want = Math.max(want, x[k]!);
      }
      expect(got[i], `at ${i}`).toBe(want);
    }
  });

  it("agrees with the brute-force answer on random input at several widths", () => {
    // The deque is the kind of code that is right for every case one thinks of
    // and wrong for one more, so it gets compared against the definition.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const x = Float32Array.from({ length: 400 }, () => rand());
    for (const w of [1, 2, 3, 7, 16, 51, 400, 999]) {
      const got = slidingMax(x, w);
      for (let i = 0; i < x.length; i++) {
        let want = -Infinity;
        for (let k = Math.max(0, i - (w >> 1)); k < Math.min(x.length, i - (w >> 1) + w); k++) {
          want = Math.max(want, x[k]!);
        }
        expect(got[i], `width ${w} at ${i}`).toBe(want);
      }
    }
  });

  it("handles an empty input", () => {
    expect(slidingMax(new Float32Array(0), 8).length).toBe(0);
  });
});

describe("a steady level is left completely alone", () => {
  /* The guarantee the whole design rests on. Not "close to the base
     threshold", not "within a tolerance" — the same number, at every sample,
     so that a recording which decoded correctly cannot decode differently. */

  it("returns exactly the base threshold for a signal that never varies", () => {
    const env = keying(4, RATE, () => 0.8);
    const base = 0.4;
    const curve = thresholdCurve(env, RATE, base);
    for (let i = 0; i < curve.length; i++) {
      expect(curve[i], `sample ${i}`).toBe(base);
    }
  });

  it("leaves variation inside the deadband alone", () => {
    // Half the deadband of wander, which is what an already-good recording
    // actually has, and nothing should move.
    const env = keying(4, RATE, (t) => 0.8 * (1 - (LEVEL_DEADBAND / 2) * (t / 4)));
    const curve = thresholdCurve(env, RATE, 0.4);
    for (let i = 0; i < curve.length; i++) expect(curve[i]).toBe(0.4);
  });

  it("returns the base threshold for an empty or silent envelope", () => {
    expect(thresholdCurve(new Float32Array(0), RATE, 0.4).length).toBe(0);
    const silent = thresholdCurve(new Float32Array(1000), RATE, 0.4);
    for (let i = 0; i < silent.length; i++) expect(silent[i]).toBe(0.4);
  });
});

describe("a moving level is followed", () => {
  it("lowers the threshold where the signal is quieter", () => {
    // Loud for the first half, half as loud for the second.
    const env = keying(6, RATE, (t) => (t < 3 ? 0.8 : 0.4));
    const curve = thresholdCurve(env, RATE, 0.4);
    const early = curve[Math.round(1.5 * RATE)]!;
    const late = curve[Math.round(4.5 * RATE)]!;
    expect(early).toBe(0.4);
    expect(late).toBeLessThan(early);
    // Proportional to the drop, within the deadband's worth of slack.
    expect(late / early).toBeCloseTo(0.5 / (1 - LEVEL_DEADBAND), 1);
  });

  it("never scales below the floor, however quiet the stretch", () => {
    const env = keying(6, RATE, (t) => (t < 3 ? 1 : 0.001));
    const curve = thresholdCurve(env, RATE, 0.4);
    for (let i = 0; i < curve.length; i++) {
      expect(curve[i]!, `sample ${i}`).toBeGreaterThanOrEqual(0.4 * LEVEL_MIN_SCALE - 1e-12);
    }
  });

  it("never raises the threshold above the base", () => {
    // Loud stretches are left alone rather than pulled down — raising the
    // threshold anywhere would lose marks that the old code found.
    const env = keying(6, RATE, (t) => (t < 3 ? 0.3 : 0.9));
    const curve = thresholdCurve(env, RATE, 0.4);
    for (let i = 0; i < curve.length; i++) expect(curve[i]!).toBeLessThanOrEqual(0.4);
  });

  it("moves smoothly rather than stepping", () => {
    // A step in the threshold would read as an edge in the keying. The peak
    // estimate is smoothed to prevent that, so consecutive samples stay close.
    const env = keying(6, RATE, (t) => 0.9 * Math.exp(-t / 3));
    const curve = thresholdCurve(env, RATE, 0.4);
    let worst = 0;
    for (let i = 1; i < curve.length; i++) {
      worst = Math.max(worst, Math.abs(curve[i]! - curve[i - 1]!));
    }
    // Well under a thousandth of the base per sample.
    expect(worst).toBeLessThan(0.4 / 1000);
  });

  it("is continuous where it starts to follow the level down", () => {
    // At the deadband edge both branches have to agree, or the threshold jumps
    // the moment a recording drifts by one part in twenty.
    const env = keying(8, RATE, (t) => 1 - 0.1 * (t / 8));
    const curve = thresholdCurve(env, RATE, 0.4);
    const seen = new Set<number>();
    for (let i = 0; i < curve.length; i++) seen.add(curve[i]!);
    // Values either side of the deadband boundary, with nothing missing in
    // between: sorted neighbors stay close together.
    const vals = [...seen].sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]! - vals[i - 1]!, "gap in the range of thresholds").toBeLessThan(0.4 / 100);
    }
  });
});

describe("the local peak", () => {
  it("tracks the height of nearby marks", () => {
    const env = keying(6, RATE, (t) => (t < 3 ? 0.9 : 0.3));
    const peak = localPeak(env, RATE, LEVEL_WINDOW_SEC);
    expect(peak[Math.round(1.5 * RATE)]!).toBeCloseTo(0.9, 1);
    expect(peak[Math.round(4.5 * RATE)]!).toBeCloseTo(0.3, 1);
  });

  it("is constant for a constant signal, which is what makes the identity hold", () => {
    const env = keying(4, RATE, () => 0.7);
    const peak = localPeak(env, RATE, LEVEL_WINDOW_SEC);
    const first = peak[0]!;
    for (let i = 0; i < peak.length; i++) expect(peak[i], `sample ${i}`).toBe(first);
  });
});
