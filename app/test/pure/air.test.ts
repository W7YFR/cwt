/* The air between two stations: QSB, noise, QRN and QRM as made, a generated
 * QSO sent through them, and the recorder's gate that cuts the band the
 * moment you key.
 */

import { describe, expect, it } from "vitest";
import { bandNoise, fadeOf, NOISE_OFF_DB, noiseLevel, noiseOn, qrnCrashes } from "@/audio/qsb";
import { AGC_RISE_DB, agcGainDb, keyedGainDb, loudnessDb } from "@/audio/agc";
import { bandAudio, bandOn, QRM_OFF_DB, qrmOn, qrmPart } from "@/copy/band";
import { makeScript, qrmLines, sendScript } from "@/copy/generate";
import { WORKLET_SOURCE } from "@/capture/mic";

/** A fixed sequence, so each QSO is the same every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** How much of `x` is at `hz`: Goertzel's power, per sample. */
function power(x: Float32Array, rate: number, hz: number): number {
  const k = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i]! + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / x.length;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const peakOf = (x: Float32Array) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
const db = (gain: number) => Math.pow(10, gain / 20);

/** How many samples differ. A loop, not toEqual: a QSO is a million samples,
 *  and a deep compare of that many takes seconds on a busy runner. */
function differ(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

describe("QSB", () => {
  it("does nothing at 0 dB", () => {
    const fade = fadeOf(0, 1);
    for (let t = 0; t < 100; t += 0.37) expect(fade(t)).toBe(1);
  });

  it("stays between full and its depth, mostly near full, with deep troughs", () => {
    const fade = fadeOf(30, 42);
    const gains: number[] = [];
    for (let t = 0; t < 600; t += 0.05) gains.push(fade(t));
    for (const g of gains) {
      expect(g).toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThanOrEqual(db(-30) - 1e-9);
    }
    gains.sort((a, b) => a - b);
    // Half the time within a quarter of the depth.
    expect(gains[Math.floor(gains.length / 2)]!, "the median").toBeGreaterThan(db(-30 / 4) - 0.02);
    expect(gains[0]!, "the deepest trough").toBeLessThan(db(-15));
  });

  it("fades each station its own way, the same way each time", () => {
    const a = fadeOf(20, 7);
    const again = fadeOf(20, 7);
    const b = fadeOf(20, 8);
    let apart = 0;
    for (let t = 0; t < 60; t += 0.5) {
      expect(again(t)).toBe(a(t));
      apart = Math.max(apart, Math.abs(a(t) - b(t)));
    }
    expect(apart).toBeGreaterThan(0.1);
  });
});

describe("noise", () => {
  it("is off at the slider's lowest place", () => {
    expect(noiseOn(NOISE_OFF_DB)).toBe(false);
    expect(noiseLevel(0.8, NOISE_OFF_DB)).toBe(0);
    expect(noiseOn(NOISE_OFF_DB + 2)).toBe(true);
    expect(noiseLevel(0.8, -20)).toBeCloseTo(0.08);
  });

  it("is at its level, on the station's pitch", () => {
    const rate = 8000;
    const n = bandNoise(rate * 10, rate, 650, 0.05, 3);
    expect(rms(n)).toBeCloseTo(0.05, 4);
    expect(power(n, rate, 650)).toBeGreaterThan(10 * power(n, rate, 2500));
    expect(bandNoise(1000, rate, 650, 0.05, 3)).toEqual(bandNoise(1000, rate, 650, 0.05, 3));
  });

  it("is flat across the CW filter, and falls away steeply outside it", () => {
    const rate = 8000;
    const n = bandNoise(rate * 10, rate, 650, 0.05, 4);
    expect(power(n, rate, 500)).toBeGreaterThan(power(n, rate, 650) / 2);
    expect(power(n, rate, 800)).toBeGreaterThan(power(n, rate, 650) / 2);
    expect(power(n, rate, 1100)).toBeLessThan(power(n, rate, 650) / 1000);
    expect(power(n, rate, 200)).toBeLessThan(power(n, rate, 650) / 1000);
  });
});

describe("QRN", () => {
  const rate = 8000;
  const n = rate * 60;

  it("is silent when off", () => {
    expect(peakOf(qrnCrashes(n, rate, 650, 0, 0.8, 1))).toBe(0);
  });

  it("grows with the setting, under a crash's top", () => {
    const levels = [1, 2, 3, 4].map((q) => qrnCrashes(n, rate, 650, q, 0.8, 5));
    for (let i = 1; i < levels.length; i++) {
      expect(rms(levels[i]!), `setting ${i + 1}`).toBeGreaterThan(rms(levels[i - 1]!));
    }
    for (const l of levels) expect(peakOf(l)).toBeLessThanOrEqual(0.8 * 1.2 + 1e-6);
  });

  it("comes through the CW filter, on the pitch", () => {
    const q = qrnCrashes(n, rate, 650, 3, 0.8, 9);
    expect(power(q, rate, 650)).toBeGreaterThan(1000 * power(q, rate, 1500));
    expect(power(q, rate, 650)).toBeGreaterThan(1000 * power(q, rate, 150));
  });
});

describe("the band", () => {
  const rate = 8000;
  const base = { rate, toneHz: 645, peak: 0.8, qsbDb: 0, seed: 11, qrmLines };
  const off = { noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB };

  it("holds nothing with everything off", () => {
    expect(bandOn(off)).toBe(false);
    expect(qrmOn(QRM_OFF_DB)).toBe(false);
    expect(peakOf(bandAudio({ ...base, ...off, n: rate * 5 }))).toBe(0);
    expect(bandOn({ ...off, qrn: 1 })).toBe(true);
  });

  it("has QRM that comes and goes, as another QSO does", () => {
    const n = rate * 600;
    const b = bandAudio({ ...base, ...off, n, qrmDb: -6 });
    const win = rate / 10;
    let sounding = 0;
    for (let w = 0; w < n; w += win) if (peakOf(b.subarray(w, w + win)) > 0.01) sounding++;
    const share = sounding / (n / win);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.6);
  });

  it("has QRM inside the CW filter, at a pitch of its own", () => {
    const n = rate * 120;
    const b = bandAudio({ ...base, ...off, n, qrmDb: -6 });
    const near = [-250, -150, -50, 50, 150, 250].map((d) => power(b, rate, base.toneHz + d));
    expect(Math.max(...near)).toBeGreaterThan(1000 * power(b, rate, base.toneHz + 600));
  });

  it("has quieter QRM lower on its slider", () => {
    const n = rate * 120;
    const loud = bandAudio({ ...base, ...off, n, qrmDb: -6 });
    const quiet = bandAudio({ ...base, ...off, n, qrmDb: -26 });
    expect(peakOf(quiet)).toBeLessThan(peakOf(loud) / 5);
  });
});

describe("a generated QSO on the air", () => {
  const script = makeScript({ kind: "cq", rand: seeded(7), length: "short" });
  const everything = { qsbDb: 15, noiseDb: -20, qrn: 4, qrmDb: -6 };

  it("keeps its answer key and its length", () => {
    const clean = sendScript(script, { gapSec: 1 });
    const aired = sendScript(script, { gapSec: 1, ...everything });
    expect(aired.rec).toEqual(clean.rec);
    expect(aired.samples.length).toBe(clean.samples.length);
  });

  it("is the clean QSO with everything off", () => {
    const clean = sendScript(script, { gapSec: 1 });
    const off = sendScript(script, { gapSec: 1, qsbDb: 0, noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB });
    expect(differ(off.samples, clean.samples)).toBe(0);
  });

  it("never reaches full scale, and is the same each time", () => {
    const a = sendScript(script, { gapSec: 1, ...everything });
    expect(peakOf(a.samples)).toBeLessThan(1);
    expect(differ(sendScript(script, { gapSec: 1, ...everything }).samples, a.samples)).toBe(0);
  });
});

describe("FT8 in the QRM", () => {
  const rate = 4000;
  const ft8 = qrmPart({ n: rate * 600, rate, toneHz: 600, peak: 0.5, qrn: 0, qsbDb: 0, seed: 21, qrmLines: () => [] });
  const loudIn = (from: number, to: number) => rms(ft8.subarray(Math.round(from * rate), Math.round(to * rate)));

  it("sends in its 15 s slots, from 0.5 s in for 12.6 s, and is quiet after", () => {
    const slots = Array.from({ length: 40 }, (_, k) => k * 15);
    const sending = slots.filter((at) => loudIn(at + 1, at + 13) > 0.01);
    expect(sending.length).toBeGreaterThan(0);
    for (const at of sending) expect(loudIn(at + 13.3, at + 15.3), `slot at ${at} s`).toBeLessThan(loudIn(at + 1, at + 13) / 100);
  });

  it("comes and goes", () => {
    const quiet = Array.from({ length: 40 }, (_, k) => k * 15).filter((at) => loudIn(at, at + 15) < 1e-4);
    expect(quiet.length).toBeGreaterThan(5);
  });
});

describe("the AGC", () => {
  const rate = 12000;
  /** Noise 25 dB under a tone that is on from 1 s to 2 s, and its gain. */
  const gain = (mode: "off" | "slow" | "fast") => {
    const n = 4 * rate;
    const noise = bandNoise(n, rate, 600, 0.5 * db(-25), 1);
    const x = noise.map((v, i) => v + (i >= rate && i < 2 * rate ? 0.5 * Math.sin((2 * Math.PI * 600 * i) / rate) : 0));
    const g = agcGainDb(loudnessDb(x, rate, 0.5), mode);
    return (t: number) => g[Math.round(t / 0.001)]!;
  };

  it("turns the band down under a strong signal, and fast brings it back in about 80 ms", () => {
    const g = gain("fast");
    expect(g(0.9) - g(1.5)).toBeGreaterThan(12);
    expect(g(1.5)).toBeLessThanOrEqual(0);
    expect(g(2.1)).toBeGreaterThan(g(0.9) - 4);
  });

  it("brings it back slowly at Slow, and leaves it alone at Off", () => {
    const g = gain("slow");
    expect(g(2.1)).toBeLessThan(g(0.9) - 8);
    expect(g(3.5)).toBeGreaterThan(g(0.9) - 4);
    const off = gain("off");
    expect([0.9, 1.5, 2.1].map(off)).toEqual([0, 0, 0]);
  });

  /** A band 30 dB under the station all through its loop, with `loud`
   *  from `from` to `to` seconds. */
  const bandOf = (loud = -30, from = 0, to = 0) => {
    const loudDb = new Float32Array(3000).map((_, j) => (j >= from * 1000 && j < to * 1000 ? loud : -30));
    return { loudDb, gainDb: agcGainDb(loudDb, "fast") };
  };

  it("is down before a mark starts, under a keyed station, and up between words", () => {
    const g = keyedGainDb([[0.5, 0.6], [1.5, 1.6]], 2, () => 1, bandOf(), 0, "fast");
    const at = (t: number) => g[Math.round(t / 0.001)]!;
    expect(at(0.495)).toBeLessThan(1);
    expect(at(0.55)).toBeLessThan(1);
    expect(at(1.2)).toBeCloseTo(AGC_RISE_DB, 0);
  });

  it("evens out a station that fades, up to how loud the band is", () => {
    const g = keyedGainDb([[0, 2]], 2, () => db(-12), bandOf(), 0, "fast");
    expect(g[1000]).toBeGreaterThan(10);
  });

  it("turns the station down under a burst on the band as loud as it, where the band is in its loop", () => {
    // The burst is 1.5 s to 1.7 s into the loop; the line starts 1 s in.
    const g = keyedGainDb([[0, 2]], 2, () => 1, bandOf(0, 1.5, 1.7), 1000, "fast");
    expect(g[600]).toBeLessThan(-4);
    expect(g[200]).toBeGreaterThan(-1);
  });

  it("puts the band of a generated QSO under the station, and up between its lines", () => {
    const script = makeScript({ kind: "cq", rand: seeded(7), length: "short" });
    const sent = (agc: "off" | "fast") => sendScript(script, { gapSec: 3, noiseDb: -30, agc, rate: 8000 });
    const off = sent("off");
    const fast = sent("fast");
    // Quiet between the first two lines.
    const gap = (x: Float32Array) => {
      const t = off.rec.overs[0]!.t1 + 1;
      return rms(x.subarray(Math.round(t * 8000), Math.round((t + 1) * 8000)));
    };
    expect(gap(fast.samples)).toBeGreaterThan(4 * gap(off.samples));
    expect(peakOf(fast.samples)).toBeLessThan(1);
  });
});

describe("the band gate", () => {
  const sampleRate = 48000;
  const BLOCK = 128;

  /** The gate's worklet, on a stand-in audio thread. */
  function gate() {
    const procs: Record<string, new () => { port: { onmessage: (ev: { data: unknown }) => void }; process: Function }> = {};
    class AudioWorkletProcessor {
      port = { postMessage() {}, onmessage: (_ev: { data: unknown }) => {} };
    }
    // The audio thread's clock, on as each block plays.
    let frames = 0;
    const clock = { get currentTime() { return frames / sampleRate; } };
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", "clock", `with (clock) {${WORKLET_SOURCE}}`)(
      AudioWorkletProcessor,
      (name: string, ctor: (typeof procs)[string]) => (procs[name] = ctor),
      sampleRate,
      0,
      clock,
    );
    const g = new procs["cw-band-gate"]!();
    const send = (data: unknown) => g.port.onmessage({ data });
    send({ type: "band", samples: bandNoise(12000, 12000, 645, 0.3, 1), rate: 12000 });
    send({ type: "level", level: 1 });
    let k = 0;
    /** One block through the gate: the key down or up. Its output. */
    const block = (keyed: boolean): Float32Array => {
      const mic = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        mic[i] = keyed ? 0.3 * Math.sin((2 * Math.PI * 600 * (k * BLOCK + i)) / sampleRate) : 0.0005 * Math.sin(i);
      }
      k++;
      const out = new Float32Array(BLOCK);
      g.process([[mic]], [[out]]);
      frames += BLOCK;
      return out;
    };
    return { send, block };
  }
  const blocksIn = (sec: number) => Math.ceil((sec * sampleRate) / BLOCK);

  it("cuts within the first block you key", () => {
    const { send, block } = gate();
    send({ type: "arm", armed: true });
    send({ type: "delay", sec: 0.3 });
    for (let i = 0; i < blocksIn(0.2); i++) block(false);
    expect(peakOf(block(false)), "the band before").toBeGreaterThan(0.1);
    const first = block(true);
    // Down in a millisecond: the end of the first keyed block is silent.
    expect(peakOf(first.subarray(BLOCK / 2))).toBe(0);
    expect(peakOf(block(true))).toBe(0);
  });

  it("comes back after the break-in delay, and not before", () => {
    for (const delay of [0, 0.3, 0.8]) {
      const { send, block } = gate();
      send({ type: "arm", armed: true });
      send({ type: "delay", sec: delay });
      for (let i = 0; i < blocksIn(0.2); i++) block(false);
      block(true);
      let back = -1;
      for (let i = 0; i < blocksIn(2); i++) {
        if (peakOf(block(false)) > 0.05) {
          back = i;
          break;
        }
      }
      expect(back, `delay ${delay}`).toBeGreaterThanOrEqual(blocksIn(delay) - 1);
      expect(back, `delay ${delay}`).toBeLessThanOrEqual(blocksIn(delay) + 1);
    }
  });

  it("does not cut while it is not armed", () => {
    const { send, block } = gate();
    send({ type: "delay", sec: 0.3 });
    for (let i = 0; i < blocksIn(0.2); i++) block(false);
    expect(peakOf(block(true))).toBeGreaterThan(0.1);
  });

  it("plays from where its clock is, so a band mixed again plays on", () => {
    const { send, block } = gate();
    const ramp = (k: number) => Float32Array.from({ length: 12000 }, (_, i) => (k * i) / 12000);
    send({ type: "band", samples: ramp(1), rate: 12000 });
    let last = 0;
    for (let i = 0; i < blocksIn(0.5); i++) last = block(false).at(-1)!;
    expect(last).toBeGreaterThan(0.4);
    send({ type: "band", samples: ramp(0.5), rate: 12000 });
    expect(block(false)[0]).toBeCloseTo(last / 2, 2);
  });

  it("takes the AGC's gain while a station keys, and is back to full after it", () => {
    const { send, block } = gate();
    send({ type: "band", samples: new Float32Array(12000).fill(0.5), rate: 12000 });
    for (let i = 0; i < blocksIn(0.1); i++) block(false);
    // From now, for 0.1 s.
    send({ type: "duck", gain: new Float32Array(100).fill(0.25), step: 0.001, at: blocksIn(0.1) * BLOCK / sampleRate });
    expect(peakOf(block(false))).toBeCloseTo(0.125, 3);
    send({ type: "duck", gain: null, step: 0.001, at: 0 });
    expect(peakOf(block(false))).toBeCloseTo(0.5, 3);
  });

  it("is silent with no band, or at no level", () => {
    const { send, block } = gate();
    send({ type: "level", level: 0 });
    for (let i = 0; i < blocksIn(0.1); i++) block(false);
    expect(peakOf(block(false))).toBe(0);
    send({ type: "level", level: 1 });
    send({ type: "band", samples: null, rate: 0 });
    for (let i = 0; i < blocksIn(0.1); i++) block(false);
    expect(peakOf(block(false))).toBe(0);
  });
});
