/* Measuring a room once, and what the profile is allowed to do afterwards.
 *
 * The arithmetic here is small; the care is all in the guards. A stored
 * profile gets applied to every future recording from a setup, so a profile
 * built from a bad calibration would corrupt everything quietly and for a long
 * time. Most of what follows is about refusing to produce one.
 */

import { describe, expect, it } from "vitest";
import {
  applyReleaseOffset,
  calibrationIsUsable,
  drillOffsetSec,
  measureCalibration,
  type Calibration,
} from "@/dsp/calibrate";
import type { Segment } from "@/types";

const WPM = 15;
const DIT = 1.2 / WPM; // 0.08 s
const DAH = 3 * DIT;

function drill(units: number, lengthSec: number, n = 20) {
  return { marks: Array.from({ length: n }, () => lengthSec), units };
}

describe("taking the offset off a recording", () => {
  it("shortens every mark and lengthens the gap after it", () => {
    const segs: Segment[] = [[0, 0.1], [1, 0.09], [0, 0.07], [1, 0.25], [0, 0.1]];
    const out = applyReleaseOffset(segs, 0.01);
    expect(out[1]![1]).toBeCloseTo(0.08, 9);
    expect(out[2]![1]).toBeCloseTo(0.08, 9);
    expect(out[3]![1]).toBeCloseTo(0.24, 9);
    expect(out[4]![1]).toBeCloseTo(0.11, 9);
  });

  it("leaves the recording exactly as long as it was", () => {
    // The offset moves a boundary; it does not delete time. If the total
    // changed, every timestamp after the first mark would drift.
    const segs: Segment[] = [[0, 0.1], [1, 0.09], [0, 0.07], [1, 0.25], [0, 0.1]];
    const before = segs.reduce((a, s) => a + s[1], 0);
    for (const off of [0, 0.005, 0.02, 0.5]) {
      const after = applyReleaseOffset(segs, off).reduce((a, s) => a + s[1], 0);
      expect(after, `offset ${off}`).toBeCloseTo(before, 9);
    }
  });

  it("does nothing at all for a zero or negative offset", () => {
    const segs: Segment[] = [[0, 0.1], [1, 0.09], [0, 0.07]];
    for (const off of [0, -0.01]) {
      expect(applyReleaseOffset(segs, off)).toEqual(segs);
    }
  });

  it("never eats a mark, however large the offset", () => {
    // The case that would invent characters: a profile from a slow setup
    // applied to fast sending. Under-correcting is recoverable; turning a mark
    // into a gap is not.
    const segs: Segment[] = [[0, 0.1], [1, 0.02], [0, 0.02], [1, 0.02], [0, 0.1]];
    const out = applyReleaseOffset(segs, 1);
    for (const s of out) expect(s[1], `${s[0] === 1 ? "mark" : "gap"}`).toBeGreaterThan(0);
    expect(out[1]![1]).toBeGreaterThanOrEqual(0.02 * 0.4 - 1e-9);
  });

  it("does not modify the segments it was given", () => {
    const segs: Segment[] = [[0, 0.1], [1, 0.09], [0, 0.07]];
    const copy = segs.map((s) => [s[0], s[1]] as Segment);
    applyReleaseOffset(segs, 0.01);
    expect(segs).toEqual(copy);
  });

  it("leaves a mark with no gap after it alone", () => {
    // Nothing to give the time back to, so taking it would shorten the file.
    const segs: Segment[] = [[0, 0.1], [1, 0.09]];
    expect(applyReleaseOffset(segs, 0.01)[1]![1]).toBe(0.09);
  });
});

describe("measuring the offset from a drill", () => {
  it("is the difference between what was measured and what was keyed", () => {
    expect(drillOffsetSec(drill(1, DIT + 0.012), WPM)).toBeCloseTo(0.012, 9);
    expect(drillOffsetSec(drill(3, DAH + 0.012), WPM)).toBeCloseTo(0.012, 9);
  });

  it("has nothing to say about an empty drill or an impossible speed", () => {
    expect(drillOffsetSec({ marks: [], units: 1 }, WPM)).toBeNaN();
    expect(drillOffsetSec(drill(1, DIT), 0)).toBeNaN();
  });
});

describe("building a profile", () => {
  it("agrees with drills that agree with each other", () => {
    const c = measureCalibration([drill(1, DIT + 0.012), drill(3, DAH + 0.012)], WPM);
    expect(c.releaseOffsetSec).toBeCloseTo(0.012, 9);
    expect(c.spreadSec).toBeCloseTo(0, 9);
    expect(c.elements).toBe(40);
    expect(calibrationIsUsable(c)).toBe(true);
  });

  it("takes the median across drills, not across elements", () => {
    // One drill that went wrong should move the answer by nothing, whether it
    // happened to contain five elements or five hundred.
    const good = [drill(1, DIT + 0.012, 10), drill(3, DAH + 0.012, 10)];
    const wrecked = drill(1, DIT + 0.4, 500);
    const c = measureCalibration([...good, wrecked], WPM);
    expect(c.releaseOffsetSec).toBeCloseTo(0.012, 9);
  });

  it("records how far the drills disagreed", () => {
    const c = measureCalibration([drill(1, DIT + 0.004), drill(3, DAH + 0.02)], WPM);
    expect(c.spreadSec).toBeCloseTo(0.016, 9);
  });

  it("refuses to correct in the direction a room cannot cause", () => {
    // A room delays a release. It never brings one forward, so a negative
    // measurement is of something else and lengthening every mark by it would
    // be inventing time.
    const c = measureCalibration([drill(1, DIT - 0.01), drill(3, DAH - 0.01)], WPM);
    expect(c.releaseOffsetSec).toBe(0);
  });

  it("produces a harmless profile when there is nothing to measure", () => {
    const c = measureCalibration([], WPM);
    expect(c.releaseOffsetSec).toBe(0);
    expect(c.elements).toBe(0);
    expect(calibrationIsUsable(c)).toBe(false);
  });
});

describe("deciding whether a profile can be trusted", () => {
  const base: Calibration = { wpm: WPM, releaseOffsetSec: 0.012, spreadSec: 0.001, elements: 40 };

  it("accepts drills that agreed closely", () => {
    expect(calibrationIsUsable(base)).toBe(true);
  });

  it("rejects drills that disagreed by a meaningful part of a dit", () => {
    // Two drills that disagree by a third of a dit are not measuring one room.
    expect(calibrationIsUsable({ ...base, spreadSec: DIT / 3 })).toBe(false);
  });

  it("scales what counts as disagreement with the speed it was keyed at", () => {
    // Ten milliseconds is an eighth of a dit at 15 wpm and nearly half of one
    // at 50, so the same number has to be acceptable in one case and not the
    // other.
    const spread = 0.010;
    expect(calibrationIsUsable({ ...base, spreadSec: spread })).toBe(true);
    expect(calibrationIsUsable({ wpm: 50, releaseOffsetSec: 0.012, spreadSec: spread, elements: 40 })).toBe(false);
  });

  it("rejects a profile built from almost nothing", () => {
    expect(calibrationIsUsable({ ...base, elements: 3 })).toBe(false);
  });

  it("rejects a profile with no speed attached", () => {
    expect(calibrationIsUsable({ ...base, wpm: 0 })).toBe(false);
  });
});
