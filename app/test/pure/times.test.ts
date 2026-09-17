/* Sending the message more than once in a take.
 *
 * The setting is one number, but what it has to reach is everything downstream
 * of the target: the ideal timeline the chart draws and the player synthesizes
 * from, the schedule the pacing runs on, and the text the decode is compared
 * against. It reaches them by being applied at the one place the target text
 * is decided, so what these check is that the single instance stays single
 * where it is READ and multiplies where it is BUILT.
 */

import { describe, expect, it } from "vitest";
import { reviewTake, targetText } from "@/timing";
import { buildJsonReport } from "@/io/report";
import { caseNamed, reviewFrom, takeFrom, SLOPPY } from "../fixture";

describe("targetText", () => {
  it("joins the passes with the gap that separates words", () => {
    // The same silence that is inside the message, because that is what a
    // repeat sounds like. Anything longer is a rest and is not graded.
    expect(targetText("CQ DE W7YFR", 3)).toBe("CQ DE W7YFR CQ DE W7YFR CQ DE W7YFR");
  });

  it("leaves one alone", () => {
    expect(targetText("CQ DE W7YFR", 1)).toBe("CQ DE W7YFR");
  });

  it("has nothing to repeat with nothing supplied", () => {
    /* With the box empty the target falls back to your own decode, and
       repeating that would claim you meant to send, five times, whatever came
       out once. */
    expect(targetText("", 5)).toBe("");
    expect(targetText("   ", 5)).toBe("");
  });

  it("refuses to make a target shorter than the message", () => {
    for (const n of [0, -3, 0.4, Number.NaN]) {
      expect(targetText("CQ", n), `times ${n}`).toBe("CQ");
    }
  });
});

describe("a take sent more than once", () => {
  const take = takeFrom(caseNamed(SLOPPY));
  const at = (times: number) => reviewFrom(caseNamed(SLOPPY), { expected: "CQ DE W7YFR", times });

  it("builds a target that long, and grades against it", () => {
    const one = at(1).review;
    const three = at(3).review;

    expect(three.ideal.chars.length).toBe(one.ideal.chars.length * 3);
    // The extra time is three passes plus the two word gaps between them.
    const wordGap = one.ref.wordGapSec;
    expect(three.ideal.duration).toBeCloseTo(one.ideal.duration * 3 + wordGap * 2, 6);

    /* And what the decode is measured against grew with it — by the whole
       repeated text, joining gaps included, rather than by three times the
       message. */
    expect(one.comparison!.nExpected).toBe(targetText("CQ DE W7YFR", 1).length);
    expect(three.comparison!.nExpected).toBe(targetText("CQ DE W7YFR", 3).length);
  });

  it("leaves the message itself a single instance", () => {
    /* The box holds what you are practicing. Typing a callsign out five times
       to drill five of them is copying, not practice — and every later read of
       the setting depends on the two being distinguishable. */
    const { settings } = at(4);
    expect(settings.expected).toBe("CQ DE W7YFR");
  });

  it("says how many passes a grade was over", () => {
    /* `expected` in the report is one instance, so without this a directory of
       reports cannot tell an accuracy figure over one pass from one over
       five. */
    const { review, settings } = at(5);
    const report = buildJsonReport(review, settings);
    expect(report.review.times).toBe(5);
    expect(report.review.expected).toBe("CQ DE W7YFR");
  });

  it("changes nothing at all when it is one", () => {
    // The default has to be inert, or every reading in the app moves the day
    // this shipped.
    const settings = { ...at(1).settings };
    const before = reviewTake(take, settings);
    const after = reviewTake(take, { ...settings, times: 1 });
    expect(after.ideal.duration).toBe(before.ideal.duration);
    expect(after.analysis.withinTolFrac).toBe(before.analysis.withinTolFrac);
  });
});
