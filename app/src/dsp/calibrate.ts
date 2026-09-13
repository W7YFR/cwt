/* Measuring a microphone and a room, once, so every later take can be read
 * against them.
 *
 * Everything else in dsp/ works from a single recording and has to infer what
 * it can. That gets a long way — a moving level, a mark broken by ripple, a
 * threshold sitting at the wrong height on a slow edge — but it cannot get all
 * the way, and the reason is worth stating precisely.
 *
 * A room delays every release by a fixed amount. Measured against a loopback
 * capture of the same keying, one microphone four feet from a speaker adds
 * about twelve milliseconds to the end of every mark, and takes the same from
 * the gap that follows: dits, dahs, iambic, isolated elements and ordinary
 * text all get the same twelve. Nothing about a single recording reveals that
 * number. The obvious approaches were tried and do not work — the tail has a
 * discrete reflection sitting on it, so there is no knee to find, and fitting
 * the decay and extrapolating back gives answers with a spread of seconds.
 *
 * What does reveal it is sending something whose true length is already known.
 * An iambic keyer holding a dit is a machine: the elements are exactly one
 * unit, whatever the operator's skill, because the keyer supplies the timing
 * and the operator only supplies the intent. So a few seconds of held paddle
 * at a stated speed measures the offset directly, and a stored offset makes
 * every later recording from that setup readable.
 *
 * The measurement is taken with the edge correction at FULL strength, and that
 * is not incidental. Under partial correction the residual error depends on
 * what was being sent — it came out at +12.2 ms on a dit drill and +7.6 ms on
 * ordinary text through the same microphone in the same room, which is not a
 * property of anything and cannot be stored. At full strength the same five
 * recordings agree to within a millisecond. Only then is there a single number
 * to write down.
 */

import type { Segment } from "@/types";

/** What a microphone and a room do to keying, as a stored profile. */
export interface Calibration {
  /** Character speed the calibration was keyed at. */
  readonly wpm: number;
  /** Seconds to take off every mark and give back to the gap after it. */
  readonly releaseOffsetSec: number;
  /** How much the offset varied across the elements it was measured from.
   *  Small means the profile describes a room; large means something else was
   *  going on and the number should not be leaned on. */
  readonly spreadSec: number;
  /** How many elements went into it. */
  readonly elements: number;
}

/** A calibration that corrects nothing.
 *
 * Used to take the measurement in the first place: the edge correction has to
 * run at full strength for the residual to be a constant worth measuring, and
 * declaring a zero-offset profile is how that is asked for. */
export const PROBE: Calibration = {
  wpm: 0,
  releaseOffsetSec: 0,
  spreadSec: 0,
  elements: 0,
};

/** Most of a mark that may be taken off it.
 *
 * A guard, not a tuning knob. If a profile from one setup is ever applied to a
 * recording made at a much higher speed, the offset could exceed the elements
 * themselves; shrinking a mark to nothing would turn it into a gap and invent
 * a character. Better to under-correct and let the numbers look wrong. */
const MAX_SHRINK = 0.6;

/** Take the release offset off every mark, giving it back to the gap that
 *  follows so the total length of the recording is unchanged. */
export function applyReleaseOffset(
  segs: readonly Segment[],
  offsetSec: number,
): Segment[] {
  const out: Segment[] = segs.map((s) => [s[0], s[1]] as Segment);
  if (!(offsetSec > 0)) return out;

  for (let i = 0; i < out.length - 1; i++) {
    const mark = out[i]!;
    const gap = out[i + 1]!;
    if (mark[0] !== 1 || gap[0] !== 0) continue;
    const take = Math.min(offsetSec, mark[1] * MAX_SHRINK);
    out[i] = [1, mark[1] - take];
    out[i + 1] = [0, gap[1] + take];
  }
  return out;
}

/** One recording in a calibration set: a drill of elements all the same length.
 *
 * `units` is what the keyer was sending — 1 for a held dit paddle, 3 for a held
 * dah paddle. Uniform drills only, deliberately: a mixed recording would need
 * the elements sorted into classes before anything could be measured, and
 * getting that wrong would quietly corrupt the profile. Holding a paddle
 * removes the question. */
export interface CalibrationDrill {
  /** Element lengths the segmenter found, in seconds. */
  readonly marks: readonly number[];
  readonly units: number;
}

function median(v: readonly number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** How far each drill's elements sit from the length they were keyed at. */
export function drillOffsetSec(drill: CalibrationDrill, wpm: number): number {
  if (!(wpm > 0) || drill.marks.length === 0) return NaN;
  const trueSec = (drill.units * 1.2) / wpm;
  return median(drill.marks) - trueSec;
}

/** Build a profile from a set of drills keyed at a known speed.
 *
 * The offset is the median across drills rather than across every element, so
 * one drill that went wrong — a paddle that slipped, a door closing — moves
 * the answer by nothing rather than in proportion to how many elements it
 * happened to contain. */
export function measureCalibration(
  drills: readonly CalibrationDrill[],
  wpm: number,
): Calibration {
  const offsets = drills
    .map((d) => drillOffsetSec(d, wpm))
    .filter((v) => Number.isFinite(v));

  if (offsets.length === 0) {
    return { wpm, releaseOffsetSec: 0, spreadSec: 0, elements: 0 };
  }

  const offset = median(offsets);
  const spread = offsets.length > 1 ? Math.max(...offsets) - Math.min(...offsets) : 0;
  const elements = drills.reduce((a, d) => a + d.marks.length, 0);

  return {
    wpm,
    // A room can only ever delay a release. A negative answer means the
    // measurement is of something else, and correcting by it would lengthen
    // every mark for no reason.
    releaseOffsetSec: Math.max(0, offset),
    spreadSec: spread,
    elements,
  };
}

/** Is this profile worth applying?
 *
 * An offset measured from drills that disagreed with each other is not a
 * description of a room. The threshold is a quarter of a dit at the speed the
 * calibration was keyed at — beyond that the drills are not measuring one
 * thing, and the honest move is to ignore the profile rather than to correct
 * every future recording by an average of whatever went wrong. */
export function calibrationIsUsable(c: Calibration): boolean {
  if (!(c.wpm > 0) || c.elements < 4) return false;
  const ditSec = 1.2 / c.wpm;
  return c.spreadSec <= 0.25 * ditSec;
}

/** Is there anything here to correct?
 *
 * A calibration whose offset is smaller than the disagreement between the
 * drills it came from has not measured a correction; it has measured its own
 * noise. Saving one would record a profile that changes nothing — the apply
 * step already returns early on a zero offset — while every report made under
 * it claims a calibration was in force.
 *
 * The criterion is the measurement's own resolution rather than a number
 * chosen to look reasonable, and the corpus separates cleanly on it:
 *
 * | setup                          | offset  | drills disagree by |
 * |--------------------------------|---------|--------------------|
 * | loopback, ft710 sweep          | 0.44 ms | 0.63 ms            |
 * | loopback, k3ng drills          | 0.38 ms | 0.50 ms            |
 * | webcam a few inches away       | 2.75 ms | 1.00 ms            |
 * | webcam at four feet            | 13.3 ms | 0.38 ms            |
 *
 * Both paths with nothing in them fall below their own spread; both real
 * microphones clear it, the far one by thirty-five times. It also scales
 * itself: a noisy measurement has to find a larger offset before that offset
 * means anything, which is the behavior wanted. */
export function correctsNothing(c: Calibration): boolean {
  return !(c.releaseOffsetSec > c.spreadSec);
}
