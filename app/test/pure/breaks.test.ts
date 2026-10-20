/* Long breaks inside a message, and between its passes.
 *
 * A BREAK splits a message into turns, such as both sides of a QSO, and joins
 * two passes. The ideal timeline holds a pause at each, and the sender's own
 * silence there is a rest whatever its length and whatever the collapse-rests
 * setting says.
 */

import { describe, expect, it } from "vitest";
import { BREAK, tokenize } from "@/morse";
import { defaultSettings, reviewTake, targetText } from "@/timing";
import { targetTiming } from "@/timing/model";
import { BREAK_DEFAULT_SEC, idealTimeline } from "@/timing/timeline";
import { compareText } from "@/timing/align";
import { MIC_SOURCE, type Segment, type Take, type Timeline } from "@/types";
import { caseNamed, takeFrom, SLOPPY } from "../fixture";
import { blankTake } from "@/io/take";
import { buildLayout, timeToX } from "@/render/layout";
import { REST_W } from "@/render/geometry";

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

  it("reads a break with no spaces round it", () => {
    expect(gaps(idealTimeline("K|K", REF))).toEqual(["pause"]);
  });

  it("drops breaks at either end and merges breaks in a row", () => {
    expect(gaps(idealTimeline(" | K | | K |", REF))).toEqual(["pause"]);
  });
});

describe("comparing text", () => {
  it("reads a break as a word space", () => {
    expect(tokenize(`CQ ${BREAK} K`)).toEqual(tokenize("CQ K"));
    expect(compareText("CQ | K", "CQ K").accuracy).toBe(1);
  });
});

describe("targetText", () => {
  it("joins the passes with a break", () => {
    expect(targetText("CQ | K", 2)).toBe(`CQ | K ${BREAK} CQ | K`);
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
    for (const b of idealTimeline(`${one} ${BREAK} ${one}`, REF, { breakSec: 1 }).blocks) {
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
  const review = reviewTake(t, {
    ...defaultSettings(t),
    expected: one,
    charWpm: 20,
    farnsworthWpm: 20,
    times: 2,
    collapseRests: true,
  });

  it("does not grade the gap between passes", () => {
    expect(review.comparison?.accuracy).toBe(1);
    expect(review.analysis.deviations.filter((d) => d.kind === "word-gap")).toEqual([]);
  });
});

describe("a rest on the chart before anything is sent", () => {
  /* While a take is paced, the target is all there is. Its rest has to fold
     the axis the way a sent rest does, or the cursor leaps across the
     unfolded stretch in one frame. */
  const take = blankTake({ expected: "K | K", expectedSource: "the test", charWpm: 20, farnsworthWpm: 20 });
  const review = reviewTake(take, { ...defaultSettings(take), expected: "K | K" });
  const layout = buildLayout(review, { view: "absolute", ppu: 12, durationSec: 0 });
  const rest = review.ideal.blocks.find((b) => b.kind === "pause")!;

  it("folds the target's rest to its drawn width", () => {
    const x0 = timeToX(layout, rest.t0, "tgt");
    const x1 = timeToX(layout, rest.t1, "tgt");
    expect(x1 - x0).toBeCloseTo(REST_W, 6);
  });

  it("leaves no jump on the target's axis", () => {
    // Over any stretch of the map, the cursor moves no faster than the
    // ordinary scale: ppu pixels a unit.
    const pxPerSec = 12 / review.ref.unitSec;
    const map = layout.maps.tgt;
    for (let i = 1; i < map.length; i++) {
      const dt = map[i]![0] - map[i - 1]![0];
      const dx = map[i]![1] - map[i - 1]![1];
      expect(dx, `between ${map[i - 1]![0].toFixed(3)} s and ${map[i]![0].toFixed(3)} s`).toBeLessThanOrEqual(dt * pxPerSec + 1e-6);
    }
  });
});
