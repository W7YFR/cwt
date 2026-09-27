/* Long breaks inside a message, and pauses between its passes.
 *
 * A BREAK splits a message into turns, such as both sides of a QSO. A REPEAT
 * joins two passes when the repeat pause is above zero. The ideal timeline
 * holds a pause at each, and the sender's own silence there is a rest whatever
 * its length and whatever the collapse-rests setting says.
 */

import { describe, expect, it } from "vitest";
import { BREAK, REPEAT, tokenize } from "@/morse";
import { defaultSettings, reviewTake, targetText } from "@/timing";
import { targetTiming } from "@/timing/model";
import { BREAK_DEFAULT_SEC, idealTimeline } from "@/timing/timeline";
import { compareText } from "@/timing/align";
import { MIC_SOURCE, type Segment, type Take, type Timeline } from "@/types";
import { caseNamed, takeFrom, SLOPPY } from "../fixture";

const REF = targetTiming(20, 20);
const gaps = (tl: Timeline) =>
  tl.blocks.filter((b) => b.kind === "word-gap" || b.kind === "pause").map((b) => b.kind);

describe("the ideal timeline", () => {
  it("holds a pause at a break, and a word gap elsewhere", () => {
    const tl = idealTimeline("CQ K | DE K", REF);
    expect(gaps(tl)).toEqual(["word-gap", "pause", "word-gap"]);
    const pause = tl.blocks.find((b) => b.kind === "pause")!;
    expect(pause.t1 - pause.t0).toBeCloseTo(BREAK_DEFAULT_SEC);
    expect(pause.targetKind).toBe("pause");
    expect(tl.chars.map((c) => c.char).join("")).toBe("CQKDEK");
  });

  it("holds the pause for the length it is given", () => {
    const pause = idealTimeline("K | K", REF, { breakSec: 7.5 }).blocks.find((b) => b.kind === "pause")!;
    expect(pause.t1 - pause.t0).toBeCloseTo(7.5);
  });

  it("holds the repeat pause at a repeat, and a word gap when it is zero", () => {
    const text = `K ${REPEAT} K`;
    const pause = idealTimeline(text, REF, { repeatSec: 4 }).blocks.find((b) => b.kind === "pause")!;
    expect(pause.t1 - pause.t0).toBeCloseTo(4);
    expect(gaps(idealTimeline(text, REF, { repeatSec: 0 }))).toEqual(["word-gap"]);
  });

  it("takes the longer pause where a break meets a repeat", () => {
    const tl = idealTimeline(`K | ${REPEAT} K`, REF, { breakSec: 3, repeatSec: 6 });
    const pause = tl.blocks.find((b) => b.kind === "pause")!;
    expect(pause.t1 - pause.t0).toBeCloseTo(6);
  });

  it("reads a break with no spaces round it", () => {
    expect(gaps(idealTimeline("K|K", REF))).toEqual(["pause"]);
  });

  it("drops breaks at either end and merges breaks in a row", () => {
    expect(gaps(idealTimeline(" | K | | K |", REF))).toEqual(["pause"]);
  });
});

describe("comparing text", () => {
  it("reads a break or a repeat as a word space", () => {
    expect(tokenize(`CQ ${BREAK} K`)).toEqual(tokenize("CQ K"));
    expect(tokenize(`CQ ${REPEAT} K`)).toEqual(tokenize("CQ K"));
    expect(compareText("CQ | K", "CQ K").accuracy).toBe(1);
  });
});

describe("targetText", () => {
  it("joins the passes with a repeat when there is a repeat pause", () => {
    expect(targetText("CQ | K", 2, 5)).toBe(`CQ | K ${REPEAT} CQ | K`);
  });

  it("joins the passes with a space when the repeat pause is zero", () => {
    expect(targetText("CQ | K", 2, 0)).toBe("CQ | K CQ | K");
  });
});

describe("a take with a break in it", () => {
  /** Segments keyed exactly on the ideal timeline, with each pause held for
   *  `restSec` in place of BREAK_SEC. */
  function keyed(text: string, restSec: number): Segment[] {
    const segs: Segment[] = [[0, 0.5]];
    for (const b of idealTimeline(text, REF).blocks) {
      const mark = b.kind === "dit" || b.kind === "dah";
      segs.push([mark ? 1 : 0, b.kind === "pause" ? restSec : b.t1 - b.t0]);
    }
    segs.push([0, 0.5]);
    return segs;
  }

  const text = "CQ CQ DE K7ABC K | K7ABC DE W7YFR K";
  const base = takeFrom(caseNamed(SLOPPY));
  const take = (restSec: number): Take => ({
    ...base,
    source: MIC_SOURCE,
    segments: keyed(text, restSec),
    measured: { ...base.measured, unitSec: REF.unitSec },
    target: { charWpm: 20, farnsworthWpm: 20, explicit: true },
  });

  for (const collapseRests of [true, false]) {
    for (const restSec of [1, 8]) {
      it(`grades no spacing error at the break (rest ${restSec}s, collapse ${collapseRests})`, () => {
        const t = take(restSec);
        const settings = { ...defaultSettings(t), expected: text, charWpm: 20, farnsworthWpm: 20, times: 1, collapseRests };
        const review = reviewTake(t, settings);
        expect(review.comparison?.accuracy).toBe(1);
        const atBreak = review.actual.chars.find((c) => c.leadGap && c.leadGap.units * REF.unitSec > 0.9);
        expect(atBreak?.leadGap?.targetKind).toBe("pause");
        expect(review.analysis.deviations.filter((d) => d.kind === "word-gap")).toEqual([]);
      });
    }
  }
});

describe("a take sent twice", () => {
  /* One pass, a gap of `gapSec`, then the other. The gap is past the target's
     word gap, and short enough that it is not a rest on its own. */
  const one = "CQ DE K7ABC";
  const gapSec = 0.7;
  const segments = (): Segment[] => {
    const segs: Segment[] = [[0, 0.5]];
    for (const b of idealTimeline(`${one} ${REPEAT} ${one}`, REF, { repeatSec: 1 }).blocks) {
      const mark = b.kind === "dit" || b.kind === "dah";
      segs.push([mark ? 1 : 0, b.kind === "pause" ? gapSec : b.t1 - b.t0]);
    }
    segs.push([0, 0.5]);
    return segs;
  };
  const base = takeFrom(caseNamed(SLOPPY));
  const t: Take = {
    ...base,
    source: MIC_SOURCE,
    segments: segments(),
    measured: { ...base.measured, unitSec: REF.unitSec },
    target: { charWpm: 20, farnsworthWpm: 20, explicit: true },
  };
  const review = (repeatPauseSec: number) =>
    reviewTake(t, {
      ...defaultSettings(t),
      expected: one,
      charWpm: 20,
      farnsworthWpm: 20,
      times: 2,
      collapseRests: true,
      repeatPauseSec,
    });
  const wordGapErrors = (repeatPauseSec: number) =>
    review(repeatPauseSec).analysis.deviations.filter((d) => d.kind === "word-gap");

  it("does not grade the gap between passes with a repeat pause", () => {
    expect(review(5).comparison?.accuracy).toBe(1);
    expect(wordGapErrors(5)).toEqual([]);
  });

  it("grades the gap between passes as a word gap with no repeat pause", () => {
    expect(review(0).comparison?.accuracy).toBe(1);
    expect(wordGapErrors(0)).toHaveLength(1);
  });
});
