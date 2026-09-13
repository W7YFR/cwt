/* The schedule a paced recording runs on.
 *
 * One target timeline read three ways — where the count-in aims, when each
 * character is due, and when the whole thing is over — and the reason they
 * live together is that three slightly different ideas of "now" is exactly the
 * failure this would have. The cursor, the flash card and the auto-stop all
 * read these, so a disagreement between them would show up as the cue firing
 * on one beat while the cursor arrived on another.
 */

import { describe, expect, it } from "vitest";
import { beatsFor, pacedEnd, pacedStart } from "@/ui/pacing";
import { buildTimeline, targetTiming } from "@/timing";
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

  it("puts the first character exactly where the count-in ends", () => {
    /* The whole contract between the two: the cursor arrives, the card
       flashes, and the operator keys, all at the same instant. */
    expect(beatsFor(IDEAL, LEAD)[0]!.at).toBeCloseTo(LEAD, 9);
  });

  it("keeps every later character at its own distance into the message", () => {
    const beats = beatsFor(IDEAL, LEAD);
    const from = pacedStart(IDEAL);
    expect(beats).toHaveLength(IDEAL.chars.length);
    beats.forEach((b, i) => {
      const c = IDEAL.chars[i]!;
      expect(b.char).toBe(c.char);
      expect(b.at).toBeCloseTo(LEAD + (c.t0 - from), 9);
    });
    // Strictly increasing, or the card would show characters out of order.
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]!.at).toBeGreaterThan(beats[i - 1]!.at);
    }
  });

  it("moves the whole schedule with the count-in, and nothing else", () => {
    const a = beatsFor(IDEAL, 1);
    const b = beatsFor(IDEAL, 4);
    a.forEach((beat, i) => expect(b[i]!.at - beat.at).toBeCloseTo(3, 9));
  });

  it("ends after the last element, not after the last character's start", () => {
    /* A take cut off halfway through its final dah would be missing the one
       thing it was recorded to measure. */
    const last = IDEAL.chars[IDEAL.chars.length - 1]!;
    const end = pacedEnd(IDEAL, LEAD, 1)!;
    const beats = beatsFor(IDEAL, LEAD);

    expect(end).toBeCloseTo(LEAD + (last.t1 - pacedStart(IDEAL)) + 1, 9);
    // Comfortably past the moment the last character was due to begin.
    expect(end).toBeGreaterThan(beats[beats.length - 1]!.at + 1);
  });

  it("has no schedule at all for a message with nothing in it", () => {
    // Nothing to pace, nothing to stop — the aids simply do not arm.
    const empty = buildTimeline([], TIMING);
    expect(pacedStart(empty)).toBe(0);
    expect(beatsFor(empty, LEAD)).toEqual([]);
    expect(pacedEnd(empty, LEAD, 1)).toBeNull();
  });
});
