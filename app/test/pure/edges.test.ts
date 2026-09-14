/* Re-placing mark boundaries, and the promise that it does nothing when it is
 * not needed.
 *
 * The identity test in the first block is the load-bearing one: at zero weight
 * this has to return byte-for-byte what `runLengths` would have returned, or
 * the clean-path lock is resting on luck.
 */

import { describe, expect, it } from "vitest";
import {
  correctionWeight,
  edgeTransitionSec,
  refineEdges,
  slowEdgeFloorSec,
} from "@/dsp/edges";
import { runLengths } from "@/dsp/segments";

const RATE = 8000;

/** An envelope of marks with linear edges of a chosen transition time.
 *
 * The ramps are *centered* on the true boundaries, which is how a symmetric
 * filter actually blurs an edge — half the transition falls either side of the
 * instant the key moved. That is what makes the half-height crossing recover
 * the true width, and it is the property the code under test relies on. A
 * generator that put the whole ramp inside the mark would make the true width
 * unrecoverable by construction, and the test would be measuring its own
 * arithmetic rather than the code. */
function ramped(
  rate: number,
  markSec: number,
  gapSec: number,
  count: number,
  edgeSec: number,
  level = 1,
): { env: Float32Array; peak: Float32Array } {
  const pad = Math.round(0.1 * rate);
  const m = Math.round(markSec * rate);
  const g = Math.round(gapSec * rate);
  const e = Math.max(2, Math.round(edgeSec * rate));
  const n = pad * 2 + count * (m + g);
  const env = new Float32Array(n);
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  let at = pad;
  for (let k = 0; k < count; k++) {
    for (let i = -e; i < m + e; i++) {
      const idx = at + i;
      if (idx < 0 || idx >= n) continue;
      const up = clamp(0.5 + i / e);
      const down = clamp(0.5 + (m - i) / e);
      env[idx] = Math.max(env[idx]!, level * Math.min(up, down));
    }
    at += m + g;
  }
  return { env, peak: new Float32Array(n).fill(level) };
}

function binarize(env: Float32Array, threshold: number): Uint8Array {
  const b = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) b[i] = env[i]! > threshold ? 1 : 0;
  return b;
}

describe("a correction of zero weight is the identity", () => {
  it("returns exactly what run-length encoding would have returned", () => {
    const { env, peak } = ramped(RATE, 0.06, 0.06, 8, 0.004);
    const bin = binarize(env, 0.55);
    const plain = runLengths(bin, RATE);
    const refined = refineEdges(bin, env, peak, RATE, 0);
    expect(refined.length).toBe(plain.length);
    refined.forEach((s, i) => {
      expect(s[0], `state ${i}`).toBe(plain[i]![0]);
      expect(s[1], `duration ${i}`).toBe(plain[i]![1]);
    });
  });

  it("is the identity for a signal with no marks at all", () => {
    const env = new Float32Array(1000);
    const peak = new Float32Array(1000).fill(1);
    const bin = new Uint8Array(1000);
    expect(refineEdges(bin, env, peak, RATE, 0)).toEqual(runLengths(bin, RATE));
  });

  it("does not modify the keying it was given", () => {
    const { env, peak } = ramped(RATE, 0.06, 0.06, 4, 0.02);
    const bin = binarize(env, 0.75);
    const before = Array.from(bin);
    refineEdges(bin, env, peak, RATE, 1);
    expect(Array.from(bin)).toEqual(before);
  });
});

describe("the correction weight", () => {
  it("is zero at and below the instrument's own resolution", () => {
    expect(correctionWeight(0)).toBe(0);
    expect(correctionWeight(slowEdgeFloorSec() * 0.5)).toBe(0);
    expect(correctionWeight(slowEdgeFloorSec())).toBe(0);
  });

  it("reaches full correction at twice the floor, and stops there", () => {
    expect(correctionWeight(slowEdgeFloorSec() * 2)).toBe(1);
    expect(correctionWeight(slowEdgeFloorSec() * 10)).toBe(1);
  });

  it("rises continuously in between, with no step at either end", () => {
    const f = slowEdgeFloorSec();
    let last = 0;
    for (let k = 1; k <= 40; k++) {
      const w = correctionWeight(f * (1 + k / 20));
      expect(w).toBeGreaterThanOrEqual(last);
      expect(w - last, "no jump").toBeLessThan(0.1);
      last = w;
    }
    expect(last).toBe(1);
  });
});

describe("measuring how fast the edges are", () => {
  it("recovers the transition time of a known ramp", () => {
    // 30% to 70% is four tenths of a linear ramp.
    for (const edgeSec of [0.004, 0.02, 0.05]) {
      const { env, peak } = ramped(RATE, 0.2, 0.1, 6, edgeSec);
      const bin = binarize(env, 0.5);
      const got = edgeTransitionSec(bin, env, peak, RATE);
      expect(got, `${edgeSec * 1000} ms ramp`).toBeCloseTo(0.4 * edgeSec, 3);
    }
  });

  it("says a signal with no marks has nothing to measure", () => {
    const env = new Float32Array(1000);
    const peak = new Float32Array(1000).fill(1);
    expect(edgeTransitionSec(new Uint8Array(1000), env, peak, RATE)).toBe(0);
  });

  it("separates a slow edge from a fast one", () => {
    const fast = ramped(RATE, 0.2, 0.1, 6, 0.003);
    const slow = ramped(RATE, 0.2, 0.1, 6, 0.05);
    const a = edgeTransitionSec(binarize(fast.env, 0.5), fast.env, fast.peak, RATE);
    const b = edgeTransitionSec(binarize(slow.env, 0.5), slow.env, slow.peak, RATE);
    expect(correctionWeight(a)).toBe(0);
    expect(correctionWeight(b)).toBe(1);
  });
});

describe("what the correction actually fixes", () => {
  it("recovers the true mark length from a threshold sitting high on the edge", () => {
    // The microphone case in miniature: slow edges, and a threshold at 75% of
    // the mark rather than the 50% where errors cancel. Measured at that
    // height the mark reads short; re-placed at half, it reads true.
    const markSec = 0.06;
    const edgeSec = 0.03;
    const { env, peak } = ramped(RATE, markSec, 0.06, 6, edgeSec);
    const bin = binarize(env, 0.75);

    const asFound = runLengths(bin, RATE).filter((s) => s[0] === 1).map((s) => s[1]);
    const refined = refineEdges(bin, env, peak, RATE, 1).filter((s) => s[0] === 1).map((s) => s[1]);

    // Both measure the same number of marks; only the boundaries move.
    expect(refined.length).toBe(asFound.length);
    // A linear ramp crossed at 75% loses 2 x 0.25 x edge from each mark.
    expect(asFound[1]!).toBeCloseTo(markSec - 0.5 * edgeSec, 3);
    expect(refined[1]!, "restored to the true length").toBeCloseTo(markSec, 3);
  });

  it("keeps boundaries in order, so no gap can come out negative", () => {
    // Marks close together with slow edges: refined boundaries could otherwise
    // reach back past the previous mark's end.
    const { env, peak } = ramped(RATE, 0.03, 0.006, 10, 0.02);
    const bin = binarize(env, 0.6);
    for (const seg of refineEdges(bin, env, peak, RATE, 1)) {
      expect(seg[1], `${seg[0] === 1 ? "mark" : "gap"} duration`).toBeGreaterThan(0);
    }
  });

  it("covers the whole recording, losing no time at either end", () => {
    const { env, peak } = ramped(RATE, 0.06, 0.06, 5, 0.02);
    const bin = binarize(env, 0.7);
    for (const weight of [0, 0.5, 1]) {
      const total = refineEdges(bin, env, peak, RATE, weight).reduce((a, s) => a + s[1], 0);
      expect(total, `weight ${weight}`).toBeCloseTo(env.length / RATE, 9);
    }
  });
});
