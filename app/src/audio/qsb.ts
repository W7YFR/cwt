/* The air between two stations: QSB, a signal that fades in and out; the
 * band noise it fades into; and QRN, static crashes on top of that noise.
 *
 * Each station fades on its own, from a seed of its own, as each path through
 * the ionosphere does. The fade is a function of time, so a station's next
 * over picks up its fading where the last one left it. The noise belongs to
 * the band, not to a station: it sits under every signal at one level, and a
 * deep fade drops the signal into it.
 *
 * Pure. The Copy page bakes both into its samples; the QSO page plays them
 * through Web Audio.
 */

/** The deepest fade the QSB slider sets, in dB. */
export const QSB_MAX_DB = 30;

/** The slider's step, in dB. */
export const QSB_STEP_DB = 3;

/** The Noise slider's lowest place, in dB under the signal's peak: there it
 *  is off. */
export const NOISE_OFF_DB = -50;

/** The loudest noise the Noise slider sets, in dB under the signal's peak. */
export const NOISE_MAX_DB = -10;

/** The Noise slider's step, in dB. */
export const NOISE_STEP_DB = 2;

/** Whether noise at `noiseDb` plays at all. */
export function noiseOn(noiseDb: number): boolean {
  return noiseDb > NOISE_OFF_DB;
}

/** The band noise's RMS for `noiseDb` under a signal of peak `peak`. */
export function noiseLevel(peak: number, noiseDb: number): number {
  return noiseOn(noiseDb) ? peak * Math.pow(10, noiseDb / 20) : 0;
}

/** QRN's settings, from none to the most. */
export const QRN_LEVELS = ["Off", "Light", "Moderate", "Heavy", "Severe"] as const;

/** QRN at each setting: crackle clicks a second, crashes a second, and how
 *  loud the loudest crash is, as a share of the signal's peak. */
const QRN_CLICKS = [0, 8, 20, 40, 70];
const QRN_CRASHES = [0, 0.15, 0.4, 0.8, 1.5];
const QRN_LOUD = [0, 0.45, 0.7, 0.95, 1.2];

/** How loud the crackle's clicks are, as a share of the loudest crash. */
const CLICK_SHARE = 0.25;

/** The receiver's audio passband, which QRN fills: wide, unlike the noise. */
const PASS_LO_HZ = 300;
const PASS_HI_HZ = 2400;

/** The receiver's CW filter, which the band noise comes through. Measured
 *  from noise recorded off a real receiver: flat this far each side of the
 *  pitch, so about 450 Hz wide where it is 6 dB down... */
const FILTER_FLAT_HZ = 215;
/** ...then down this many dB a Hz, steep as a DSP filter is... */
const FILTER_SKIRT_DB_PER_HZ = 0.3;
/** ...to the receiver's own hiss, this far under the passband. */
const FILTER_FLOOR_DB = -50;

/** A fixed sequence of numbers in [0, 1) from `seed`. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from text, such as a call. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One station's fading: its gain at any time. */
export type Fade = (tSec: number) => number;

/** Fading `depthDb` deep at most, from `seed`.
 *
 * Three slow swells of different periods, summed. The loss grows with the
 * square of how far the sum is under its top, so half the time the signal is
 * within a quarter of the depth of full, and it drops into short, deep
 * troughs, as real QSB does. */
export function fadeOf(depthDb: number, seed: number): Fade {
  if (!(depthDb > 0)) return () => 1;
  const rand = seeded(seed);
  // Periods in seconds, and how much each swell weighs.
  const swells = [
    { lo: 9, hi: 16, weight: 0.5 },
    { lo: 4, hi: 7, weight: 0.3 },
    { lo: 1.8, hi: 3, weight: 0.2 },
  ].map(({ lo, hi, weight }) => ({
    w: (2 * Math.PI) / (lo + rand() * (hi - lo)),
    phase: rand() * 2 * Math.PI,
    weight,
  }));
  return (t) => {
    let x = 0;
    for (const s of swells) x += s.weight * Math.sin(s.w * t + s.phase);
    const under = (1 - x) / 2;
    return Math.pow(10, (-depthDb * under * under) / 20);
  };
}

/** `fade` from `fromSec`, sampled every `stepSec` for `n` points: a curve to
 *  hand to Web Audio. */
export function fadeCurve(fade: Fade, fromSec: number, stepSec: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fade(fromSec + i * stepSec);
  return out;
}

/** `x` through an RBJ biquad, in place: a band-pass with 0 dB at its peak,
 *  or a Butterworth high- or low-pass, which does not ring. */
export function biquad(x: Float32Array, rate: number, kind: "band" | "high" | "low", hz: number, q: number): void {
  const w0 = (2 * Math.PI * hz) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b1, b2] =
    kind === "band"
      ? [alpha / a0, 0, -alpha / a0]
      : kind === "low"
        ? [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0]
        : [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0];
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** QRN at setting `qrn` (an index into `QRN_LEVELS`): `n` samples of static
 *  under a signal of peak `peak`.
 *
 * Static is lightning, far away and near. Far away, it is a crackle: single
 * clicks at random. Nearer, it is a crash: a swell of hundreds of clicks
 * close together, ragged, that dies away in a few tenths of a second. Each
 * click is one sample; the receiver's passband makes it a click you hear. */
export function qrnCrashes(n: number, rate: number, qrn: number, peak: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  const crashes = QRN_CRASHES[qrn] ?? 0;
  if (!(crashes > 0)) return out;
  const rand = seeded(seed);
  const sign = () => (rand() < 0.5 ? -1 : 1);
  /** Most clicks small, a few large, as static's are. */
  const size = () => Math.pow(rand(), 4);
  /** Times at random, `perSec` a second on average, over `n` samples. */
  const arrivals = function* (perSec: number) {
    let t = 0;
    for (;;) {
      t += -Math.log(1 - rand()) / perSec;
      const at = Math.round(t * rate);
      if (at >= n) return;
      yield at;
    }
  };

  // The crackle.
  for (const at of arrivals(QRN_CLICKS[qrn] ?? 0)) out[at]! += sign() * size() * CLICK_SHARE;
  // The crashes.
  for (const at of arrivals(crashes)) {
    const loud = 0.2 + 0.8 * Math.pow(rand(), 2);
    const durSec = 0.08 + rand() * 0.5;
    const tau = (durSec / 3) * rate;
    const rise = (0.005 + rand() * 0.03) * rate;
    const density = 400 + rand() * 1500;
    const len = Math.min(n - at, Math.round(durSec * rate));
    // Clicks at random through the crash, under a swell that rises fast and
    // dies away, and is ragged on the way.
    let i = 0;
    let ragged = 1;
    while (i < len) {
      i += Math.max(1, Math.round((-Math.log(1 - rand()) / density) * rate));
      if (i >= len) break;
      if (rand() < 0.02) ragged = 0.3 + rand() * 0.7;
      const swell = i < rise ? i / rise : Math.exp(-(i - rise) / tau);
      out[at + i]! += sign() * size() * loud * swell * ragged;
    }
  }

  // Through the receiver: no ringing, so a click stays a click.
  biquad(out, rate, "high", PASS_LO_HZ, Math.SQRT1_2);
  biquad(out, rate, "low", PASS_HI_HZ, Math.SQRT1_2);
  // The loudest crash at the setting's level.
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(out[i]!));
  if (top > 0) {
    const k = ((QRN_LOUD[qrn] ?? 0) * peak) / top;
    for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  }
  return out;
}

/** `re` and `im` through a radix-2 FFT, in place. Their length is a power
 *  of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = (-2 * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      const c = Math.cos(step * k);
      const s = Math.sin(step * k);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const vr = re[j]! * c - im[j]! * s;
        const vi = re[j]! * s + im[j]! * c;
        re[j] = re[i]! - vr;
        im[j] = im[i]! - vi;
        re[i] = re[i]! + vr;
        im[i] = im[i]! + vi;
      }
    }
  }
}

/** The CW filter's gain at `hz`, for a pitch of `toneHz`. */
function filterGain(hz: number, toneHz: number): number {
  const off = Math.abs(hz - toneHz) - FILTER_FLAT_HZ;
  const db = off > 0 ? Math.max(FILTER_FLOOR_DB, -FILTER_SKIRT_DB_PER_HZ * off) : 0;
  return Math.pow(10, db / 20);
}

/** Band noise at `toneHz`: `n` samples of the noise a receiver's CW filter
 *  passes, at an RMS of `level`.
 *
 * Made in the frequency domain, in blocks that overlap by half: each block
 * is random in every bin, at the filter's gain there, and the blocks
 * cross-fade so the noise holds one level. One FFT makes two blocks: its
 * real part and its imaginary part are each noise with that spectrum. */
export function bandNoise(n: number, rate: number, toneHz: number, level: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(n);
  // Bins 5 Hz apart or closer, fine enough for the filter's skirts.
  const size = 2 ** Math.ceil(Math.log2(rate / 5));
  const hop = size / 2;
  const gains = new Float64Array(hop);
  for (let k = 1; k < hop; k++) gains[k] = filterGain((k * rate) / size, toneHz);
  // A sine window: two blocks' squares sum to one where they overlap.
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = Math.sin((Math.PI * (i + 0.5)) / size);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const add = (at: number, block: Float64Array) => {
    const from = Math.max(0, -at);
    const to = Math.min(size, n - at);
    for (let i = from; i < to; i++) out[at + i] = out[at + i]! + block[i]! * win[i]!;
  };
  for (let at = -hop; at < n; at += 2 * hop) {
    re.fill(0);
    im.fill(0);
    // Positive frequencies only, so the real and imaginary parts of the
    // result are each real noise with this spectrum.
    for (let k = 1; k < hop; k++) {
      re[k] = gauss() * gains[k]!;
      im[k] = gauss() * gains[k]!;
    }
    fft(re, im);
    add(at, re);
    add(at + hop, im);
  }
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += out[i]! * out[i]!;
  const rms = Math.sqrt(sumSq / Math.max(n, 1));
  if (rms > 0) {
    const k = level / rms;
    for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  }
  return out;
}
