/* The air between two stations: QSB, a signal that fades in and out; the
 * band noise it fades into; and QRN, static crashes on top of that noise.
 *
 * Each station fades on its own, from a seed of its own, as each path through
 * the ionosphere does. The fade is a function of time, so a station's next
 * over picks up its fading where the last one left it. The noise belongs to
 * the band, not to a station: it sits under every signal at one level, and a
 * deep fade drops the signal into it. All of it comes through the
 * receiver's CW filter, as on the air.
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
const QRN_LOUD = [0, 0.27, 0.42, 0.57, 0.72];

/** How loud the crackle's clicks are, as a share of the loudest crash. */
const CLICK_SHARE = 0.4;

/** The receiver's CW filter, which the band comes through. Measured
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

/** QRN at setting `qrn` (an index into `QRN_LEVELS`): `n` samples of static
 *  under a signal of peak `peak` on `toneHz`.
 *
 * Static is lightning, far away and near. Far away, it is a crackle: single
 * clicks at random. Nearer, it is a crash: a swell of hundreds of clicks
 * close together, ragged, that dies away in a few tenths of a second. Each
 * click is one sample. The CW filter rings with it, at the pitch: a click
 * ticks, and a crash thumps. */
export function qrnCrashes(
  n: number,
  rate: number,
  toneHz: number,
  qrn: number,
  peak: number,
  seed: number,
): Float32Array {
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

  cwFilter(out, rate, toneHz);
  // The loudest crash at the setting's level.
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(out[i]!));
  if (top > 0) {
    const k = ((QRN_LOUD[qrn] ?? 0) * peak) / top;
    for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  }
  return out;
}

/** The FFT's twiddles for each length: cos then sin of each step around
 *  the circle, made once. */
const twiddles = new Map<number, [Float64Array, Float64Array]>();

/** `re` and `im` through a radix-2 FFT, in place. Their length is a power
 *  of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let tw = twiddles.get(n);
  if (!tw) {
    tw = [new Float64Array(n / 2), new Float64Array(n / 2)];
    for (let k = 0; k < n / 2; k++) {
      tw[0][k] = Math.cos((-2 * Math.PI * k) / n);
      tw[1][k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddles.set(n, tw);
  }
  const [cos, sin] = tw;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i]!;
      re[i] = re[j]!;
      re[j] = r;
      const m = im[i]!;
      im[i] = im[j]!;
      im[j] = m;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let at = 0; at < n; at += len) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * stride]!;
        const s = sin[k * stride]!;
        const i = at + k;
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

/** The FFT's length at `rate`: bins 5 Hz apart or closer, fine enough for
 *  the CW filter's skirts. */
function fftSize(rate: number): number {
  return 2 ** Math.ceil(Math.log2(rate / 5));
}

/** `x` through the receiver's CW filter on `toneHz`, in place.
 *
 * Overlap-add, two blocks to one FFT: one in the real part and one in the
 * imaginary part. The filter's response is real and even, so it keeps the
 * two apart. The filter has no delay. */
export function cwFilter(x: Float32Array, rate: number, toneHz: number): void {
  const size = fftSize(rate);
  const block = size / 2;
  const reach = size / 4;
  // The filter's response, its impulse cut to `reach` each side so that a
  // block's ringing does not wrap around into the block.
  const gains = new Float64Array(size);
  for (let k = 0; k <= block; k++) gains[k] = gains[(size - k) % size] = filterGain((k * rate) / size, toneHz);
  const re = Float64Array.from(gains);
  const im = new Float64Array(size);
  fft(re, im);
  for (let t = 0; t < size; t++) {
    const d = Math.min(t, size - t);
    re[t] = d < reach ? (re[t]! * (1 + Math.cos((Math.PI * d) / reach))) / 2 : 0;
  }
  im.fill(0);
  fft(re, im);
  // A forward FFT, then one with real and imaginary swapped, which inverts
  // it: scaled by `size` each time.
  for (let k = 0; k < size; k++) gains[k] = re[k]! / (size * size);
  const out = new Float32Array(x.length);
  const add = (at: number, part: Float64Array) => {
    for (let j = 0; j < size; j++) {
      // The end of the result is the ringing before the block starts.
      const i = at + (j < size - reach ? j : j - size);
      if (i >= 0 && i < out.length) out[i] = out[i]! + part[j]!;
    }
  };
  for (let at = 0; at < x.length; at += 2 * block) {
    re.fill(0);
    im.fill(0);
    for (let j = 0; j < block; j++) {
      re[j] = x[at + j] ?? 0;
      im[j] = x[at + block + j] ?? 0;
    }
    fft(re, im);
    for (let k = 0; k < size; k++) {
      re[k] = re[k]! * gains[k]!;
      im[k] = im[k]! * gains[k]!;
    }
    fft(im, re);
    add(at, re);
    add(at + block, im);
  }
  x.set(out);
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
  const size = fftSize(rate);
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
