/* The schedule a paced recording runs on.
 *
 * One target timeline read two ways — where the count-in aims, and when the
 * whole thing is over. The cursor and the auto-stop both read these, so a
 * disagreement between them would show up as the take stopping before the
 * cursor reached the end.
 */

import { describe, expect, it } from "vitest";
import { RECORD_OVERRUN_SEC, pacedEnd, pacedStart, recordLimit } from "@/ui/pacing";
import { buildTimeline, defaultSettings, reviewTake, targetTiming } from "@/timing";
import { blankTake } from "@/io/take";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

const TIMING = targetTiming(15, 15);
/** A real target timeline, built the way the review builds one. */
const IDEAL = reviewFrom(caseNamed(SLOPPY)).review.ideal;
const LEAD = 3;

describe("the paced schedule", () => {
  it("aims the count-in at the first character", () => {
    const first = IDEAL.chars[0]!;
    expect(pacedStart(IDEAL)).toBe(first.leadGap ? first.leadGap.t0 : first.t0);
  });

  it("ends after the last element, not after the last character's start", () => {
    /* A take cut off halfway through its final dah would be missing the one
       thing it was recorded to measure. */
    const last = IDEAL.chars[IDEAL.chars.length - 1]!;
    const end = pacedEnd(IDEAL, LEAD, 1)!;
    const from = pacedStart(IDEAL);

    expect(end).toBeCloseTo(LEAD + (last.t1 - from) + 1, 9);
    // Comfortably past the moment the last character was due to begin.
    expect(end).toBeGreaterThan(LEAD + (last.t0 - from) + 1);
  });

  it("has no schedule at all for a message with nothing in it", () => {
    // Nothing to pace, nothing to stop — the aids simply do not arm.
    const empty = buildTimeline([], TIMING);
    expect(pacedStart(empty)).toBe(0);
    expect(pacedEnd(empty, LEAD, 1)).toBeNull();
  });
});

describe("the recording limit", () => {
  const base = defaultSettings(blankTake({ expected: null, charWpm: 20, farnsworthWpm: 20 }));
  const settings = { ...base, expected: "CQ CQ DE W7YFR K", times: 2 };

  it("runs past the end of the target by the overrun", () => {
    const take = blankTake({ expected: settings.expected, charWpm: 20, farnsworthWpm: 20 });
    const { ideal } = reviewTake(take, settings);
    const end = pacedEnd(ideal, settings.paceLeadSec, 0)!;
    expect(recordLimit(settings)).toBeCloseTo(end + RECORD_OVERRUN_SEC, 9);
  });

  it("grows with each pass of the message", () => {
    const once = recordLimit({ ...settings, times: 1 })!;
    expect(recordLimit(settings)!).toBeGreaterThan(once);
  });

  it("has no limit without a message", () => {
    expect(recordLimit({ ...settings, expected: "" })).toBeNull();
  });
});
