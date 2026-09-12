/* Capture integrity: trim dead air, and notice dropped buffers.
 *
 * Ported from core.py. Both matter more in the browser than they did on the
 * command line — a mic capture starts when you click and ends when you click,
 * so there is always dead air at both ends, and an overloaded audio thread
 * drops buffers the same way a busy ffmpeg pipe did.
 */

import { envelope, DEFAULT_BANDWIDTH } from "./envelope";
import { keyingThreshold } from "./threshold";
import { detectTone } from "./tone";
import { percentile } from "./segments";

/** Seconds of silence to keep either side of the keying. */
export const TRIM_PAD = 0.5;

export interface TrimResult {
  samples: Float32Array;
  /** How much was cut from the front — the offset between the original
   *  recording's clock and the trimmed one. */
  leadSec: number;
}

/** Trim dead air from both ends, keeping `pad` seconds of it.
 *
 * Detection runs through the same demodulate-and-threshold the decoder uses,
 * so it keys off the *tone* rather than raw level: room noise or hum on an
 * otherwise idle input won't defeat it.
 *
 * Returns the input untouched when nothing was keyed, when the clip is already
 * shorter than the padding, or when there is nothing to gain. Trimming must
 * never be able to eat audio it can't account for. */
export function trimSilence(
  samples: Float32Array,
  rate: number,
  pad = TRIM_PAD,
  toneHz?: number,
  bandwidth = DEFAULT_BANDWIDTH,
): TrimResult {
  const none: TrimResult = { samples, leadSec: 0 };
  if (samples.length === 0 || pad < 0) return none;
  if (samples.length <= Math.floor(2 * pad * rate)) return none;

  let env: Float32Array;
  let thr: number;
  try {
    const tone = toneHz ?? detectTone(samples, rate);
    env = envelope(samples, rate, tone, bandwidth);
    thr = keyingThreshold(env);
  } catch {
    return none;
  }

  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i]! > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return none;

  const p = Math.floor(pad * rate);
  const start = Math.max(first - p, 0);
  const end = Math.min(last + 1 + p, samples.length);
  if (end - start < Math.floor(0.1 * rate)) return none;
  if (start === 0 && end === samples.length) return none;

  return { samples: samples.subarray(start, end), leadSec: start / rate };
}

/** Times (seconds) where the waveform appears to have been cut.
 *
 * A dropped capture buffer removes a block of samples, so the waveform resumes
 * at an arbitrary phase. That leaves a single-sample jump far larger than
 * anything the signal's own frequency content can produce — a click to the ear,
 * a shortened dit or dah to the decoder.
 *
 * The threshold is relative to the signal's own 99.9th-percentile slew, so it
 * adapts to level and tone frequency instead of assuming either. Measured
 * against real captures that ratio is ~1.04 for clean recordings and 1.5 at
 * worst under heavy noise, against 4.1-5.2 for captures with dropped buffers,
 * so `factor` sits between with margin on both sides. */
export function findDropouts(
  samples: Float32Array,
  rate: number,
  factor = 2.5,
): number[] {
  if (samples.length < 64) return [];

  const dx: number[] = new Array(samples.length - 1);
  for (let i = 1; i < samples.length; i++) {
    dx[i - 1] = Math.abs(samples[i]! - samples[i - 1]!);
  }
  const ref = percentile(dx, 99.9);
  if (!(ref > 0)) return [];

  const limit = factor * ref;
  const minGap = Math.floor(rate / 100); // one dropped buffer, counted once
  const hits: number[] = [];
  let lastIdx = -Infinity;
  for (let i = 0; i < dx.length; i++) {
    if (dx[i]! <= limit) continue;
    if (i - lastIdx > minGap) hits.push(i / rate);
    lastIdx = i;
  }
  return hits;
}
