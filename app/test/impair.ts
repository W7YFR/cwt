/* Synthetic bad audio, with the answer known exactly.
 *
 * Three real microphone recordings can tell you that something is broken. They
 * cannot tell you *where* it breaks, because there are only three of them and
 * none comes with ground truth — the best available reference is a loopback
 * capture of the same sending, which is a proxy for the truth rather than the
 * truth itself.
 *
 * So the corpus that drives the work is generated: a clean signal whose every
 * element boundary is known to the sample, then impaired one axis at a time.
 * When a decode fails, the axis and the amount are both known, and the result
 * is a surface — "clean up to this much reverberation at this much noise" —
 * rather than a pass mark on somebody's webcam.
 *
 * Everything here is deterministic. Noise comes from a seeded generator, so a
 * failing case can be reproduced exactly from its parameters.
 *
 * What this deliberately does NOT claim to be is a simulation of any
 * particular room or microphone. It is a set of independent, physically
 * plausible stressors, and its job is to find the edges of the decoder's
 * competence. Real rooms are the acceptance test; this is the workbench.
 */

import type { Segment, Timing } from "@/types";
import { keyingPlan, synthesize, peakNormalize } from "@/audio/synth";
import { segmentsFrom } from "@/dsp";
import { targetTiming } from "@/timing/model";
import { normalizePeak } from "./wav";

/* ---------------------------------------------------------------- randomness */

/** mulberry32. Small, fast, and good enough for noise — and seeded, which is
 *  the only property that actually matters here. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. Returns one standard normal per call. */
export function gaussian(rand: () => number): number {
  // Guard the log: mulberry32 can return exactly 0.
  const u = Math.max(rand(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/* ----------------------------------------------------------------------- fft */

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-two length.
 *
 * Twiddles come from a precomputed table rather than an incremental rotation:
 * the recurrence drifts over a 2^19-point transform, and a reverb tail built
 * from a drifting transform would not have the decay it was asked for. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = sign * Math.sin((2 * Math.PI * k) / n);
  }

  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    const h = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const cr = cos[k * step]!;
        const ci = sin[k * step]!;
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + h]!;
        const bi = im[i + k + h]!;
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        re[i + k] = ar + vr;
        im[i + k] = ai + vi;
        re[i + k + h] = ar - vr;
        im[i + k + h] = ai - vi;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/** `x` convolved with `h`, truncated back to the length of `x`.
 *
 * Truncating rather than keeping the full tail is deliberate: h[0] is the
 * direct path, so output sample i stays aligned with input sample i and the
 * ground-truth boundaries still mean what they say. The signal is padded with
 * silence at both ends, so the discarded tail is the tail of that padding. */
export function convolve(x: Float32Array, h: Float64Array): Float32Array {
  if (h.length <= 1) {
    const out = new Float32Array(x.length);
    const g = h[0] ?? 1;
    for (let i = 0; i < x.length; i++) out[i] = x[i]! * g;
    return out;
  }

  let size = 1;
  while (size < x.length + h.length - 1) size <<= 1;

  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  const hr = new Float64Array(size);
  const hi = new Float64Array(size);
  xr.set(x);
  hr.set(h);

  fft(xr, xi, false);
  fft(hr, hi, false);
  for (let i = 0; i < size; i++) {
    const ar = xr[i]!;
    const ai = xi[i]!;
    const br = hr[i]!;
    const bi = hi[i]!;
    xr[i] = ar * br - ai * bi;
    xi[i] = ar * bi + ai * br;
  }
  fft(xr, xi, true);

  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = xr[i]!;
  return out;
}

/* -------------------------------------------------------------------- a room */

export interface RoomOptions {
  /** Time for the tail to fall 60 dB. 0 disables the room entirely. */
  readonly rt60Sec: number;
  /** Direct-to-reverberant energy ratio, dB. This is the parameter that sets
   *  how *tall* the tail is next to the mark, which is what decides whether a
   *  gap ever reaches silence. Close mic in a dead room is 20+; a laptop mic
   *  across a tiled kitchen is near 0. */
  readonly drDb: number;
}

/** An exponentially-decaying noise impulse response.
 *
 * The standard synthetic room: a direct impulse followed by dense incoherent
 * reflections whose energy decays exponentially. Incoherence is the important
 * part — a tail built from delayed *copies* would add coherently with the
 * direct sound and change the mark's amplitude rather than extending it. */
export function roomImpulse(
  rate: number,
  opts: RoomOptions,
  rand: () => number,
): Float64Array {
  if (!(opts.rt60Sec > 0)) return Float64Array.of(1);

  const n = Math.max(2, Math.round(opts.rt60Sec * rate));
  const tail = new Float64Array(n);
  // -60 dB (amplitude 1e-3) exactly at rt60.
  const k = Math.log(1e-3) / n;
  let energy = 0;
  for (let i = 1; i < n; i++) {
    const v = gaussian(rand) * Math.exp(k * i);
    tail[i] = v;
    energy += v * v;
  }

  const h = new Float64Array(n);
  h[0] = 1; // the direct path, by definition unity
  if (energy > 0) {
    const g = Math.sqrt(Math.pow(10, -opts.drDb / 10) / energy);
    for (let i = 1; i < n; i++) h[i] = tail[i]! * g;
  }
  return h;
}

/* ------------------------------------------------------------- other insults */

export interface AgcOptions {
  readonly attackMs: number;
  readonly releaseMs: number;
  /** Level the loop drives toward, as a fraction of full scale. */
  readonly target: number;
  /** Ceiling on the gain it may apply, dB — what stops it amplifying silence
   *  to full scale between elements. */
  readonly maxGainDb: number;
}

/** A compressor riding the signal, of the kind built into consumer mics.
 *
 * This one is nonlinear on purpose. Reverberation can be subtracted because it
 * is a linear filter; automatic gain cannot, and a pipeline that assumes
 * linearity needs a case that violates it. It shows up as a mark whose level
 * sags over its own length and a gap whose noise floor swells. */
export function applyAgc(
  x: Float32Array,
  rate: number,
  o: AgcOptions,
): Float32Array {
  const out = new Float32Array(x.length);
  const aAtt = Math.exp(-1 / ((o.attackMs / 1000) * rate));
  const aRel = Math.exp(-1 / ((o.releaseMs / 1000) * rate));
  const maxGain = Math.pow(10, o.maxGainDb / 20);
  let level = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    // Fast to catch a rising edge, slow to let go — the behavior that makes a
    // gap's floor creep up after a loud mark.
    const a = v > level ? aAtt : aRel;
    level = a * level + (1 - a) * v;
    const g = level > 1e-9 ? Math.min(o.target / level, maxGain) : maxGain;
    out[i] = x[i]! * g;
  }
  return out;
}

/** Slow amplitude wander — someone drifting toward or away from the mic.
 *
 * `depthDb` is the swing either side of unity, so 3 means the signal ranges
 * over 6 dB peak to peak: a factor of two between the loudest mark and the
 * quietest. That is a person shifting in a chair, not an event. */
export function applyDrift(
  x: Float32Array,
  rate: number,
  depthDb: number,
  periodSec: number,
): Float32Array {
  const out = new Float32Array(x.length);
  const depth = Math.pow(10, depthDb / 20);
  for (let i = 0; i < x.length; i++) {
    const phase = (2 * Math.PI * i) / (periodSec * rate);
    // Geometric about 1, so +6 dB and -6 dB are the same distance away.
    out[i] = x[i]! * Math.pow(depth, Math.sin(phase));
  }
  return out;
}

/* ------------------------------------------------------------------- a take */

export interface Impairments {
  readonly room?: RoomOptions;
  /** Broadband noise, dB relative to the level of a keyed mark. */
  readonly snrDb?: number;
  /** Mains hum. `humDb` is relative to a mark, so -6 is half a mark's
   *  amplitude — which is roughly what the webcam recording carries. */
  readonly humHz?: number;
  readonly humDb?: number;
  readonly humHarmonics?: number;
  /** Constant offset, as a fraction of a mark's amplitude. */
  readonly dcOffset?: number;
  readonly driftDb?: number;
  readonly driftPeriodSec?: number;
  readonly agc?: AgcOptions;
  readonly seed?: number;
}

export interface Take {
  readonly samples: Float32Array;
  readonly rate: number;
  readonly text: string;
  readonly timing: Timing;
  /** Exactly where the keying is, from the plan the renderer laid down. */
  readonly truth: readonly Segment[];
  /** Amplitude of a keyed mark before anything was done to the signal. */
  readonly markLevel: number;
}

const PAD_SEC = 0.2;

/** Where every boundary really is, to the sample.
 *
 * Rebuilds the renderer's own accumulation, including its per-span truncation.
 * Summing the nominal durations instead would drift by a sample every few
 * elements, and a ground truth that is wrong by a sample is worse than none. */
export function truthSegments(
  text: string,
  timing: Timing,
  rate: number,
): Segment[] {
  const plan: Array<readonly [boolean, number]> = [
    [false, PAD_SEC],
    ...keyingPlan(text, timing),
    [false, PAD_SEC],
  ];
  // Accumulated in samples, as integers, and converted to seconds only on the
  // way out — so the merge below adds sample counts rather than compounding
  // the rounding of two divisions.
  const runs: Array<[0 | 1, number]> = [];
  let laid = 0;
  for (const [isOn, dur] of plan) {
    const span = Math.trunc(dur * rate);
    if (span <= 0) continue;
    laid += span;
    const state: 0 | 1 = isOn ? 1 : 0;
    const last = runs[runs.length - 1];
    // The renderer emits no two adjacent spans of the same state, but merging
    // defensively means a change to keyingPlan cannot silently desynchronize
    // the truth from the audio.
    if (last && last[0] === state) last[1] += span;
    else runs.push([state, span]);
  }

  // The renderer sizes its buffer from the truncated *total*, then lays down
  // each span truncated on its own — and the two do not agree, because
  // truncating once is not truncating fifty times. The leftover is trailing
  // silence, so the closing key-up run owns it. Without this the last gap in
  // the truth is a millisecond shorter than the one in the file, which is
  // small, real, and would quietly bias every gap measurement taken against it.
  const total = Math.trunc(plan.reduce((a, [, d]) => a + d, 0) * rate);
  const tail = total - laid;
  const last = runs[runs.length - 1];
  if (tail > 0 && last && last[0] === 0) last[1] += tail;

  return runs.map(([state, span]) => [state, span / rate] as Segment);
}

/** A rendered take, impaired to order, with its answer attached. */
export function makeTake(
  text: string,
  charWpm: number,
  farnsworthWpm: number | null,
  rate: number,
  imp: Impairments = {},
  toneHz = 600,
): Take {
  const timing = targetTiming(charWpm, farnsworthWpm);
  const { samples } = synthesize(text, timing, {
    rate,
    toneHz,
    padSec: PAD_SEC,
  });
  peakNormalize(samples);

  // Measured before anything is done to the signal, so every dB below is
  // relative to a fixed, meaningful reference rather than to whatever the
  // previous stage happened to leave behind.
  const markLevel = rmsOverMarks(samples, rate, truthSegments(text, timing, rate));
  const rand = rng(imp.seed ?? 1);

  let x = samples;
  if (imp.room) x = convolve(x, roomImpulse(rate, imp.room, rand));
  if (imp.driftDb) x = applyDrift(x, rate, imp.driftDb, imp.driftPeriodSec ?? 4);

  if (imp.humHz && imp.humDb !== undefined) {
    const amp = markLevel * Math.SQRT2 * Math.pow(10, imp.humDb / 20);
    const harmonics = imp.humHarmonics ?? 3;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let v = x[i]!;
      for (let k = 1; k <= harmonics; k++) {
        // Falling off as 1/k, which is roughly how mains buzz actually sits.
        v += (amp / k) * Math.sin((2 * Math.PI * imp.humHz * k * i) / rate);
      }
      out[i] = v;
    }
    x = out;
  }

  if (imp.snrDb !== undefined) {
    const sigma = markLevel * Math.pow(10, -imp.snrDb / 20);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i]! + sigma * gaussian(rand);
    x = out;
  }

  if (imp.dcOffset) {
    const dc = markLevel * imp.dcOffset;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i]! + dc;
    x = out;
  }

  if (imp.agc) x = applyAgc(x, rate, imp.agc);

  return { samples: x, rate, text, timing, truth: truthSegments(text, timing, rate), markLevel };
}

/** Decode a take the way the app decodes a recording.
 *
 * Peak-normalize, then segment. The normalize step is not a detail: the app
 * does it to every file it opens, and an impairment that moves the peak —
 * a DC offset, mains hum louder than the tone — changes what the decoder is
 * handed. Skipping it here would test a pipeline the app does not ship. */
export function decodeTake(take: Take): { segments: Segment[]; toneHz: number; threshold: number } {
  return segmentsFrom(normalizePeak(take.samples), take.rate);
}

/** RMS of the signal across the spans the plan says are keyed.
 *
 * Over marks specifically, not over the whole clip: a take's overall RMS
 * depends on how much silence the text happens to contain, so an SNR defined
 * against it would mean something different for every message. */
function rmsOverMarks(
  x: Float32Array,
  rate: number,
  truth: readonly Segment[],
): number {
  let sum = 0;
  let n = 0;
  let at = 0;
  for (const [state, dur] of truth) {
    const span = Math.round(dur * rate);
    if (state === 1) {
      // Skip the raised-cosine ramps at each end; they are not the level.
      const skip = Math.min(Math.round(0.006 * rate), span >> 2);
      for (let i = at + skip; i < at + span - skip; i++) {
        const v = x[i] ?? 0;
        sum += v * v;
        n++;
      }
    }
    at += span;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/* ------------------------------------------------------------------ scoring */

export interface Score {
  readonly truthMarks: number;
  readonly gotMarks: number;
  readonly countsMatch: boolean;
  /** Mean signed error in mark length, seconds. Positive means marks read
   *  long, which is what a reverberant room does. */
  readonly markBiasSec: number;
  readonly gapBiasSec: number;
  /** Spread of the mark error — a bias can be corrected, scatter cannot. */
  readonly markScatterSec: number;
  readonly worstBoundarySec: number;
}

function marksAndGaps(segs: readonly Segment[]): { marks: number[]; gaps: number[] } {
  const marks: number[] = [];
  const gaps: number[] = [];
  for (const [state, dur] of segs) (state === 1 ? marks : gaps).push(dur);
  return { marks, gaps };
}

function boundaries(segs: readonly Segment[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const [, d] of segs) {
    t += d;
    out.push(t);
  }
  return out;
}

function mean(v: readonly number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

/** How a decode compares against a reference set of segments.
 *
 * Usually called twice per case: once against `take.truth`, and once against
 * the decode of the SAME signal with no impairment. The second is the one that
 * answers "what did this impairment cost", because even a perfect decoder does
 * not reproduce the truth exactly — the threshold sits partway up a 5 ms ramp,
 * so every mark reads a little short no matter what. */
export function scoreAgainst(
  got: readonly Segment[],
  ref: readonly Segment[],
): Score {
  const g = marksAndGaps(got);
  const r = marksAndGaps(ref);
  const countsMatch = g.marks.length === r.marks.length && got.length === ref.length;

  if (!countsMatch) {
    return {
      truthMarks: r.marks.length,
      gotMarks: g.marks.length,
      countsMatch: false,
      markBiasSec: NaN,
      gapBiasSec: NaN,
      markScatterSec: NaN,
      worstBoundarySec: NaN,
    };
  }

  const dMark = g.marks.map((v, i) => v - r.marks[i]!);
  const dGap = g.gaps.map((v, i) => v - r.gaps[i]!);
  const m = mean(dMark);
  const a = boundaries(got);
  const b = boundaries(ref);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));

  return {
    truthMarks: r.marks.length,
    gotMarks: g.marks.length,
    countsMatch: true,
    markBiasSec: m,
    gapBiasSec: mean(dGap),
    markScatterSec: Math.sqrt(mean(dMark.map((v) => (v - m) * (v - m)))),
    worstBoundarySec: worst,
  };
}
