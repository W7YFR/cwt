/* The keying schedule for the target track. Pure — it produces envelope
 * breakpoints, not sound.
 *
 * Both the live playback and the offline render read this, which is what makes
 * the downloaded target WAV the same performance you just heard. When they each
 * built their own schedule they disagreed about the padding, and the file
 * started a beat earlier than the playhead said it should.
 */

import type { Timeline } from "@/types";

/** Raised-cosine edge length. Mirrors the synthesizer's ramp so a played mark
 *  and a rendered one have the same shape, and so neither clicks. */
export const RAMP_SEC = 0.005;

export interface Envelope {
  /** [time, value] breakpoints for a gain node, in seconds from the start. */
  points: Array<readonly [number, number]>;
  /** Total length to run the oscillator for. */
  duration: number;
}

export interface ScheduleOptions {
  /** Peak amplitude. Matched to the recording's own peak so an A/B compares
   *  timing rather than loudness. */
  readonly peak: number;
  /** Silence either side, seconds. The same padding a trimmed capture keeps,
   *  so the two tracks are consistent and the target does not stop dead on its
   *  last element. */
  readonly padSec: number;
  /** Play only this window of the timeline; omit for the whole thing. */
  readonly from?: number;
  readonly to?: number;
}

/** Gain breakpoints that key `timeline`'s marks on and off.
 *
 * Times are relative to the start of playback, so the caller adds its own
 * context clock offset and nothing here needs to know when "now" is. */
export function keyingEnvelope(
  timeline: Timeline,
  options: ScheduleOptions,
): Envelope {
  const { peak, padSec } = options;
  const full = options.to === undefined;
  // Times here are timeline times, so a negative start is just lead-in.
  const start = full ? -padSec : (options.from ?? 0);
  const end = full ? timeline.duration + padSec : options.to!;

  const points: Array<readonly [number, number]> = [];
  for (const b of timeline.blocks) {
    if (b.kind !== "dit" && b.kind !== "dah") continue;
    if (!(b.t1 > start && b.t0 < end)) continue;
    const a = Math.max(b.t0 - start, 0);
    const z = Math.min(b.t1, end) - start;
    if (z <= a) continue;
    points.push(
      [a, 0],
      [a + Math.min(RAMP_SEC, (z - a) / 2), peak],
      [Math.max(z - RAMP_SEC, a + RAMP_SEC), peak],
      [z, 0],
    );
  }

  return { points, duration: Math.max(end - start, 0.05) };
}
