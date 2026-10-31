/* The band under a generated station: noise, QRN, and QRM, mixed as one.
 *
 * QRM is another QSO near the frequency. As on the air, one side of it is
 * heard well, and the other weakly or not at all: the quiet while that side
 * sends is quiet here too. Between its QSOs the frequency is quiet a while.
 * It sits off the pitch, through the same receiver filter as the station,
 * which takes some of it away, and fades on its own as any station does.
 *
 * Pure. The Copy page adds it to its samples; the QSO page loops it.
 */

import { bandNoise, biquad, fadeOf, noiseLevel, noiseOn, qrnCrashes, seeded, seedOf } from "@/audio/qsb";
import { synthesize } from "@/audio/synth";
import type { Speed } from "@/qso/speed";
import { targetTiming } from "@/timing";

/** The QRM slider's lowest place, in dB under the station's peak: there it
 *  is off. */
export const QRM_OFF_DB = -40;

/** The loudest QRM the slider sets, in dB under the station's peak. */
export const QRM_MAX_DB = -6;

/** The QRM slider's step, in dB. */
export const QRM_STEP_DB = 2;

/** Whether QRM at `qrmDb` plays at all. */
export function qrmOn(qrmDb: number): boolean {
  return qrmDb > QRM_OFF_DB;
}

/** How far the QRM station is from the band's pitch, in Hz. */
const QRM_APART_HZ = [200, 400] as const;

/** The receiver filter QRM comes through: on the station's pitch, about
 *  300 Hz wide. */
const QRM_FILTER_Q = 2;

/** The silence between one QRM line and the next, in seconds. */
const QRM_GAP_SEC = [0.8, 2.5] as const;

/** The quiet between one QRM QSO and the next, in seconds. */
const QRM_REST_SEC = [8, 40] as const;

/** The far side of a QRM QSO: heard this far under the near side, in dB,
 *  when it is heard at all. */
const FAR_DB = -18;

/** How often the far side is heard at all. */
const FAR_HEARD = 0.4;

/** One line the QRM station sends. */
export interface QrmLine {
  readonly text: string;
  readonly speed: Speed;
  readonly call: string;
  /** Which station of its QSO sends it. */
  readonly station: number;
}

export interface BandOptions {
  /** Samples, and their rate. */
  readonly n: number;
  readonly rate: number;
  /** The pitch the band sits on: the station's, or the middle of several. */
  readonly toneHz: number;
  /** The station's peak, which the levels are under. */
  readonly peak: number;
  readonly noiseDb: number;
  /** An index into `QRN_LEVELS`. */
  readonly qrn: number;
  readonly qrmDb: number;
  /** How deep the QRM station fades. */
  readonly qsbDb: number;
  readonly seed: number;
  /** The QRM station's next QSO, as lines. */
  readonly qrmLines: (rand: () => number) => readonly QrmLine[];
}

/** Whether a band with these settings holds anything. */
export function bandOn(o: { noiseDb: number; qrn: number; qrmDb: number }): boolean {
  return noiseOn(o.noiseDb) || o.qrn > 0 || qrmOn(o.qrmDb);
}

/** The band, `n` samples of it. Silent when every part is off. */
export function bandAudio(o: BandOptions): Float32Array {
  const { n, rate, toneHz, peak } = o;
  const out = noiseOn(o.noiseDb)
    ? bandNoise(n, rate, toneHz, noiseLevel(peak, o.noiseDb), o.seed)
    : new Float32Array(n);
  if (o.qrn > 0) {
    const crashes = qrnCrashes(n, rate, o.qrn, peak, o.seed + 1);
    for (let i = 0; i < n; i++) out[i] = out[i]! + crashes[i]!;
  }
  if (qrmOn(o.qrmDb)) {
    const rand = seeded(o.seed + 2);
    const [lo, hi] = QRM_APART_HZ;
    const apart = lo + rand() * (hi - lo);
    const qrmHz = rand() < 0.5 ? toneHz - apart : toneHz + apart;
    const amplitude = peak * Math.pow(10, o.qrmDb / 20);
    const [gapLo, gapHi] = QRM_GAP_SEC;
    const [restLo, restHi] = QRM_REST_SEC;
    const qrm = new Float32Array(n);
    let at = Math.round(rand() * restHi * rate);
    while (at < n) {
      const lines = o.qrmLines(rand);
      if (lines.length === 0) break;
      const near = lines[0]!.station;
      const farGain = rand() < FAR_HEARD ? Math.pow(10, FAR_DB / 20) : 0;
      for (const line of lines) {
        if (at >= n) break;
        const timing = targetTiming(line.speed.charWpm, line.speed.farnsworthWpm);
        const sound = synthesize(line.text, timing, { rate, toneHz: qrmHz, padSec: 0, amplitude }).samples;
        // Not cut off at the end: a band that loops would chop a letter.
        if (at + sound.length > n) {
          at = n;
          break;
        }
        const fade = fadeOf(o.qsbDb, seedOf(line.call));
        const gain = line.station === near ? 1 : farGain;
        if (gain > 0) for (let i = 0; i < sound.length; i++) qrm[at + i] = sound[i]! * gain * fade((at + i) / rate);
        at += sound.length + Math.round((gapLo + rand() * (gapHi - gapLo)) * rate);
      }
      at += Math.round((restLo + rand() * (restHi - restLo)) * rate);
    }
    biquad(qrm, rate, "band", toneHz, QRM_FILTER_Q);
    for (let i = 0; i < n; i++) out[i] = out[i]! + qrm[i]!;
  }
  return out;
}

/** Where the limiter starts to round peaks off. */
const KNEE = 0.85;

/** `x`, untouched under `KNEE`, and rounded off above it so it never
 *  reaches full scale. */
export function limited(x: number): number {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
}

/** `samples` with the band mixed in under them, in place, when it holds
 *  anything. Room is left for QRM keyed on top of a station, and a crash
 *  past that is rounded off near full scale, as a receiver's AGC does.
 *  With `level`, the band at each sample is scaled by it: 0 cuts it. */
export function addBand(samples: Float32Array, o: Omit<BandOptions, "n">, level?: Float32Array): void {
  if (!bandOn(o)) return;
  const noise = bandAudio({ ...o, n: samples.length });
  const room = 1 / (1 + (qrmOn(o.qrmDb) ? Math.pow(10, o.qrmDb / 20) : 0));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = limited((samples[i]! + noise[i]! * (level ? level[i]! : 1)) * room);
  }
}
