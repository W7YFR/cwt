/* Is there any keying in this recording at all?
 *
 * Without this question being asked, silence decodes. Ten seconds of a room
 * with nobody in it comes back as ninety to a hundred and eighty elements,
 * because every stage downstream is built to find structure in what it is
 * given and none of them is allowed to say "there is nothing here". The
 * threshold splits the noise into a loud half and a quiet half, the segmenter
 * runs the crossings, and the glitch floor — sized from the very shards it is
 * meant to remove — is far too small to condemn them. The result reads like a
 * decode and is entirely invented.
 *
 * The measure is deliberately not a level. Levels do not survive peak
 * normalization, which the app applies to everything: a nearly-silent file
 * scaled up by a factor of a thousand has exactly the same amplitudes as a
 * loud one. What distinguishes silence from keying is not how big the numbers
 * are but whether any single frequency dominates the CW band — a tone stands
 * up out of the noise, and room rumble, hum and hiss do not.
 *
 * So: sweep the band, take the strongest bin over the median bin. On this
 * corpus that is 1.5 for white noise, 1.8 to 38 for four real silent
 * recordings, and 679 at worst for real keying — the poorest being a webcam
 * across the room hearing isolated dits. The gap is more than an order of
 * magnitude wide on both sides of the threshold below, which is the only
 * reason a single scalar is defensible here.
 *
 * One sound passes that test and is not keying: noise through a narrow
 * filter, as a line cleaned up for CW has. The filter makes the noise peak in
 * the band, broadly. A tone is narrow. So the peak must also stand above the
 * bins just beside it: see `KEYING_NARROWNESS`.
 *
 * The failure direction is safe. Something that is not keying but does hold a
 * dominant tone — a carrier, a whistle — passes, and is then decoded as badly
 * as it would have been before this existed. Nothing that was working stops.
 */

import { decimate } from "./filters";
import { goertzelPower, TONE_MAX_HZ, TONE_MIN_HZ } from "./tone";

/** How far the strongest bin must stand above the median of the band.
 *
 * Set between two populations rather than at the edge of one: 2.6x above the
 * most tonal silence in the corpus, 6.8x below the least tonal real keying,
 * and 1.9x below synthetic keying at 0 dB SNR — noise as loud as the signal,
 * which is past anything the decoder can read anyway. */
export const KEYING_PROMINENCE = 100;

/** How far the strongest bin must stand above the bins 50 to 150 Hz either
 *  side of it.
 *
 * A keyed tone is a few hertz wide, so its neighbours hold only the noise.
 * Filtered noise is a broad hump, so its neighbours are nearly as strong:
 * 7.0 to 10.9 on a line through a 550 Hz band-pass with nobody keying, and
 * 1.6 to 3.0 for silence. Real keying measured 138 at worst, single dits
 * through a webcam across the room. 35 sits more than 3x from both. White
 * noise is flat, so this asks no more of keying in white noise than the band
 * test does. */
export const KEYING_NARROWNESS = 35;

/** The neighbours: this far either side of the strongest bin, Hz. */
const NEAR_FROM_HZ = 50;
const NEAR_TO_HZ = 150;

/** Step for the narrow look around the strongest bin, Hz. Fine enough that
 *  the tone itself is not missed between steps. */
const FINE_STEP_HZ = 5;

/** Rate to survey at. Comfortably above twice the top of the band, and the
 *  same choice tone.ts makes, so both see the same spectrum. */
const SURVEY_RATE = 4000;

/** Bin width, Hz. Short blocks: wide bins, so the sweep cannot fall between
 *  two of them and miss a tone that is really there. */
const BIN_HZ = 8;

/** Sweep step, Hz. Coarse — this is a yes-or-no question about the band, not
 *  a measurement of the frequency, which tone.ts does properly. */
const STEP_HZ = 25;

export interface Presence {
  /** Strongest bin in the CW band over the median bin. Dimensionless, and
   *  unchanged by scaling the input, which is what makes it usable after
   *  peak normalization. */
  readonly prominence: number;
  /** Strongest bin over the bins just beside it. Unchanged by scaling too. */
  readonly narrowness: number;
  /** Whether anything in here is worth decoding. */
  readonly keyed: boolean;
}

function medianOf(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Look for a tone in the CW band, and say whether one is there. */
export function tonePresence(samples: Float32Array, rate: number): Presence {
  const none: Presence = { prominence: 0, narrowness: 0, keyed: false };
  if (samples.length === 0) return none;

  const factor = Math.max(1, Math.floor(rate / SURVEY_RATE));
  const x = decimate(samples, factor);
  const r = rate / factor;

  const hi = Math.min(TONE_MAX_HZ, r / 2 - 10);
  const lo = Math.min(TONE_MIN_HZ, hi);
  if (!(hi > lo)) return none;

  // Blocked rather than one transform over the whole clip: summing the power
  // of many short blocks averages the noise down without narrowing the bin,
  // and a keyed tone that is only present a third of the time still
  // accumulates across every block it appears in.
  const blockLen = Math.max(16, Math.min(x.length, Math.round(r / BIN_HZ)));
  const power = (f: number) => {
    let total = 0;
    for (let at = 0; at + blockLen <= x.length; at += blockLen) {
      total += goertzelPower(x, r, f, at, at + blockLen);
    }
    return total;
  };
  const powers: number[] = [];
  let strongest = lo;
  let most = -1;
  for (let f = lo; f <= hi + 1e-9; f += STEP_HZ) {
    const p = power(f);
    if (p > most) {
      most = p;
      strongest = f;
    }
    powers.push(p);
  }
  if (powers.length === 0) return none;

  const peak = Math.max(...powers);
  const floor = medianOf(powers);
  // Digital silence: no power anywhere, so there is no ratio to take. Not
  // keyed, and saying so is the whole point.
  if (!(peak > 0)) return none;

  // A floor of exactly zero is a tone with no noise under it anywhere else in
  // the band, which is as prominent as a tone can get.
  const prominence = floor > 0 ? peak / floor : Infinity;
  if (prominence < KEYING_PROMINENCE) return { prominence, narrowness: 0, keyed: false };
  const narrowness = narrownessAt(power, strongest, r);
  return { prominence, narrowness, keyed: narrowness >= KEYING_NARROWNESS };
}

/** The strongest bin near `around`, found at a finer step, over the median of
 *  the bins `NEAR_FROM_HZ` to `NEAR_TO_HZ` either side of it. */
function narrownessAt(power: (f: number) => number, around: number, rate: number): number {
  let top = 0;
  let at = around;
  for (let f = around - STEP_HZ; f <= around + STEP_HZ; f += FINE_STEP_HZ) {
    const p = power(f);
    if (p > top) {
      top = p;
      at = f;
    }
  }
  const near: number[] = [];
  for (let d = NEAR_FROM_HZ; d <= NEAR_TO_HZ; d += FINE_STEP_HZ) {
    for (const f of [at - d, at + d]) if (f > 0 && f < rate / 2) near.push(power(f));
  }
  const floor = medianOf(near);
  if (!(top > 0)) return 0;
  return floor > 0 ? top / floor : Infinity;
}
