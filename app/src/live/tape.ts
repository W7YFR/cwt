/* The latest audio Live heard, at the decode rate, to save as a recording.
 *
 * It keeps the latest `seconds` as 16-bit samples, so 30 minutes take about
 * 30 MB. Each Listen adds to the same tape, after a second of silence. The
 * tape notes when each Listen started, so a stretch of it can be found by the
 * wall clock: one QSO's audio.
 *
 * Pure.
 */

import { Decimator } from "./decoder";

/** Silence between one Listen and the next, seconds. */
const BETWEEN_SEC = 1;

/** Where a Listen starts on the tape: the wall clock at its first sample
 *  (ms), and how many samples were written before it. */
interface Mark {
  readonly at: number;
  readonly from: number;
}

export class Tape {
  private dec: Decimator | null = null;
  private ring: Int16Array | null = null;
  /** Samples written since the tape began, silence included. */
  private written = 0;
  /** How many of the latest are held. */
  private held = 0;
  private rate = 0;
  private marks: Mark[] = [];

  constructor(private readonly seconds: number) {}

  /** Start a Listen at `inputRate`, its first sample at `at` on the wall
   *  clock (ms). */
  start(inputRate: number, at: number): void {
    const dec = new Decimator(inputRate);
    if (!this.ring || dec.rate !== this.rate) {
      this.rate = dec.rate;
      this.ring = new Int16Array(Math.ceil(this.seconds * dec.rate));
      this.written = 0;
      this.held = 0;
      this.marks = [];
    } else if (this.held > 0) {
      this.write(new Float32Array(Math.round(BETWEEN_SEC * this.rate)));
    }
    this.dec = dec;
    this.marks.push({ at, from: this.written });
  }

  /** Audio captured since the last push, at the input rate. */
  push(samples: Float32Array): void {
    if (!this.dec) return;
    this.write(this.dec.push(samples));
  }

  /** The Listen stops. */
  stop(): void {
    this.dec = null;
  }

  private write(x: Float32Array): void {
    const ring = this.ring!;
    const cap = ring.length;
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(-1, Math.min(1, x[i]!));
      ring[(this.written + i) % cap] = Math.round(v * 32767);
    }
    this.written += x.length;
    this.held = Math.min(cap, this.held + x.length);
  }

  /** Seconds of audio held. */
  get heldSec(): number {
    return this.rate ? this.held / this.rate : 0;
  }

  /** The first sample held. */
  private get oldest(): number {
    return this.written - this.held;
  }

  /** The wall clock at sample `n`, ms. */
  private timeOf(n: number): number {
    let mark = this.marks[0]!;
    for (const m of this.marks) if (m.from <= n) mark = m;
    return mark.at + ((n - mark.from) / this.rate) * 1000;
  }

  /** The sample at `at` on the wall clock (ms), within what is held. */
  private sampleAt(at: number): number {
    let mark = this.marks[0]!;
    for (const m of this.marks) if (m.at <= at) mark = m;
    const n = Math.round(mark.from + ((at - mark.at) / 1000) * this.rate);
    return Math.max(this.oldest, Math.min(this.written, n));
  }

  /** The wall clock at the first sample held, ms, or null with none. */
  get startedAt(): number | null {
    return this.held ? this.timeOf(this.oldest) : null;
  }

  /** Whether any of the audio from `from` to `to` (ms) is held. */
  holds(from: number, to: number): boolean {
    return this.held > 0 && this.sampleAt(from) < this.sampleAt(to);
  }

  /** The audio held, oldest first, and its rate. With `from` and `to` (ms
   *  on the wall clock), only that stretch of it. */
  audio(from?: number, to?: number): { samples: Float32Array; rate: number } {
    const ring = this.ring;
    if (!ring || !this.held) return { samples: new Float32Array(0), rate: this.rate };
    const a = from === undefined ? this.oldest : this.sampleAt(from);
    const b = to === undefined ? this.written : this.sampleAt(to);
    const out = new Float32Array(Math.max(0, b - a));
    const cap = ring.length;
    for (let i = 0; i < out.length; i++) out[i] = ring[(a + i) % cap]! / 32767;
    return { samples: out, rate: this.rate };
  }

  /** Forget the audio held. */
  clear(): void {
    this.held = 0;
    if (!this.dec) {
      this.ring = null;
      this.marks = [];
    }
  }
}
