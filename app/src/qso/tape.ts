/* A QSO as one piece of audio, to play again or to download.
 *
 * The station's lines are made again from their text, at the speed and tone
 * they were sent at. Your lines are your own recording, with the wait before
 * you keyed and the quiet after taken out. Each line is brought to the same
 * level, and a short pause goes between them.
 *
 * As heard, the station's lines fade with QSB, and the band (noise, QRN and
 * QRM) runs under the QSO, but not under your lines: a radio does not
 * receive while it sends. The tape knows where each of your lines is, so
 * the band cuts at its first sound and comes back after its last, with a
 * short ramp each way. Made again, so not the same fading and noise heard
 * live, but the same settings.
 *
 * Pure. The page plays it and saves it.
 */

import { fadeOf, seedOf } from "@/audio/qsb";
import { synthesize } from "@/audio/synth";
import { addBand, bandOn, type QrmLine } from "@/copy/band";
import { targetTiming } from "@/timing";
import type { Speed } from "./speed";

export interface Clip {
  readonly samples: Float32Array;
  readonly rate: number;
}

/** One line of the QSO, as the tape needs it. */
export type TapeLine =
  | { readonly you: false; readonly text: string; readonly speed: Speed; readonly toneHz: number; readonly call: string }
  | { readonly you: true; readonly clip: Clip };

/** The level every line is brought to. */
const PEAK = 0.5;

/** Quiet kept before and after the sound in your line, seconds. */
const EDGE_SEC = 0.3;

/** A longer quiet inside your line is cut to this, seconds. */
const GAP_SEC = 1;

/** How long the band takes to cut and to come back around your line,
 *  seconds: short, but long enough not to click. */
const RAMP_SEC = 0.008;

/** The pause between one line and the next, seconds. */
const BETWEEN_SEC = 0.6;

/** Windows the sound is found in, seconds. */
const WINDOW_SEC = 0.01;

/** A window is sound when its peak is this share of the clip's peak. */
const SOUND_SHARE = 0.1;

/** `clip` with the quiet at its ends cut to `EDGE_SEC`, and each quiet inside
 *  it longer than `GAP_SEC` cut to that. A clip with no sound comes back
 *  empty. */
export function trimmed(clip: Clip): Clip {
  const { samples, rate } = clip;
  const win = Math.max(1, Math.round(WINDOW_SEC * rate));
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  if (!(peak > 0)) return { samples: new Float32Array(0), rate };
  const sound: boolean[] = [];
  for (let at = 0; at < samples.length; at += win) {
    let p = 0;
    for (let i = at; i < Math.min(at + win, samples.length); i++) p = Math.max(p, Math.abs(samples[i]!));
    sound.push(p >= SOUND_SHARE * peak);
  }
  const first = sound.indexOf(true);
  const last = sound.lastIndexOf(true);
  const edge = Math.round(EDGE_SEC / WINDOW_SEC);
  const gap = Math.round(GAP_SEC / WINDOW_SEC);
  const keep: number[] = [];
  let quiet = 0;
  for (let w = Math.max(0, first - edge); w <= Math.min(sound.length - 1, last + edge); w++) {
    quiet = sound[w] ? 0 : quiet + 1;
    if (w > first && w < last && quiet > gap) continue;
    keep.push(w);
  }
  const out = new Float32Array(keep.length * win);
  let n = 0;
  for (const w of keep) {
    const part = samples.subarray(w * win, Math.min((w + 1) * win, samples.length));
    out.set(part, n);
    n += part.length;
  }
  return { samples: out.subarray(0, n), rate };
}

/** `clip` at `rate`, by straight-line steps between its samples. */
export function resampled(clip: Clip, rate: number): Clip {
  if (clip.rate === rate) return clip;
  const n = Math.floor((clip.samples.length * rate) / clip.rate);
  const out = new Float32Array(n);
  const step = clip.rate / rate;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = clip.samples[j] ?? 0;
    const b = clip.samples[j + 1] ?? a;
    out[i] = a + (b - a) * (x - j);
  }
  return { samples: out, rate };
}

/** `samples` brought to a peak of `PEAK`. */
function leveled(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  if (!(peak > 0)) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i]! / peak) * PEAK;
  return out;
}

/** One line on its own, at `rate`, ready to play. */
export function lineAudio(line: TapeLine, rate: number): Clip {
  if (!line.you) {
    const timing = targetTiming(line.speed.charWpm, line.speed.farnsworthWpm);
    const made = synthesize(line.text, timing, { rate, toneHz: line.toneHz, padSec: 0.1 });
    return { samples: leveled(made.samples), rate };
  }
  return { samples: leveled(resampled(trimmed(line.clip), rate).samples), rate };
}

/** What was added to the station as it was heard: its fading, and the band
 *  under it. */
export interface Added {
  readonly qsbDb: number;
  readonly noiseDb: number;
  readonly qrn: number;
  readonly qrmDb: number;
  readonly seed: number;
  readonly qrmLines: (rand: () => number) => readonly QrmLine[];
}

/** The whole QSO, one line after another, at `rate`. With `added`, as heard. */
export function tape(lines: readonly TapeLine[], rate: number, added?: Added): Clip {
  const parts = lines
    .map((line) => ({ line, samples: lineAudio(line, rate).samples }))
    .filter((p) => p.samples.length > 0);
  const pause = Math.round(BETWEEN_SEC * rate);
  const total = parts.reduce((t, p) => t + p.samples.length, 0) + pause * Math.max(0, parts.length - 1);
  const out = new Float32Array(total);
  /** Where each of your lines is, start and end, in samples. */
  const yours: [number, number][] = [];
  let at = 0;
  parts.forEach(({ line, samples }, i) => {
    if (i > 0) at += pause;
    if (line.you) {
      // From its first sound to its last, not the quiet kept at its ends.
      let first = -1;
      let last = -1;
      for (let j = 0; j < samples.length; j++) {
        if (Math.abs(samples[j]!) < SOUND_SHARE * PEAK) continue;
        if (first < 0) first = j;
        last = j;
      }
      if (first >= 0) yours.push([at + first, at + last + 1]);
    }
    if (added && added.qsbDb > 0 && !line.you) {
      const fade = fadeOf(added.qsbDb, seedOf(line.call));
      for (let j = 0; j < samples.length; j++) samples[j]! *= fade((at + j) / rate);
    }
    out.set(samples, at);
    at += samples.length;
  });
  if (added) {
    const theirs = lines.find((l) => !l.you);
    addBand(out, { ...added, rate, toneHz: theirs && !theirs.you ? theirs.toneHz : 600, peak: PEAK }, bandLevel(total, yours, rate));
  }
  return { samples: out, rate };
}

/** The band's level at each of `n` samples: 1, and 0 over each of `spans`,
 *  ramped down just before it and up just after. */
export function bandLevel(n: number, spans: readonly [number, number][], rate: number): Float32Array {
  const level = new Float32Array(n).fill(1);
  const ramp = Math.max(1, Math.round(RAMP_SEC * rate));
  for (const [from, to] of spans) {
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) level[i] = 0;
    for (let k = 1; k <= ramp; k++) {
      const g = k / (ramp + 1);
      if (from - k >= 0) level[from - k] = Math.min(level[from - k]!, g);
      if (to - 1 + k < n) level[to - 1 + k] = Math.min(level[to - 1 + k]!, g);
    }
  }
  return level;
}

/** Whether anything is added to a QSO as it is heard. */
export function anyAdded(a: Pick<Added, "qsbDb" | "noiseDb" | "qrn" | "qrmDb">): boolean {
  return a.qsbDb > 0 || bandOn(a);
}
