/* The JSON report: the shape a directory of practice sessions is made of.
 *
 * Checked against what the Python CLI writes, key for key, because the whole
 * point of a stable shape is that reports from either source drop into the same
 * file and compare. And checked for following the controls, because a report
 * that silently described some other grading would be worse than no report.
 */

import { describe, expect, it } from "vitest";
import { buildJsonReport } from "@/io/report";
import { reviewTake } from "@/timing";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

const AT = new Date("2026-03-04T05:06:07.891Z");

describe("the JSON report", () => {
  it("has the same top-level shape the CLI writes", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    const report = buildJsonReport(review, settings, AT);
    expect(Object.keys(report).sort()).toEqual(
      [
        "analysis",
        "comparison",
        "generated",
        "measured",
        "review",
        "sample_rate",
        "source",
        "target",
        "text",
        "tone_hz",
      ].sort(),
    );
    expect(Object.keys(report.analysis).sort()).toEqual(
      ["deviations", "elements", "pauses_ignored", "tolerance", "within_tolerance_frac"].sort(),
    );
  });

  it("stamps a timestamp Python's would sort beside", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    // Python writes `...+00:00` at second resolution. Matching it means the
    // two sources sort and parse identically instead of nearly so.
    expect(buildJsonReport(review, settings, AT).generated).toBe(
      "2026-03-04T05:06:07+00:00",
    );
  });

  it("says what it decoded and when it was recorded", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    const report = buildJsonReport(review, settings, AT);
    expect(report.source).toBe(SLOPPY);
    expect(report.text).toBe(review.actual.text);
    expect(report.review.recorded_at).toBe(review.take.recordedAt);
    expect(report.review.take_id).toBe(review.take.id);
  });

  it("reports the grading now on screen, not the one at record time", () => {
    const take = reviewFrom(caseNamed(SLOPPY)).take;
    const loose = reviewTake(take, { ...reviewFrom(caseNamed(SLOPPY)).settings, tolerance: 0.6 });
    const tight = reviewTake(take, { ...reviewFrom(caseNamed(SLOPPY)).settings, tolerance: 0.05 });

    const a = buildJsonReport(loose, { ...reviewFrom(caseNamed(SLOPPY)).settings, tolerance: 0.6 }, AT);
    const b = buildJsonReport(tight, { ...reviewFrom(caseNamed(SLOPPY)).settings, tolerance: 0.05 }, AT);

    expect(a.analysis.tolerance).toBe(0.6);
    expect(b.analysis.tolerance).toBe(0.05);
    expect(a.analysis.within_tolerance_frac).toBeGreaterThan(
      b.analysis.within_tolerance_frac,
    );
  });

  it("records the settings that shaped the numbers", () => {
    // Without these a re-graded dump cannot be interpreted later: two reports
    // of the same recording can differ entirely and both be correct.
    const { review, settings } = reviewFrom(caseNamed(SLOPPY), { collapseRests: false });
    const report = buildJsonReport(review, settings, AT);
    expect(report.review.collapse_rests).toBe(false);
    expect(report.review.from).toBe("cw-trainer");
    expect(report.target.char_wpm).toBe(settings.charWpm);
  });

  it("keeps the measured speed out of the controls' reach", () => {
    // The target moves with the slider; what you actually sent does not.
    const { take, settings } = reviewFrom(caseNamed(SLOPPY));
    const slow = reviewTake(take, { ...settings, charWpm: 12, farnsworthWpm: 12 });
    const fast = reviewTake(take, { ...settings, charWpm: 40, farnsworthWpm: 40 });
    const a = buildJsonReport(slow, { ...settings, charWpm: 12, farnsworthWpm: 12 }, AT);
    const b = buildJsonReport(fast, { ...settings, charWpm: 40, farnsworthWpm: 40 }, AT);

    expect(a.measured).toEqual(b.measured);
    expect(a.target.char_wpm).toBe(12);
    expect(b.target.char_wpm).toBe(40);
  });

  it("scores against a message typed into the review", () => {
    const { take, settings } = reviewFrom(caseNamed(SLOPPY));
    const edited = { ...settings, expected: "SOS" };
    const report = buildJsonReport(reviewTake(take, edited), edited, AT);
    expect(report.review.expected).toBe("SOS");
    expect(report.comparison?.expected_source).toBe("(edited in the review)");
  });

  it("reports no comparison at all when nothing was intended", () => {
    // With no target the intended box defaults to your own decode, and scoring
    // that would be a meaningless 100% — so it reports nothing instead.
    const take = { ...reviewFrom(caseNamed(SLOPPY)).take, expected: null, expectedSource: null };
    const settings = { ...reviewFrom(caseNamed(SLOPPY)).settings, expected: take.decoded };
    const report = buildJsonReport(reviewTake(take, settings), settings, AT);
    expect(report.comparison).toBeNull();
    expect(report.review.expected).toBeNull();
  });

  it("rounds every number to a fixed precision, so a diff is readable", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    const report = buildJsonReport(review, settings, AT);
    const decimals = (v: number) => (String(v).split(".")[1] ?? "").length;
    for (const el of report.analysis.elements) {
      expect(decimals(el.mean_units)).toBeLessThanOrEqual(3);
      expect(decimals(el.std_units)).toBeLessThanOrEqual(3);
    }
    for (const d of report.analysis.deviations) {
      expect(decimals(d.time_sec)).toBeLessThanOrEqual(2);
      expect(decimals(d.value_units)).toBeLessThanOrEqual(2);
    }
    expect(decimals(report.measured.char_wpm)).toBeLessThanOrEqual(2);
  });

  it("survives a JSON round trip unchanged", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    const report = buildJsonReport(review, settings, AT);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("flags each class as ok or not on the same rule the chart uses", () => {
    const { review, settings } = reviewFrom(caseNamed(SLOPPY));
    const report = buildJsonReport(review, settings, AT);
    report.analysis.elements.forEach((el, i) => {
      const stat = review.analysis.stats[i]!;
      const within =
        Math.abs(stat.meanUnits - stat.targetUnits) <= settings.tolerance * stat.targetUnits;
      expect(el.ok).toBe(within);
    });
  });
});
