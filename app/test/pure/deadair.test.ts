/* Dead air at the ends of a recording is not spacing.
 *
 * A capture starts when you click and stops when you click, and even after
 * trimming there is half a second of pad left at each end deliberately. Those
 * two silences have a mark on one side only, so they measure nothing about how
 * the sender spaced their sending — and read as character gaps they are enough
 * to invent Farnsworth spacing that nobody sent.
 *
 * It hides in ordinary text, where dozens of real gaps outvote the two pads.
 * It is unmissable in a one-character drill, which is a normal thing to do: a
 * single <BK>, a call sign practiced on its own. There the pads are the only
 * silences of their size in the file, so they become the entire evidence.
 */

import { describe, expect, it } from "vitest";
import { estimateTiming } from "@/timing";
import { CHAR_TO_MORSE } from "@/morse";
import { TRIM_PAD } from "@/dsp";
import type { Segment } from "@/types";

/** One character, keyed perfectly at `wpm`, with `pad` seconds of dead air
 *  either side — exactly what analyzeClip hands the estimator. */
function oneChar(text: string, wpm: number, pad = TRIM_PAD): Segment[] {
  const unit = 1.2 / wpm;
  const pattern = CHAR_TO_MORSE[text]!;
  const segs: Segment[] = [[0, pad]];
  pattern.split("").forEach((sym, i) => {
    if (i > 0) segs.push([0, unit]);
    segs.push([1, unit * (sym === "-" ? 3 : 1)]);
  });
  segs.push([0, pad]);
  return segs;
}

describe("a single character", () => {
  it("is sent at one speed, which is both of them", () => {
    /* With no gap between characters there is no spacing to stretch, so the
       overall rate IS the character rate. Anything else is a statement about
       the silence before and after the transmission. */
    const t = estimateTiming(oneChar("<BK>", 25));
    expect(t.charWpm).toBeCloseTo(25, 1);
    expect(t.farnsworthWpm).toBeCloseTo(t.charWpm, 6);
  });

  it("stays that way however long you waited before keying", () => {
    /* The pad is fixed, but the trim only runs on a mic take, and a file
       opened from disk carries whatever dead air it was saved with. */
    for (const pad of [0.1, TRIM_PAD, 3]) {
      const t = estimateTiming(oneChar("K", 20, pad));
      expect(t.farnsworthWpm, `${pad}s of dead air`).toBeCloseTo(t.charWpm, 6);
    }
  });

  it("reports no Farnsworth note, having detected none", () => {
    expect(estimateTiming(oneChar("<BK>", 25)).notes).toEqual([]);
  });
});

describe("real spacing, still measured", () => {
  /* The fix must not go the other way and stop seeing spacing that is there.
     Two characters a Farnsworth-sized gap apart, same pads. */
  const spaced = (wpm: number, gapUnits: number): Segment[] => {
    const unit = 1.2 / wpm;
    const segs: Segment[] = [[0, TRIM_PAD]];
    // K = -.-, twice, with a stretched character gap between them.
    for (const first of [true, false]) {
      if (!first) segs.push([0, unit * gapUnits]);
      segs.push([1, unit * 3], [0, unit], [1, unit], [0, unit], [1, unit * 3]);
    }
    segs.push([0, TRIM_PAD]);
    return segs;
  };

  it("reads a stretched character gap as Farnsworth", () => {
    const t = estimateTiming(spaced(20, 9));
    expect(t.charWpm).toBeCloseTo(20, 1);
    expect(t.farnsworthWpm).toBeLessThan(t.charWpm * 0.8);
    expect(t.notes.join(" ")).toMatch(/farnsworth/i);
  });

  it("reads a standard character gap as standard", () => {
    const t = estimateTiming(spaced(20, 3));
    expect(t.farnsworthWpm).toBeCloseTo(t.charWpm, 6);
  });
});
