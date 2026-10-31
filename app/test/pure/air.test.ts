/* The air between two stations: QSB, noise, QRN and QRM as made, a generated
 * QSO sent through them, and the recorder's gate that cuts the band the
 * moment you key.
 */

import { describe, expect, it } from "vitest";
import { bandNoise, fadeOf, NOISE_OFF_DB, noiseLevel, noiseOn, qrnCrashes } from "@/audio/qsb";
import { bandAudio, bandOn, QRM_OFF_DB, qrmOn } from "@/copy/band";
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
});

describe("QRN", () => {
  const rate = 8000;
  const n = rate * 60;

  it("is silent when off", () => {
    expect(peakOf(qrnCrashes(n, rate, 0, 0.8, 1))).toBe(0);
  });

  it("grows with the setting, under a crash's top", () => {
    const levels = [1, 2, 3, 4].map((q) => qrnCrashes(n, rate, q, 0.8, 5));
    for (let i = 1; i < levels.length; i++) {
      expect(rms(levels[i]!), `setting ${i + 1}`).toBeGreaterThan(rms(levels[i - 1]!));
    }
    for (const l of levels) expect(peakOf(l)).toBeLessThanOrEqual(0.8 * 1.2 + 1e-6);
  });

  it("is in the receiver's passband, not under it", () => {
    const q = qrnCrashes(n, rate, 3, 0.8, 9);
    expect(power(q, rate, 1000)).toBeGreaterThan(10 * power(q, rate, 60));
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

describe("the band gate", () => {
  const sampleRate = 48000;
  const BLOCK = 128;

  /** The gate's worklet, on a stand-in audio thread. */
  function gate() {
    const procs: Record<string, new () => { port: { onmessage: (ev: { data: unknown }) => void }; process: Function }> = {};
    class AudioWorkletProcessor {
      port = { postMessage() {}, onmessage: (_ev: { data: unknown }) => {} };
    }
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", WORKLET_SOURCE)(
      AudioWorkletProcessor,
      (name: string, ctor: (typeof procs)[string]) => (procs[name] = ctor),
      sampleRate,
      0,
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
