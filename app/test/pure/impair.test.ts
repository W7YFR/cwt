/* The bad-audio generator, checked against what it claims to be.
 *
 * This file tests test infrastructure, which is worth doing exactly once and
 * for a specific reason: every conclusion about the decoder's competence comes
 * out of this generator. A room that does not decay at the rate it was asked
 * for, or ground truth off by a sample, would produce a confident and entirely
 * fictional map of where the decoder breaks.
 *
 * The most important assertion here is the last one, which holds the synthetic
 * room against the three real recordings. A model that cannot reproduce the
 * thing measured in the field is not a model of it.
 */

import { describe, expect, it } from "vitest";
import {
  convolve,
  decodeTake,
  gaussian,
  makeTake,
  rng,
  roomImpulse,
  scoreAgainst,
  truthSegments,
} from "../impair";
import { envelope, detectTone } from "@/dsp";
import { targetTiming } from "@/timing/model";
import { normalizePeak } from "../wav";

const TEXT = "CQ DE W1AW";
const RATE = 8000;

/** Median envelope fall time, 90% to 10% of each mark's own plateau.
 *
 * The measurement that separated the real recordings from each other:
 * 2.8 ms for the loopback capture, 29 ms for a webcam mic, 91 ms for a
 * condenser across a room. */
function fallMs(x: Float32Array, rate: number): number {
  const n = normalizePeak(x);
  const e = envelope(n, rate, detectTone(n, rate));
  const sorted = Float64Array.from(e).sort();
  const gate = 0.5 * sorted[Math.floor(0.97 * (sorted.length - 1))]!;
  const falls: number[] = [];
  let inMark = false;
  let start = 0;
  for (let i = 0; i < e.length; i++) {
    const on = e[i]! > gate;
    if (on && !inMark) {
      inMark = true;
      start = i;
    } else if (!on && inMark) {
      inMark = false;
      let lvl = 0;
      for (let k = start; k < i; k++) lvl = Math.max(lvl, e[k]!);
      let j90 = -1;
      let j10 = -1;
      for (let k = i; k < Math.min(e.length, i + rate); k++) {
        if (j90 < 0 && e[k]! <= 0.9 * lvl) j90 = k;
        if (e[k]! <= 0.1 * lvl) {
          j10 = k;
          break;
        }
      }
      if (j90 >= 0 && j10 > j90) falls.push(((j10 - j90) / rate) * 1000);
    }
  }
  falls.sort((a, b) => a - b);
  return falls.length ? falls[falls.length >> 1]! : NaN;
}

describe("the convolution", () => {
  it("leaves a signal alone when the room is a single impulse", () => {
    const x = Float32Array.from([1, -2, 3, -4, 5, 6, 7, 8]);
    expect(Array.from(convolve(x, Float64Array.of(1)))).toEqual(Array.from(x));
  });

  it("delays by one sample for a one-sample delay", () => {
    const x = Float32Array.from([1, 2, 3, 4]);
    expect(Array.from(convolve(x, Float64Array.of(0, 1)))).toEqual([0, 1, 2, 3]);
  });

  it("matches a direct convolution", () => {
    // The FFT path is the one everything uses; this is the only place it is
    // held against the definition rather than against its own output.
    const rand = rng(4);
    const x = Float32Array.from({ length: 300 }, () => gaussian(rand));
    const h = Float64Array.from({ length: 40 }, () => gaussian(rand));
    const want = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let k = 0; k < h.length && k <= i; k++) s += x[i - k]! * h[k]!;
      want[i] = s;
    }
    const got = convolve(x, h);
    for (let i = 0; i < x.length; i++) expect(got[i]!).toBeCloseTo(want[i]!, 4);
  });
});

describe("the synthetic room", () => {
  it("decays by 60 dB over the reverberation time it was asked for", () => {
    for (const rt60Sec of [0.1, 0.3]) {
      const h = roomImpulse(RATE, { rt60Sec, drDb: 0 }, rng(1));
      // Energy in a window early in the tail against one at the very end.
      // 60 dB down in amplitude is 1e-6 in energy.
      const win = Math.round(0.005 * RATE);
      const energy = (from: number) => {
        let s = 0;
        for (let i = from; i < Math.min(from + win, h.length); i++) s += h[i]! * h[i]!;
        return s;
      };
      const ratio = energy(h.length - win) / energy(1);
      expect(ratio, `rt60=${rt60Sec}`).toBeLessThan(1e-4);
      expect(ratio, `rt60=${rt60Sec}`).toBeGreaterThan(1e-8);
    }
  });

  it("puts the requested energy into the tail", () => {
    // Direct-to-reverberant is the parameter that decides whether a gap ever
    // reaches silence, so it has to mean what it says.
    for (const drDb of [0, 6, 12]) {
      const h = roomImpulse(RATE, { rt60Sec: 0.2, drDb }, rng(2));
      let tail = 0;
      for (let i = 1; i < h.length; i++) tail += h[i]! * h[i]!;
      expect(10 * Math.log10(h[0]! ** 2 / tail), `dr=${drDb}`).toBeCloseTo(drDb, 6);
    }
  });

  it("is disabled entirely at zero", () => {
    expect(Array.from(roomImpulse(RATE, { rt60Sec: 0, drDb: 0 }, rng(1)))).toEqual([1]);
  });
});

describe("the ground truth", () => {
  it("accounts for every element the message contains", () => {
    // CQ DE W1AW: -.-. --.- / -.. . / .-- .---- .- .--
    const truth = truthSegments(TEXT, targetTiming(25, null), RATE);
    const marks = truth.filter((s) => s[0] === 1).length;
    expect(marks).toBe(25);
    // Opens and closes with the pad, so key-up runs bracket the keying.
    expect(truth[0]![0]).toBe(0);
    expect(truth[truth.length - 1]![0]).toBe(0);
  });

  it("puts every boundary on a real transition in the rendered audio", () => {
    // The sharp version of the claim, made against the waveform itself rather
    // than through the decoder. Each truth boundary is checked against the
    // sample where the rendered signal actually starts or stops, so a truth
    // that has drifted from the audio it describes fails here by however many
    // samples it drifted — not by however much the decoder happened to care.
    for (const [rate, wpm] of [[8000, 25], [22050, 22], [48000, 18]] as const) {
      const take = makeTake(TEXT, wpm, null, rate);
      const peak = take.samples.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
      const live = 0.01 * peak;

      // Ramp half-width, plus a sample for the crossing itself. A boundary
      // further out than this is describing the wrong part of the signal.
      const slack = Math.ceil(0.0025 * rate) + 2;

      // Peak over a window, never a single sample: the signal is a sine, so an
      // individual sample in the middle of a perfectly good mark can sit on a
      // zero crossing.
      const cycle = Math.ceil(rate / 600) + 1;
      const peakOver = (from: number, to: number) => {
        let p = 0;
        for (let i = Math.max(0, from); i < Math.min(to, take.samples.length); i++) {
          p = Math.max(p, Math.abs(take.samples[i]!));
        }
        return p;
      };

      let at = 0;
      for (const [state, dur] of take.truth) {
        const span = Math.round(dur * rate);
        if (state === 1 && span > 2 * slack) {
          const mid = at + (span >> 1);
          expect(peakOver(mid - cycle, mid + cycle), `mark at ${at} (rate ${rate})`).toBeGreaterThan(live);
          if (at - slack - cycle > 0) {
            expect(
              peakOver(at - slack - cycle, at - slack),
              `just before the mark at ${at} (rate ${rate})`,
            ).toBeLessThanOrEqual(live);
          }
          expect(
            peakOver(at + span + slack, at + span + slack + cycle),
            `just after the mark at ${at} (rate ${rate})`,
          ).toBeLessThanOrEqual(live);
        }
        at += span;
      }

      // And the whole plan accounts for the whole file, so nothing is missing
      // off the end.
      expect(Math.abs(at - take.samples.length), `total length at ${rate}`).toBeLessThanOrEqual(2);
    }
  });

  it("lands where the rendered audio actually is", () => {
    // The point of the whole file. If the plan and the waveform disagree, the
    // truth is fiction. Compared against the decoder on an unimpaired signal,
    // which should find exactly the same number of elements.
    const take = makeTake(TEXT, 25, null, RATE);
    const score = scoreAgainst(decodeTake(take).segments, take.truth);
    expect(score.countsMatch).toBe(true);
    expect(score.gotMarks).toBe(25);
    // Every mark is off by the same amount, because the only thing between the
    // plan and the measurement is the 5 ms raised-cosine ramp.
    expect(score.markScatterSec * 1000).toBeLessThan(0.2);
  });

  it("is offset from the decode only by the keying ramp", () => {
    // Worth pinning as a number, because it is the reason the sweep compares
    // against an unimpaired decode rather than against the truth: a perfect
    // decoder does not reproduce the plan, and calling that error would put a
    // 5 ms floor under every measurement.
    const take = makeTake(TEXT, 25, null, RATE);
    const score = scoreAgainst(decodeTake(take).segments, take.truth);
    expect(score.markBiasSec * 1000).toBeLessThan(0);
    expect(Math.abs(score.markBiasSec * 1000)).toBeLessThan(8);
    // What the marks lose, the gaps gain — the boundaries move, not the clock.
    expect(score.markBiasSec + score.gapBiasSec).toBeCloseTo(0, 3);
  });

  it("does not depend on the sample rate", () => {
    for (const rate of [8000, 22050, 48000]) {
      const take = makeTake(TEXT, 25, null, rate);
      const score = scoreAgainst(decodeTake(take).segments, take.truth);
      expect(score.countsMatch, `rate ${rate}`).toBe(true);
      expect(Math.abs(score.markBiasSec * 1000), `rate ${rate}`).toBeLessThan(8);
    }
  });
});

describe("the impairments do what they say", () => {
  it("scales noise to the signal-to-noise ratio requested", () => {
    for (const snrDb of [30, 20, 10]) {
      const clean = makeTake(TEXT, 25, null, RATE);
      const noisy = makeTake(TEXT, 25, null, RATE, { snrDb, seed: 5 });
      let sum = 0;
      for (let i = 0; i < clean.samples.length; i++) {
        const d = noisy.samples[i]! - clean.samples[i]!;
        sum += d * d;
      }
      const noiseRms = Math.sqrt(sum / clean.samples.length);
      expect(20 * Math.log10(clean.markLevel / noiseRms), `snr=${snrDb}`).toBeCloseTo(snrDb, 0);
    }
  });

  it("puts hum at the frequency and level asked for", () => {
    const clean = makeTake(TEXT, 25, null, RATE);
    const hummy = makeTake(TEXT, 25, null, RATE, { humHz: 60, humDb: -6, humHarmonics: 1 });
    let sum = 0;
    for (let i = 0; i < clean.samples.length; i++) {
      const d = hummy.samples[i]! - clean.samples[i]!;
      sum += d * d;
    }
    // A sine of amplitude A has RMS A/sqrt(2), and the level is specified
    // relative to the mark RMS.
    const humRms = Math.sqrt(sum / clean.samples.length);
    expect(20 * Math.log10(humRms / clean.markLevel)).toBeCloseTo(-6, 1);
  });

  it("offsets DC without touching the keying", () => {
    const clean = makeTake(TEXT, 25, null, RATE);
    const shifted = makeTake(TEXT, 25, null, RATE, { dcOffset: 0.5 });
    let sum = 0;
    for (let i = 0; i < clean.samples.length; i++) sum += shifted.samples[i]! - clean.samples[i]!;
    expect(sum / clean.samples.length).toBeCloseTo(0.5 * clean.markLevel, 4);
  });

  it("swings the level by the drift depth asked for", () => {
    // Worth pinning precisely, because drift turns out to be the axis the
    // current decoder is least able to survive — so the number had better mean
    // what the surface says it means.
    const depthDb = 6;
    const take = makeTake(TEXT, 25, null, RATE, { driftDb: depthDb, driftPeriodSec: 2 });
    const clean = makeTake(TEXT, 25, null, RATE);
    let hi = 0;
    let lo = Infinity;
    for (let i = 0; i < clean.samples.length; i++) {
      const c = Math.abs(clean.samples[i]!);
      if (c < 0.5) continue; // only where there is signal to measure
      const ratio = Math.abs(take.samples[i]!) / c;
      hi = Math.max(hi, ratio);
      lo = Math.min(lo, ratio);
    }
    // Either side of unity, so the full swing is twice the stated depth.
    expect(20 * Math.log10(hi)).toBeCloseTo(depthDb, 0);
    expect(20 * Math.log10(lo)).toBeCloseTo(-depthDb, 0);
  });

  it("makes the gain loop sag a long mark", () => {
    // The nonlinear case. A dah held at constant amplitude should come out of
    // an AGC with its tail quieter than its head, which is the artifact that
    // no amount of linear de-reverberation can undo.
    const take = makeTake("T", 15, null, RATE, {
      agc: { attackMs: 5, releaseMs: 300, target: 0.2, maxGainDb: 30 },
    });
    const mark = take.truth.findIndex((s) => s[0] === 1);
    let at = 0;
    for (let i = 0; i < mark; i++) at += Math.round(take.truth[i]![1] * RATE);
    const span = Math.round(take.truth[mark]![1] * RATE);
    const peakIn = (from: number, to: number) => {
      let p = 0;
      for (let i = from; i < to; i++) p = Math.max(p, Math.abs(take.samples[i]!));
      return p;
    };
    const head = peakIn(at + 200, at + span / 4);
    const tail = peakIn(at + (3 * span) / 4, at + span - 200);
    expect(tail).toBeLessThan(head * 0.9);
  });

  it("is reproducible from its seed", () => {
    const a = makeTake(TEXT, 25, null, RATE, { snrDb: 15, room: { rt60Sec: 0.2, drDb: 6 }, seed: 99 });
    const b = makeTake(TEXT, 25, null, RATE, { snrDb: 15, room: { rt60Sec: 0.2, drDb: 6 }, seed: 99 });
    expect(Array.from(a.samples.slice(0, 5000))).toEqual(Array.from(b.samples.slice(0, 5000)));
    const c = makeTake(TEXT, 25, null, RATE, { snrDb: 15, room: { rt60Sec: 0.2, drDb: 6 }, seed: 100 });
    expect(Array.from(c.samples.slice(0, 5000))).not.toEqual(Array.from(a.samples.slice(0, 5000)));
  });
});

describe("the synthetic room against the real recordings", () => {
  /* The generator is only worth anything if it reproduces what was measured in
     the field. These are the three reference numbers, from the envelope of the
     actual files:

       loopback capture   2.8 ms
       webcam microphone   29 ms
       condenser at range  91 ms

     and the claim is that ordinary room parameters land on them. */

  it("gives a clean signal the same fast edge the loopback capture has", () => {
    const take = makeTake(TEXT, 25, null, RATE, { room: { rt60Sec: 0, drDb: 0 } });
    expect(fallMs(take.samples, RATE)).toBeLessThan(5);
  });

  it("reaches the webcam recording's decay at ordinary room values", () => {
    // ~0.25 s reverberation, source well clear of the mic. A normal room.
    const take = makeTake(TEXT, 25, null, RATE, { room: { rt60Sec: 0.25, drDb: 10 }, seed: 7 });
    const fall = fallMs(take.samples, RATE);
    expect(fall).toBeGreaterThan(15);
    expect(fall).toBeLessThan(50);
  });

  it("reaches the condenser recording's decay at a livelier one", () => {
    const take = makeTake(TEXT, 25, null, RATE, { room: { rt60Sec: 0.4, drDb: 5 }, seed: 7 });
    expect(fallMs(take.samples, RATE)).toBeGreaterThan(50);
  });

  it("gets worse as the room gets livelier, not better", () => {
    // Monotonicity, averaged over several rooms, because one draw of a random
    // impulse response is one room and can be lucky.
    const at = (rt60Sec: number) => {
      const runs = [1, 2, 3, 4, 5].map(
        (seed) => fallMs(makeTake(TEXT, 25, null, RATE, { room: { rt60Sec, drDb: 6 }, seed }).samples, RATE),
      );
      return runs.reduce((a, b) => a + b, 0) / runs.length;
    };
    const dead = at(0.05);
    const live = at(0.3);
    expect(dead).toBeLessThan(live);
    expect(at(0)).toBeLessThan(dead);
  });
});
