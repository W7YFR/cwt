/* Grading the spacing alone.
 *
 * An automatic keyer forms each character, so a character's elements and the
 * gaps inside it are the keyer's timing, not the sender's. With construction
 * ignored, only the gaps between characters and between words count: in the
 * score, in the tables, and in the chart's marks.
 */

import { describe, expect, it } from "vitest";
import { longElements } from "../fixture";
import { SPACING_KINDS, reviewTake } from "@/timing";
import { buildJsonReport } from "@/io/report";

const { take, settings } = longElements();
const all = reviewTake(take, settings);
const spacing = reviewTake(take, { ...settings, ignoreConstruction: true });
const SPACING: readonly string[] = SPACING_KINDS;

describe("the score with character construction ignored", () => {
  it("grades the spacing between characters and words only", () => {
    const blocks = spacing.actual.blocks.filter(
      (b) => b.targetUnits > 0 && SPACING.includes(b.targetKind),
    );
    const within = blocks.filter(
      (b) => Math.abs(b.units - b.targetUnits) / b.targetUnits <= settings.tolerance,
    ).length;
    expect(spacing.analysis.withinTolFrac).toBeCloseTo(within / blocks.length, 12);
  });

  it("differs from the full grade on a recording with sloppy elements", () => {
    // Otherwise the checks above could pass on a setting that does nothing.
    expect(spacing.analysis.withinTolFrac).not.toBeCloseTo(all.analysis.withinTolFrac, 3);
  });

  it("leaves the elements out of the class table", () => {
    expect(spacing.analysis.stats.map((s) => s.name).every((n) => SPACING.includes(n))).toBe(true);
    expect(all.analysis.stats.some((s) => s.name === "dit")).toBe(true);
  });

  it("leaves the elements out of the deviations", () => {
    expect(spacing.analysis.deviations.every((d) => SPACING.includes(d.kind))).toBe(true);
    expect(all.analysis.deviations.some((d) => !SPACING.includes(d.kind))).toBe(true);
  });

  it("says so in the JSON report", () => {
    const on = buildJsonReport(spacing, { ...settings, ignoreConstruction: true });
    expect(on.review.ignore_character_construction).toBe(true);
    expect(buildJsonReport(all, settings).review.ignore_character_construction).toBe(false);
  });
});
