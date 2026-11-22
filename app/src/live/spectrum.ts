/* Where the keyed signals are in the band.
 *
 * A running FFT over the audio, a frame every 32 ms. Each bin keeps its own
 * noise floor and a few seconds of history: was it above the floor in each
 * frame? A bin that keys turns on and off. A carrier stays on, and noise
 * seldom clears the floor by enough. So a bin that has turned on and off a few
 * times, and spent some but not all of the time on, is a keyed signal.
 *
 * Neighboring bins of one signal are one signal, and a signal's harmonics and
 * key clicks key in step with it. So a candidate that keys in step with a
 * stronger one is left out.
 *
 * Pure: the decoder in decoder.ts feeds it, and tests run it under Node.
 */

import { fft } from "@/audio/qsb";

/** The band searched, in Hz. */
export const BAND_LO_HZ = 300;
export const BAND_HI_HZ = 1500;

/** Frame length, as a power of two at about 8 kHz: bins about 16 Hz apart. */
const FRAME = 512;
/** Hop between frames: half a frame. */
const HOP = 256;
/** Frames of history each bin keeps: about 4 seconds. */
const HISTORY = 128;

/** How far above its floor a bin must be to count as on, in dB. */
const ON_DB = 9;
/** A bin's floor is the median of the bins around it, this many either
 *  side: a signal takes up two or three bins, so the median is the noise. */
const FLOOR_SPAN = 12;
/** Until there is sound, a frame with more than this share of its samples
 *  exactly zero is left out: digital silence, not noise. */
const SILENT_SHARE = 1 / 16;
/** How fast a bin's floor follows that median, per frame. */
const FLOOR_FOLLOW = 0.1;

/** A keyed signal's share of on frames, at least and at most. */
const MIN_DUTY = 0.04;
const MAX_DUTY = 0.9;
/** A keyed signal turns on at least this many times in the history. */
const MIN_ONSETS = 3;
/** Two candidates key together when the one on less often is on, this much
 *  of that time and at least this many frames, with the other. Two busy
 *  signals overlap a lot by chance, so this is near all of it. */
const WITHIN_SHARE = 0.92;
const WITHIN_FRAMES = 6;
/** Onsets needed to say that two candidates key together. */
const STEP_ONSETS = 6;
/** A keyed signal's on frames come in runs this long, on average: a mark
 *  spans three frames or more. Frames overlap by half, so a click or a
 *  burst of noise lights two. */
const MIN_RUN_FRAMES = 2.2;
/** Two candidates key together when this much of the onsets of the one
 *  that turns on less often match the other's. */
const IN_STEP = 0.75;

export interface Candidate {
  /** The signal's pitch, Hz. */
  readonly hz: number;
  /** How far above the floor it is when on, dB. */
  readonly snrDb: number;
}

export class Spectrum {
  readonly rate: number;
  /** The bins searched: first and count. */
  private readonly lo: number;
  private readonly bins: number;
  private readonly window: Float64Array;
  private readonly re = new Float64Array(FRAME);
  private readonly im = new Float64Array(FRAME);
  /** Audio not yet framed. */
  private buf = new Float32Array(FRAME * 4);
  private fill = 0;
  /** A frame of sound has come: digital silence is read from now on. */
  private heard = false;
  /** Per bin: floor, power in dB this frame, and the mean power when on. */
  private readonly floor: Float64Array;
  private readonly power: Float64Array;
  private readonly onPower: Float64Array;
  /** Per bin history, `HISTORY` frames each: 1 where the bin was on. */
  private readonly history: Uint8Array;
  private readonly onCount: Int32Array;
  private readonly onsets: Int32Array;
  private readonly snrSum: Float64Array;
  private head = 0;
  private frames = 0;
  /** A smoothed spectrum for display, dB above each bin's floor. */
  private readonly shown: Float32Array;

  constructor(rate: number) {
    this.rate = rate;
    const binHz = rate / FRAME;
    this.lo = Math.max(1, Math.floor(BAND_LO_HZ / binHz));
    this.bins = Math.min(FRAME / 2 - 1, Math.ceil(BAND_HI_HZ / binHz)) - this.lo + 1;
    this.window = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
    this.floor = new Float64Array(this.bins).fill(NaN);
    this.power = new Float64Array(this.bins);
    this.onPower = new Float64Array(this.bins).fill(NaN);
    this.history = new Uint8Array(this.bins * HISTORY);
    this.onCount = new Int32Array(this.bins);
    this.onsets = new Int32Array(this.bins);
    this.snrSum = new Float64Array(this.bins * HISTORY);
    this.shown = new Float32Array(this.bins);
  }

  /** Seconds between frames. */
  get hopSec(): number {
    return HOP / this.rate;
  }

  /** The pitch of bin `b` of the band, Hz. */
  binHz(b: number): number {
    return ((this.lo + b) * this.rate) / FRAME;
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; ) {
      if (this.fill === this.buf.length) {
        const grown = new Float32Array(this.buf.length * 2);
        grown.set(this.buf);
        this.buf = grown;
      }
      const n = Math.min(samples.length - i, this.buf.length - this.fill);
      this.buf.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      while (this.fill >= FRAME) {
        this.frame(this.buf.subarray(0, FRAME));
        this.buf.copyWithin(0, HOP, this.fill);
        this.fill -= HOP;
      }
    }
  }

  private frame(x: Float32Array): void {
    // The digital silence the recorder starts with is not the noise: a
    // floor learned from it would put every bin far above it. Once there is
    // sound, silence is read: a loopback keys into exact zeros.
    if (!this.heard) {
      let zeros = 0;
      for (let i = 0; i < FRAME; i++) if (x[i] === 0) zeros++;
      if (zeros > FRAME * SILENT_SHARE) return;
      this.heard = true;
    }
    const { re, im } = this;
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[i]! * this.window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < this.bins; b++) {
      const k = this.lo + b;
      this.power[b] = 10 * Math.log10(re[k]! * re[k]! + im[k]! * im[k]! + 1e-12);
    }
    const slot = this.head;
    const local = this.localMedian();
    for (let b = 0; b < this.bins; b++) {
      const p = this.power[b]!;
      const f = this.floor[b]!;
      const floor = Number.isNaN(f) ? local[b]! : f + (local[b]! - f) * FLOOR_FOLLOW;
      this.floor[b] = floor;
      // On when well above the floor and near the top of its neighbors: a
      // signal between two bins lights both.
      const left = b > 0 ? this.power[b - 1]! : -Infinity;
      const right = b < this.bins - 1 ? this.power[b + 1]! : -Infinity;
      const snr = p - floor;
      const on = snr > ON_DB && p >= Math.max(left, right) - 3 ? 1 : 0;
      const at = b * HISTORY;
      const prevSlot = (slot + HISTORY - 1) % HISTORY;
      const old = this.history[at + slot]!;
      // The frame that falls out of the history takes its counts with it.
      if (old) this.onCount[b] = this.onCount[b]! - 1;
      const next = this.history[at + ((slot + 1) % HISTORY)]!;
      if (!old && next && this.frames >= HISTORY) this.onsets[b] = this.onsets[b]! - 1;
      if (on && !this.history[at + prevSlot]!) this.onsets[b] = this.onsets[b]! + 1;
      this.history[at + slot] = on;
      this.snrSum[at + slot] = on ? snr : 0;
      if (on) {
        this.onCount[b] = this.onCount[b]! + 1;
        const op = this.onPower[b]!;
        this.onPower[b] = Number.isNaN(op) ? p : op + (p - op) * 0.2;
      }
      this.shown[b] = this.shown[b]! + (Math.max(0, snr) - this.shown[b]!) * (snr > this.shown[b]! ? 0.6 : 0.08);
    }
    this.head = (slot + 1) % HISTORY;
    this.frames++;
  }

  /** The median power of the bins around each bin, this frame. */
  private localMedian(): Float64Array {
    const out = new Float64Array(this.bins);
    const near: number[] = [];
    for (let b = 0; b < this.bins; b++) {
      near.length = 0;
      const lo = Math.max(0, b - FLOOR_SPAN);
      const hi = Math.min(this.bins - 1, b + FLOOR_SPAN);
      for (let i = lo; i <= hi; i++) near.push(this.power[i]!);
      near.sort((x, y) => x - y);
      out[b] = near[near.length >> 1]!;
    }
    return out;
  }

  /** The keyed signals heard in the last few seconds, strongest first. */
  candidates(): Candidate[] {
    const filled = Math.min(this.frames, HISTORY);
    if (filled < 8) return [];
    const keyed: { b: number; snr: number }[] = [];
    for (let b = 0; b < this.bins; b++) {
      const on = this.onCount[b]!;
      const duty = on / filled;
      if (duty < MIN_DUTY || duty > MAX_DUTY || this.onsets[b]! < MIN_ONSETS) continue;
      if (on / this.onsets[b]! < MIN_RUN_FRAMES) continue;
      let sum = 0;
      for (let s = 0; s < HISTORY; s++) sum += this.snrSum[b * HISTORY + s]!;
      keyed.push({ b, snr: sum / on });
    }
    // The bin of each run of neighbors that is on the most strongly.
    const peaks: { b: number; snr: number }[] = [];
    for (const k of keyed) {
      const last = peaks[peaks.length - 1];
      if (last && k.b - last.b <= 2) {
        if (k.snr > last.snr) peaks[peaks.length - 1] = k;
      } else peaks.push(k);
    }
    peaks.sort((a, b) => b.snr - a.snr);
    const kept: { b: number; snr: number }[] = [];
    for (const p of peaks) {
      if (kept.some((k) => this.inStep(k.b, p.b))) continue;
      kept.push(p);
    }
    return kept.map((k) => ({ hz: this.refine(k.b), snrDb: k.snr }));
  }

  /** The pitch of the most keyed bin within `span` Hz of `hz` lately: the
   *  middle of the signal that `hz` is on the edge of, or `hz` when
   *  nothing near has keyed. */
  centerNear(hz: number, span = 90): number {
    const at = this.binOf(hz);
    const reach = Math.round((span * FRAME) / this.rate);
    let best = -1;
    let most = 0;
    for (let b = Math.max(0, at - reach); b <= Math.min(this.bins - 1, at + reach); b++) {
      let sum = 0;
      for (let s = 0; s < HISTORY; s++) sum += this.snrSum[b * HISTORY + s]!;
      if (sum > most) {
        most = sum;
        best = b;
      }
    }
    return best < 0 ? hz : this.refine(best);
  }

  /** How far above the floor the bin at `hz` is when on, lately, dB. */
  snrAt(hz: number): number {
    const b = this.binOf(hz);
    const on = this.onCount[b]!;
    if (!on) return 0;
    let sum = 0;
    for (let s = 0; s < HISTORY; s++) sum += this.snrSum[b * HISTORY + s]!;
    return sum / on;
  }

  /** The band's bin nearest `hz`. */
  private binOf(hz: number): number {
    return Math.max(0, Math.min(this.bins - 1, Math.round((hz * FRAME) / this.rate) - this.lo));
  }

  /** Whether the signals at `a` and `b` Hz turn on together: one signal,
   *  or one and its echo. */
  keyTogether(a: number, b: number): boolean {
    return this.inStep(this.binOf(a), this.binOf(b));
  }

  /** Whether bins `a` and `b` turn on together: the same signal. The bin
   *  on less often is on only when the other is. Or, as two busy signals
   *  are often on at once by chance, when they turn on: of the bin that
   *  turns on less often, most of its onsets fall in the frame of one of the
   *  other's, or the frame either side. */
  private inStep(a: number, b: number): boolean {
    const onsets = (bin: number) => {
      const out: number[] = [];
      const at = bin * HISTORY;
      // Oldest first, from the slot after the newest.
      for (let k = 1; k < HISTORY; k++) {
        const s = (this.head + k) % HISTORY;
        const prev = (s + HISTORY - 1) % HISTORY;
        if (this.history[at + s]! && !this.history[at + prev]!) out.push(k);
      }
      return out;
    };
    // Within: the bin on less often is on only when the other is too, as a
    // click is on at the edges of the marks it comes from.
    let both = 0;
    let na = 0;
    let nb = 0;
    for (let s = 0; s < HISTORY; s++) {
      const x = this.history[a * HISTORY + s]!;
      const y = this.history[b * HISTORY + s]!;
      both += x & y;
      na += x;
      nb += y;
    }
    const fewer = Math.min(na, nb);
    if (fewer >= WITHIN_FRAMES && both / fewer >= WITHIN_SHARE) return true;
    const oa = onsets(a);
    const ob = onsets(b);
    const [few, many] = oa.length <= ob.length ? [oa, ob] : [ob, oa];
    if (few.length < STEP_ONSETS) return false;
    const marks = new Set(many);
    const shared = few.filter((k) => marks.has(k) || marks.has(k - 1) || marks.has(k + 1)).length;
    return shared / few.length >= IN_STEP;
  }

  /** The pitch of bin `b`, between bins, from the power on either side. */
  private refine(b: number): number {
    const p = (i: number) => {
      const v = this.onPower[i];
      return v === undefined || Number.isNaN(v) ? -120 : v;
    };
    if (b <= 0 || b >= this.bins - 1) return this.binHz(b);
    const l = p(b - 1);
    const c = p(b);
    const r = p(b + 1);
    const d = l - 2 * c + r;
    const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0;
    return this.binHz(b + shift);
  }

  /** The band as heard lately, dB above each bin's floor, for the strip on
   *  the page. A copy. */
  view(): { fromHz: number; toHz: number; db: Float32Array } {
    return { fromHz: this.binHz(0), toHz: this.binHz(this.bins - 1), db: this.shown.slice() };
  }
}
