/* Closing dips that are not gaps.
 *
 * The first block is the one that protects clean recordings: a signal with no
 * shallow dips has to come back out untouched, or every assurance about the
 * clean path stops being true.
 */

import { describe, expect, it } from "vitest";
import { SHALLOW_FRAC, fillRippleGaps } from "@/dsp/ripple";

/** Build an envelope, a flat threshold, and the crossing it produces. */
function scene(levels: readonly number[], base = 0.5) {
  const env = Float32Array.from(levels);
  const curve = new Float64Array(levels.length).fill(base);
  const binary = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) binary[i] = env[i]! > curve[i]! ? 1 : 0;
  return { env, curve, binary };
}

const M = 1.0; // a mark
const G = 0.02; // a real gap, down at the noise floor
const D = 0.45; // a ripple trough: under the threshold, but barely

describe("a signal with no shallow dips is untouched", () => {
  it("returns the same keying for clean marks and gaps", () => {
    const { env, curve, binary } = scene([G, M, M, M, G, G, M, M, M, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual(Array.from(binary));
  });

  it("does not modify the array it was given", () => {
    const { env, curve, binary } = scene([G, M, M, D, M, M, G]);
    const before = Array.from(binary);
    fillRippleGaps(binary, env, curve);
    expect(Array.from(binary)).toEqual(before);
  });

  it("leaves an all-silent recording alone", () => {
    const { env, curve, binary } = scene([G, G, G, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual([0, 0, 0, 0]);
  });
});

describe("a ripple trough is closed", () => {
  it("joins the two halves of a mark split by a shallow dip", () => {
    const { env, curve, binary } = scene([G, M, M, D, M, M, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it("leaves a dip that reaches the noise floor alone", () => {
    // The one case that must never be closed: a real key-up.
    const { env, curve, binary } = scene([G, M, M, G, M, M, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual([0, 1, 1, 0, 1, 1, 0]);
  });

  it("closes a long shallow dip as readily as a short one", () => {
    // Duration is deliberately not a criterion — see the module comment. A
    // wide, shallow trough is still a trough.
    const { env, curve, binary } = scene([G, M, D, D, D, D, D, M, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("respects the depth cutoff at its boundary", () => {
    const base = 0.5;
    const justUnder = base * SHALLOW_FRAC * 0.99; // deep enough to be a real gap
    const justOver = base * SHALLOW_FRAC * 1.01; // shallow enough to be a trough
    const deep = scene([G, M, M, justUnder, M, M, G], base);
    expect(Array.from(fillRippleGaps(deep.binary, deep.env, deep.curve))[3]).toBe(0);
    const shallow = scene([G, M, M, justOver, M, M, G], base);
    expect(Array.from(fillRippleGaps(shallow.binary, shallow.env, shallow.curve))[3]).toBe(1);
  });
});

describe("dips at the edges of the recording", () => {
  it("does not close a dip with no mark before it", () => {
    // Silence at the start of a recording is the recording starting, not a
    // trough inside a mark, however shallow it happens to be.
    const { env, curve, binary } = scene([D, M, M, G]);
    expect(Array.from(fillRippleGaps(binary, env, curve))[0]).toBe(0);
  });

  it("does not close a dip with no mark after it", () => {
    const { env, curve, binary } = scene([G, M, M, D]);
    const out = Array.from(fillRippleGaps(binary, env, curve));
    expect(out[out.length - 1]).toBe(0);
  });
});

describe("badly shattered marks", () => {
  it("reassembles a mark broken into many slivers", () => {
    // The case that a "dip must be shorter than its neighbors" rule cannot
    // repair, because the neighbors are slivers too. Repeated passes get it.
    const { env, curve, binary } = scene([G, M, D, D, M, D, D, M, D, D, M, G]);
    const out = Array.from(fillRippleGaps(binary, env, curve));
    expect(out).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("stops rather than closing everything when dips are genuine", () => {
    // A long alternation of marks and real gaps is ordinary fast keying, and
    // must survive intact however many elements it has.
    const levels = [G];
    for (let i = 0; i < 30; i++) levels.push(M, G);
    const { env, curve, binary } = scene(levels);
    expect(Array.from(fillRippleGaps(binary, env, curve))).toEqual(Array.from(binary));
  });

  it("settles, rather than depending on how many passes it is given", () => {
    const { env, curve, binary } = scene([G, M, D, M, D, M, D, M, G]);
    const once = fillRippleGaps(binary, env, curve);
    const twice = fillRippleGaps(once, env, curve);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });
});
