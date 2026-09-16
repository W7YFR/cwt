/* Where the rows go once there can be more than one attempt on screen.
 *
 * The fixed constants were right, and the generalization has to reproduce them
 * exactly for a chart with one run on it — otherwise stacking would quietly
 * move a chart that has nothing stacked on it, and every recorded-draw test
 * would be arguing about pixels rather than about drawing.
 */

import { describe, expect, it } from "vitest";
import {
  GRADE_H,
  HEIGHT,
  LABEL_H,
  LANE_GAP,
  PLOT_BOTTOM,
  ROW_H,
  Y_DRIFT,
  Y_GRADE,
  Y_SCROLL,
  Y_TGT,
  Y_TGT_LABEL,
  Y_YOU,
  Y_YOU_LABEL,
  rowsFor,
} from "@/render/geometry";

describe("the row geometry", () => {
  it("puts one captioned run exactly where the fixed layout put it", () => {
    const rows = rowsFor(1, 0);
    expect(rows.tgtLabel).toBe(Y_TGT_LABEL);
    expect(rows.tgt).toBe(Y_TGT);
    expect(rows.runs[0]).toMatchObject({
      grade: Y_GRADE,
      row: Y_YOU,
      label: Y_YOU_LABEL,
    });
    expect(rows.drift).toBe(Y_DRIFT);
    expect(rows.scroll).toBe(Y_SCROLL);
    expect(rows.height).toBe(HEIGHT);
    expect(rows.plotBottom).toBe(PLOT_BOTTOM);
  });

  it("stacks each further attempt under the one before it", () => {
    const rows = rowsFor(3, 0);
    expect(rows.runs).toHaveLength(3);
    for (let r = 1; r < rows.runs.length; r++) {
      // Under it with air in between, which belongs to neither band.
      expect(rows.runs[r]!.grade).toBe(rows.runs[r - 1]!.bottom + LANE_GAP);
      expect(rows.runs[r]!.row).toBe(rows.runs[r]!.grade + GRADE_H);
    }
  });

  it("writes a caption on the run being read and on no other", () => {
    const rows = rowsFor(4, 2);
    expect(rows.runs.map((r) => r.label !== null)).toEqual([false, false, true, false]);
  });

  it("keeps every lane the same height, captioned or not", () => {
    /* Selecting a row changes what is highlighted, not where anything is.
       Reserved only where a caption was written, every row under the selection
       moved by the height of one each time it changed — so the marks you were
       comparing jumped out from under the pointer about to click the next
       row. */
    // The lane's own band, which the gap above it is deliberately not part of:
    // the break in the page is what says where one row ends.
    const lane = GRADE_H + ROW_H + LABEL_H;
    for (const at of [0, 1, 2, 3]) {
      const rows = rowsFor(4, at);
      for (const [r, run] of rows.runs.entries()) {
        expect(run.bottom - run.grade, `run ${r + 1} with ${at + 1} selected`).toBe(lane);
      }
    }
  });

  it("lays the whole chart out the same way whichever run is selected", () => {
    const shape = (at: number) => {
      const rows = rowsFor(4, at);
      return {
        rows: rows.runs.map((r) => [r.grade, r.row, r.bottom]),
        drift: rows.drift,
        height: rows.height,
      };
    };
    expect(shape(1)).toEqual(shape(0));
    expect(shape(3)).toEqual(shape(0));
  });

  it("grows the chart by a lane for every attempt, and nothing else", () => {
    const one = rowsFor(1, 0);
    const two = rowsFor(2, 0);
    expect(two.height - one.height).toBe(LANE_GAP + GRADE_H + ROW_H + LABEL_H);
    // The drift plot and the scrollbar keep their order under the lanes.
    expect(two.drift).toBeGreaterThan(two.runs[1]!.bottom);
    expect(two.scroll).toBeGreaterThan(two.plotBottom - 1);
  });

  it("still lays out a lane when there is nothing recorded at all", () => {
    /* A blank session draws the target and a row of ghosts under it, so zero
       runs and one run are the same picture. */
    expect(rowsFor(0, 0).runs).toHaveLength(1);
    expect(rowsFor(0, -1).height).toBe(rowsFor(1, -1).height);
  });
});
