/* One signal, as key down and key up.
 *
 * The audio is mixed down from the signal's pitch to 0 Hz and passed through a
 * narrow low-pass, so other signals more than about 100 Hz away fall off
 * sharply. The envelope that is left is read every 4 ms.
 *
 * The levels follow the signal. The floor tracks the quietest the envelope
 * gets, and the peak tracks the loudest. The key is down when the envelope is
 * near the peak: within 6 dB of it, or past the middle when the signal is
 * weak. A fade moves both, and a second station at another strength takes
 * over the peak within a second or so.
 *
 * Runs shorter than a few milliseconds are glitches. A short mark is dropped,
 * and a short gap joins the marks either side of it.
 *
 * Pure and streaming: audio in, runs out, at any length.
 */

/** A run of key down or key up. */
export interface Run {
  readonly on: boolean;
  /** Start, in seconds from the start of the stream. */
  readonly t: number;
  readonly dur: number;
  /** A mark's mean level, dB. 0 for a gap. */
  readonly db: number;
}

/** Seconds between envelope readings. */
export const HOP_SEC = 0.004;
/** The low-pass cutoff on each arm of the mixer, Hz. A 40 WPM dit still
 *  rises in a few milliseconds, and a signal 150 Hz away is 25 dB down. */
const CUTOFF_HZ = 70;
/** Quieter than this is digital silence, not noise, dB of full scale: the
 *  recorder zeroes its first moments while the device settles, and a
 *  loopback keys into exact zeros. It leaves the floor and the peak where
 *  they are. */
const SILENCE_DB = -120;
/** The quietest peak that can be keying, dB of full scale. */
const MIN_PEAK_DB = -60;
/** The least range between floor and peak that can be keying, dB. */
const MIN_RANGE_DB = 12;
/** How far the floor moves down toward each key-up reading under it, dB. */
const FLOOR_STEP_DB = 0.1;
/** The share of key-up readings the floor sits over. Fixed steps, longer
 *  down than up, make the floor this quantile of the readings: noise spikes
 *  and deep nulls pull it little. Keying that is not read yet, more than half
 *  of the readings, cannot lift it into the marks, as a median would. */
const FLOOR_QUANTILE = 0.25;
/** How far the floor moves up toward each key-up reading over it, dB. */
const FLOOR_RISE_DB = (FLOOR_STEP_DB * FLOOR_QUANTILE) / (1 - FLOOR_QUANTILE);
/** Key down is at least this far over the floor, dB. Noise seldom reaches
 *  it, and not for long. */
const MIN_UP_DB = 14;
/** Key down is no more than this far under the loudest the station has
 *  been lately, dB. */
const REF_SPAN_DB = 22;
/** How fast that loudest level is forgotten, dB a second. */
const REF_FALL_DB = 0.05;
/** Runs shorter than this are glitches, seconds. */
const MIN_MARK_SEC = 0.016;
const MIN_GAP_SEC = 0.008;
/** After this long with the key up, the peak falls faster: the station
 *  that keys next may be weaker. */
const PEAK_HOLD_SEC = 0.3;
/** How far the peak falls each reading while the key is down or briefly
 *  up, and once it has been up a while, dB. */
const PEAK_SAG_DB = 0.01;
const PEAK_FALL_DB = 0.1;
/** A new detector learns the levels for this long before it reads keying,
 *  seconds. */
const WARMUP_SEC = 0.25;

/** A biquad low-pass section, Butterworth by its Q. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;

  constructor(rate: number, hz: number, q: number) {
    const w = (2 * Math.PI * hz) / rate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** A fourth-order Butterworth low-pass: two sections. */
function lowpass(rate: number): Biquad[] {
  return [new Biquad(rate, CUTOFF_HZ, 0.5412), new Biquad(rate, CUTOFF_HZ, 1.3066)];
}

export class Detector {
  readonly rate: number;
  private hzNow: number;
  private readonly hop: number;
  private readonly armI: Biquad[];
  private readonly armQ: Biquad[];
  private cos = 1;
  private sin = 0;
  private stepCos = 1;
  private stepSin = 0;
  /** Samples seen, from the start of the stream. */
  private at: number;
  private sinceHop = 0;
  private floor = NaN;
  private peak = NaN;
  private prevDb = NaN;
  private on = false;
  /** When the run in progress started, seconds. */
  private runStart: number;
  private markDbSum = 0;
  private markHops = 0;
  /** Finished runs not yet taken. The last one is held back until the run
   *  after it is long enough not to be a glitch. */
  private done: Run[] = [];
  private held: Run | null = null;
  private lastOn = -Infinity;
  private loudest = -Infinity;
  /** When this detector started, seconds. */
  private readonly born: number;

  /** With `levels`, the floor and peak start there, learned beforehand,
   *  and there is no warm-up. */
  constructor(rate: number, hz: number, startSample: number, levels?: { floor: number; peak: number }) {
    this.rate = rate;
    this.hzNow = hz;
    this.hop = Math.max(1, Math.round(HOP_SEC * rate));
    this.armI = lowpass(rate);
    this.armQ = lowpass(rate);
    this.at = startSample;
    this.runStart = startSample / rate;
    this.born = levels ? -Infinity : this.runStart;
    if (levels) {
      this.floor = levels.floor;
      this.peak = levels.peak;
    }
    this.tune(hz);
  }

  get hz(): number {
    return this.hzNow;
  }

  /** Follow the signal to a new pitch. */
  tune(hz: number): void {
    this.hzNow = hz;
    const w = (2 * Math.PI * hz) / this.rate;
    this.stepCos = Math.cos(w);
    this.stepSin = Math.sin(w);
  }

  /** The floor now and the loudest the peak has been, dB: the levels a
   *  second detector on the same audio can start from. */
  get levels(): { floor: number; peak: number } {
    return { floor: this.floor, peak: this.loudest };
  }

  /** The level the key-down reads at lately, dB. */
  get peakDb(): number {
    return this.peak;
  }

  /** Whether the key is down now. */
  get keyed(): boolean {
    return this.on;
  }

  /** When the last mark ended, seconds, or -Infinity. While the key is down
   *  it is now. */
  get lastMarkEnd(): number {
    return this.on ? this.at / this.rate : this.lastOn;
  }

  push(samples: Float32Array): void {
    const [i1, i2] = this.armI as [Biquad, Biquad];
    const [q1, q2] = this.armQ as [Biquad, Biquad];
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n]!;
      const i = i2.step(i1.step(x * this.cos));
      const q = q2.step(q1.step(-x * this.sin));
      // Turn the oscillator one step, and hold its amplitude at 1.
      const c = this.cos * this.stepCos - this.sin * this.stepSin;
      const s = this.sin * this.stepCos + this.cos * this.stepSin;
      this.cos = c;
      this.sin = s;
      this.at++;
      if ((this.at & 1023) === 0) {
        const m = Math.hypot(this.cos, this.sin);
        this.cos /= m;
        this.sin /= m;
      }
      if (++this.sinceHop < this.hop) continue;
      this.sinceHop = 0;
      this.reading(20 * Math.log10(2 * Math.hypot(i, q) + 1e-9));
    }
  }

  private reading(db: number): void {
    const now = this.at / this.rate;
    const silent = db < SILENCE_DB;
    if (Number.isNaN(this.floor)) {
      if (silent) return;
      this.floor = db;
      this.peak = db;
    }
    // The floor is a low quantile of the level with the key up. The peak rises fast
    // and falls slowly, faster once the key has been up a while. Noise alone
    // keeps the peak a few dB over the floor, short of `MIN_RANGE_DB`.
    if (!this.on && !silent) this.floor += db > this.floor ? FLOOR_RISE_DB : -FLOOR_STEP_DB;
    if (db > this.peak) this.peak += (db - this.peak) * 0.3;
    else if (!silent) this.peak -= now - this.lastMarkEnd > PEAK_HOLD_SEC ? PEAK_FALL_DB : PEAK_SAG_DB;
    if (this.peak < this.floor) this.peak = this.floor;
    if (!(this.peak <= this.loudest)) this.loudest = this.peak;

    const range = this.peak - this.floor;
    const keying = range >= MIN_RANGE_DB && this.peak >= MIN_PEAK_DB && now - this.born >= WARMUP_SEC;
    // The station this channel follows sets a floor of its own: far below
    // it is another signal's spill, not this one's keying.
    this.loudest -= REF_FALL_DB * HOP_SEC;
    const up = Math.max(this.floor + 0.55 * range, this.peak - 6, this.floor + MIN_UP_DB, this.loudest - REF_SPAN_DB);
    const down = up - Math.min(3, 0.15 * range);
    const prev = this.prevDb;
    this.prevDb = db;

    if (!this.on && keying && db > up) this.edge(true, prev, db, up, now);
    else if (this.on && (!keying || db < down)) this.edge(false, prev, db, down, now);

    if (this.on) {
      this.markDbSum += db;
      this.markHops++;
    }
  }

  /** The key went down (`on`) or up between the last reading and this one. */
  private edge(on: boolean, prev: number, db: number, level: number, now: number): void {
    // Where between the two readings the envelope crossed the level.
    const frac = Number.isFinite(prev) && db !== prev ? Math.max(0, Math.min(1, (level - prev) / (db - prev))) : 1;
    const t = now - HOP_SEC * (1 - frac);
    const dur = t - this.runStart;
    const run: Run = {
      on: this.on,
      t: this.runStart,
      dur,
      db: this.on && this.markHops > 0 ? this.markDbSum / this.markHops : 0,
    };
    this.on = on;
    this.markDbSum = 0;
    this.markHops = 0;
    if (!on) this.lastOn = t;
    const short = run.on ? run.dur < MIN_MARK_SEC : run.dur < MIN_GAP_SEC;
    if (short && this.held && this.held.on === on) {
      // A glitch: the run before it goes on as if it had not happened.
      this.runStart = this.held.t;
      if (on) {
        this.markDbSum = this.held.db;
        this.markHops = 1;
      }
      this.held = null;
      return;
    }
    if (this.held) this.done.push(this.held);
    this.held = run;
    this.runStart = t;
  }

  /** The runs finished since the last call, oldest first. */
  take(): Run[] {
    const out = this.done;
    this.done = [];
    return out;
  }

  /** The runs not yet taken, including the one held back and the one in
   *  progress, cut at now. For a flush at the end. */
  rest(): Run[] {
    const now = this.at / this.rate;
    const out = this.take();
    if (this.held) out.push(this.held);
    this.held = null;
    const db = this.on && this.markHops > 0 ? this.markDbSum / this.markHops : 0;
    if (now > this.runStart) out.push({ on: this.on, t: this.runStart, dur: now - this.runStart, db });
    this.runStart = now;
    return out;
  }

  /** What is not yet taken: the run held back and the run in progress, cut
   *  at now. Not consumed. */
  peek(): Run[] {
    const now = this.at / this.rate;
    const out: Run[] = this.held ? [this.held] : [];
    const db = this.on && this.markHops > 0 ? this.markDbSum / this.markHops : 0;
    if (now > this.runStart) out.push({ on: this.on, t: this.runStart, dur: now - this.runStart, db });
    return out;
  }

  /** Now, in seconds from the start of the stream. */
  get now(): number {
    return this.at / this.rate;
  }
}
