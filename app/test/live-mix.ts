/* Audio for the Live decoder's tests: stations keyed at their own speeds,
 * pitches and strengths, laid on one track with band noise. */

import { synthesize } from "@/audio/synth";
import { seeded } from "@/audio/qsb";
import { targetTiming } from "@/timing";
import type { Fist } from "@/timing/fist";

export interface Keyed {
  readonly text: string;
  readonly wpm: number;
  readonly hz: number;
  /** Peak amplitude. */
  readonly amp: number;
  /** When it starts, seconds. */
  readonly at: number;
  readonly fist?: Fist;
  /** Edge length, ms. Short edges click. */
  readonly rampMs?: number;
}

/** Each line keyed and laid at its time, over noise at `noise` RMS. */
export function mix(lines: readonly Keyed[], rate = 48000, noise = 0.01, seed = 1): Float32Array {
  const parts = lines.map((l) => ({
    l,
    s: synthesize(l.text, targetTiming(l.wpm, l.wpm), {
      rate,
      toneHz: l.hz,
      amplitude: l.amp,
      padSec: 0,
      ...(l.rampMs !== undefined ? { rampMs: l.rampMs } : {}),
      ...(l.fist ? { fist: l.fist } : {}),
    }).samples,
  }));
  const end = Math.max(...parts.map((p) => Math.round(p.l.at * rate) + p.s.length)) + rate * 4;
  const out = new Float32Array(end);
  for (const p of parts) out.set(p.s.map((v, i) => v + out[Math.round(p.l.at * rate) + i]!), Math.round(p.l.at * rate));
  const rnd = seeded(seed);
  for (let i = 0; i < out.length; i++) {
    // Roughly Gaussian: the sum of a few uniforms.
    const g = (rnd() + rnd() + rnd() + rnd() - 2) * 1.73;
    out[i] = out[i]! + g * noise;
  }
  return out;
}

/** Where each line ends, for laying the next one after it. */
export function lineSec(text: string, wpm: number): number {
  return synthesize(text, targetTiming(wpm, wpm), { rate: 8000, padSec: 0 }).samples.length / 8000;
}

/** Lines one after another, each `gap` seconds after the last ends. */
export function inTurn(lines: readonly Omit<Keyed, "at">[], start = 0.5, gap = 1.2): Keyed[] {
  let at = start;
  return lines.map((l) => {
    const k = { ...l, at };
    at += lineSec(l.text, l.wpm) + gap;
    return k;
  });
}
