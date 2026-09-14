/* Render CW as a waveform. No Web Audio — just samples.
 *
 * Two callers with different needs, one implementation so they cannot drift:
 * the target-audio download wants a file, and the tests want a signal
 * reproducible to the sample, so a decode can be compared against a recorded
 * fingerprint of the exact input it was measured from. The second use is why
 * the per-segment sample truncation below is spelled out rather than left to
 * whatever rounding happens to fall out.
 *
 * Realtime playback does NOT go through here — it schedules an oscillator, so
 * moving the speed slider re-renders instantly. `audio/scheduler.ts` builds
 * that schedule from the same timeline this reads, which is what keeps what
 * you hear and what you download the same performance.
 */

import type { Timing } from "@/types";
import { CHAR_TO_MORSE, keyableSymbols } from "@/morse";

export interface SynthOptions {
  readonly toneHz?: number;
  readonly rate?: number;
  /** Raised-cosine edge length. 5 ms is soft enough not to click and sharp
   *  enough that a 40 wpm dit still reads as a dit. */
  readonly rampMs?: number;
  /** Silence added before and after, seconds. */
  readonly padSec?: number;
  /** Peak amplitude of the rendered tone. */
  readonly amplitude?: number;
}

/** The on/off plan for `text` at `timing`, as (isOn, seconds) runs. */
export function keyingPlan(
  text: string,
  timing: Timing,
): Array<readonly [boolean, number]> {
  const unit = timing.unitSec;
  const charGap = timing.charGapSec || 3 * unit;
  const wordGap = timing.wordGapSec || 7 * unit;

  const plan: Array<readonly [boolean, number]> = [];
  const words = text.toUpperCase().split(/\s+/).filter((w) => w.length > 0);

  words.forEach((word, wi) => {
    if (wi > 0) plan.push([false, wordGap]);
    keyableSymbols(word).forEach((ch, li) => {
      if (li > 0) plan.push([false, charGap]);
      const pattern = CHAR_TO_MORSE[ch]!;
      for (let ei = 0; ei < pattern.length; ei++) {
        if (ei > 0) plan.push([false, unit]);
        plan.push([true, pattern[ei] === "." ? unit : 3 * unit]);
      }
    });
  });
  return plan;
}

/** Render `text` as a CW waveform at `timing`. */
export function synthesize(
  text: string,
  timing: Timing,
  options: SynthOptions = {},
): { samples: Float32Array; rate: number } {
  const rate = options.rate ?? 8000;
  const toneHz = options.toneHz ?? 600;
  const rampMs = options.rampMs ?? 5;
  const pad = options.padSec ?? 0.1;
  const amplitude = options.amplitude ?? 1;

  const plan: Array<readonly [boolean, number]> = [
    [false, pad],
    ...keyingPlan(text, timing),
    [false, pad],
  ];

  // Sum the durations first and truncate once, then truncate each span as it
  // is laid down. The two truncations do not commute — doing it any other way
  // puts the last sample in a different place, and the whole point of
  // rendering here rather than scheduling is that it comes out the same every
  // time.
  const total = plan.reduce((a, [, d]) => a + d, 0);
  const n = Math.trunc(total * rate);
  const env = new Float32Array(n);

  let at = 0;
  for (const [isOn, dur] of plan) {
    const span = Math.trunc(dur * rate);
    if (isOn && span > 0) {
      const end = Math.min(at + span, n);
      for (let i = at; i < end; i++) env[i] = 1;
    }
    at += span;
  }

  // Raised-cosine edges, applied to the square envelope in place.
  const ramp = Math.trunc((rampMs / 1000) * rate);
  if (ramp > 1) {
    const shape = new Float32Array(ramp);
    for (let i = 0; i < ramp; i++) {
      shape[i] = (1 - Math.cos((Math.PI * i) / (ramp - 1))) / 2;
    }
    // Edge indices from the difference of the envelope, padded either side —
    // `rise` is the first sample of a mark, `fall` the first sample after it.
    const rises: number[] = [];
    const falls: number[] = [];
    let prev = 0;
    for (let i = 0; i <= n; i++) {
      const cur = i < n ? env[i]! : 0;
      if (cur > prev) rises.push(i);
      else if (cur < prev) falls.push(i);
      prev = cur;
    }
    for (const r of rises) {
      const len = Math.min(ramp, n - r);
      for (let i = 0; i < len; i++) env[r + i] = shape[i]!;
    }
    for (const f of falls) {
      const s = Math.max(f - ramp, 0);
      const len = f - s;
      for (let i = 0; i < len; i++) env[s + i] = shape[len - 1 - i]!;
    }
  }

  const samples = new Float32Array(n);
  const w = (2 * Math.PI * toneHz) / rate;
  for (let i = 0; i < n; i++) samples[i] = env[i]! * Math.sin(w * i);

  if (amplitude !== 1) {
    for (let i = 0; i < n; i++) samples[i] = samples[i]! * amplitude;
  }
  return { samples, rate };
}

/** Peak-normalize in place: the last step, so a rendered file lands at full
 *  scale whatever the tone and envelope did on the way. */
export function peakNormalize(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  if (!(peak > 0) || Math.abs(peak - 1) < 1e-12) return samples;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! / peak;
  return samples;
}
