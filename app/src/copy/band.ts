/* The band under a generated station: noise, QRN, and QRM, mixed as one.
 *
 * QRM is another QSO near the frequency. As on the air, one side of it is
 * heard well, and the other weakly or not at all: the quiet while that side
 * sends is quiet here too. Between its QSOs the frequency is quiet a while.
 * It sits near the pitch, inside the receiver's CW filter, at a pitch of its
 * own, and fades on its own as any station does.
 *
 * QRM is FT8 now and then too: a few stations near the pitch, strong or
 * weak, each sending in its 15 s slots for a while, then gone.
 *
 * Pure. The Copy page adds it to its samples; the QSO page loops it.
 */

import { agcGainDb, applyGainDb, loudnessDb, type AgcMode } from "@/audio/agc";
import { bandNoise, cwFilter, fadeOf, noiseLevel, noiseOn, qrnCrashes, seeded, seedOf } from "@/audio/qsb";
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

/** How far the QRM station is from the band's pitch, in Hz: inside the CW
 *  filter, or at its edge, where the filter takes some of it away. */
const QRM_APART_HZ = [50, 250] as const;

/** The silence between one QRM line and the next, in seconds. */
const QRM_GAP_SEC = [0.8, 2.5] as const;

/** The quiet between one QRM QSO and the next, in seconds. */
const QRM_REST_SEC = [8, 40] as const;

/** The far side of a QRM QSO: heard this far under the near side, in dB,
 *  when it is heard at all. */
const FAR_DB = -18;

/** How often the far side is heard at all. */
const FAR_HEARD = 0.4;

/** FT8's timing: 15 s slots; in each, 79 tones from 0.5 s in, one every
 *  0.16 s. */
const FT8_SLOT_SEC = 15;
const FT8_START_SEC = 0.5;
const FT8_SYMBOL_SEC = 0.16;
const FT8_SYMBOLS = 79;

/** FT8's 8 tones, this far apart, in Hz. */
const FT8_SPACING_HZ = 6.25;

/** The tones FT8 starts, ends and is split with, so a receiver finds it. */
const FT8_COSTAS = [3, 1, 4, 0, 6, 5, 2];

/** How long a tone takes to glide to the next, and the signal to come up
 *  and die away, in seconds. */
const FT8_GLIDE_SEC = 0.02;

/** How long FT8 is on the band, and then off it, in seconds. */
const FT8_ON_SEC = [30, 90] as const;
const FT8_OFF_SEC = [30, 120] as const;

/** How many FT8 stations are on at once. */
const FT8_STATIONS = [1, 3] as const;

/** How far an FT8 station is from the pitch, in Hz: across the CW filter
 *  and out past its edges. */
const FT8_APART_HZ = 300;

/** The loudest FT8 station, in dB under the QRM slider's level: as loud, or
 *  well under it. The others are weaker still, by up to `FT8_WEAKER_DB`. */
const FT8_LOUDEST_DB = [-20, 0] as const;
const FT8_WEAKER_DB = 24;

/** How often an FT8 station sends in a slot of its own. */
const FT8_SENDS = 0.8;

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
  /** The receiver's AGC, where the band is mixed in. Absent: off. */
  readonly agc?: AgcMode;
}

/** Whether a band with these settings holds anything. */
export function bandOn(o: { noiseDb: number; qrn: number; qrmDb: number }): boolean {
  return noiseOn(o.noiseDb) || o.qrn > 0 || qrmOn(o.qrmDb);
}

/** What the band's parts are made from. Their levels are not here: the
 *  parts are mixed at them. */
export type PartOptions = Omit<BandOptions, "noiseDb" | "qrmDb">;

/** The band noise, at the station's peak: mixed at its slider's level. */
export function noisePart(o: PartOptions): Float32Array {
  return bandNoise(o.n, o.rate, o.toneHz, o.peak, o.seed);
}

/** QRN at its setting. Null when it is off. */
export function qrnPart(o: PartOptions): Float32Array | null {
  return o.qrn > 0 ? qrnCrashes(o.n, o.rate, o.toneHz, o.qrn, o.peak, o.seed + 1) : null;
}

/** FT8 now and then, into `out`, at `peak` and under it: its stations
 *  come on the band a while, then go. */
function addFt8(out: Float32Array, o: PartOptions): void {
  const { rate, toneHz, peak } = o;
  const n = out.length;
  const rand = seeded(o.seed + 3);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const slot = Math.round(FT8_SLOT_SEC * rate);
  const symbol = FT8_SYMBOL_SEC * rate;
  const glide = FT8_GLIDE_SEC * rate;
  let from = between(0, FT8_OFF_SEC[1]) * rate;
  while (from < n) {
    const to = from + between(...FT8_ON_SEC) * rate;
    const count = Math.round(between(FT8_STATIONS[0] - 0.49, FT8_STATIONS[1] + 0.49));
    const loudest = between(...FT8_LOUDEST_DB);
    for (let k = 0; k < count; k++) {
      const baseHz = toneHz + between(-FT8_APART_HZ, FT8_APART_HZ);
      const gain = peak * Math.pow(10, (loudest - (k === 0 ? 0 : between(0, FT8_WEAKER_DB))) / 20);
      const parity = rand() < 0.5 ? 0 : 1;
      const fade = fadeOf(o.qsbDb, Math.floor(rand() * 2 ** 31));
      // Its slots in this while on the band: every other one.
      for (let s = Math.ceil(from / slot); s * slot < Math.min(to, n); s++) {
        if (s % 2 !== parity || rand() >= FT8_SENDS) continue;
        const tones = Array.from({ length: FT8_SYMBOLS }, () => Math.floor(rand() * 8));
        for (const at of [0, 36, 72]) FT8_COSTAS.forEach((t, i) => (tones[at + i] = t));
        const start = s * slot + Math.round(FT8_START_SEC * rate);
        const len = Math.round(FT8_SYMBOLS * symbol);
        let phase = rand() * 2 * Math.PI;
        for (let i = 0; i < len && start + i < n; i++) {
          // The tone, gliding to the next across each boundary.
          const at = Math.min(FT8_SYMBOLS - 1, Math.floor(i / symbol));
          const into = i - at * symbol;
          let tone = tones[at]!;
          if (at + 1 < FT8_SYMBOLS && into > symbol - glide / 2) {
            const u = (into - (symbol - glide / 2)) / glide;
            tone += (tones[at + 1]! - tone) * (1 - Math.cos(Math.PI * u)) / 2;
          } else if (at > 0 && into < glide / 2) {
            const u = (into + glide / 2) / glide;
            tone = tones[at - 1]! + (tone - tones[at - 1]!) * (1 - Math.cos(Math.PI * u)) / 2;
          }
          phase += (2 * Math.PI * (baseHz + tone * FT8_SPACING_HZ)) / rate;
          const edge = Math.min(1, i / glide, (len - i) / glide);
          out[start + i] = out[start + i]! + Math.sin(phase) * gain * edge * fade((start + i) / rate);
        }
      }
    }
    from = to + between(...FT8_OFF_SEC) * rate;
  }
}

/** The QRM station, keyed at the station's peak, and FT8 now and then:
 *  mixed at the QRM slider's level. */
export function qrmPart(o: PartOptions): Float32Array {
  const { n, rate, toneHz, peak } = o;
  const rand = seeded(o.seed + 2);
  const [lo, hi] = QRM_APART_HZ;
  const apart = lo + rand() * (hi - lo);
  const qrmHz = rand() < 0.5 ? toneHz - apart : toneHz + apart;
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
      const sound = synthesize(line.text, timing, { rate, toneHz: qrmHz, padSec: 0, amplitude: peak }).samples;
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
  addFt8(qrm, o);
  cwFilter(qrm, rate, toneHz);
  return qrm;
}

/** The band's parts, each null when off. */
export interface BandParts {
  readonly noise: Float32Array | null;
  readonly qrn: Float32Array | null;
  readonly qrm: Float32Array | null;
}

/** `parts` mixed as one, `n` samples, with the noise and QRM at their
 *  sliders' levels. */
export function mixBand(n: number, parts: BandParts, levels: { noiseDb: number; qrmDb: number }): Float32Array {
  const out = new Float32Array(n);
  const add = (part: Float32Array | null, gain: number) => {
    if (part && gain > 0) for (let i = 0; i < n; i++) out[i] = out[i]! + part[i]! * gain;
  };
  add(parts.noise, noiseLevel(1, levels.noiseDb));
  add(parts.qrn, 1);
  add(parts.qrm, qrmOn(levels.qrmDb) ? Math.pow(10, levels.qrmDb / 20) : 0);
  return out;
}

/** The band, `n` samples of it. Silent when every part is off. */
export function bandAudio(o: BandOptions): Float32Array {
  return mixBand(
    o.n,
    {
      noise: noiseOn(o.noiseDb) ? noisePart(o) : null,
      qrn: qrnPart(o),
      qrm: qrmOn(o.qrmDb) ? qrmPart(o) : null,
    },
    o,
  );
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
 *  past that is rounded off near full scale. With `level`, the band at each
 *  sample is scaled by it: 0 cuts it, as while you send. The AGC acts on
 *  what is received, the station and the band, and not where `level` is 0. */
export function addBand(samples: Float32Array, o: Omit<BandOptions, "n">, level?: Float32Array): void {
  if (!bandOn(o)) return;
  const n = samples.length;
  const noise = bandAudio({ ...o, n });
  const room = 1 / (1 + (qrmOn(o.qrmDb) ? Math.pow(10, o.qrmDb / 20) : 0));
  const heard = (i: number) => (level ? level[i]! : 1);
  if (!o.agc || o.agc === "off") {
    for (let i = 0; i < n; i++) samples[i] = limited((samples[i]! + noise[i]! * heard(i)) * room);
    return;
  }
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = samples[i]! + noise[i]! * heard(i);
  const gain = new Float32Array(n).fill(1);
  applyGainDb(gain, o.rate, agcGainDb(loudnessDb(mix, o.rate, o.peak, level), o.agc));
  for (let i = 0; i < n; i++) {
    const g = gain[i]!;
    const h = heard(i);
    samples[i] = limited((samples[i]! * (1 + (g - 1) * h) + noise[i]! * h * g) * room);
  }
}
