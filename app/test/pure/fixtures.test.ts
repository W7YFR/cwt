/* The fixture corpus itself.
 *
 * Small, but it guards a failure mode that is invisible otherwise: a new oracle
 * case dumped to disk, but never wired into the
 * static list — so the pure and DOM tiers quietly go on testing a subset while
 * the agreement test covers them all.
 */

import { describe, expect, it } from "vitest";
import { ORACLE_CASES } from "../oracle-data";
import { oracleCasesFromDisk, oracleIndexNames } from "../oracle-fs";
import { CLEAN, FARNSWORTH, SLOPPY, caseNamed, reviewFrom } from "../fixture";

describe("the fixture corpus", () => {
  it("exposes every case the oracle dumped", () => {
    const onDisk = oracleIndexNames().sort();
    const wired = ORACLE_CASES.map((c) =>
      c.sourceWav ? c.sourceWav.replace(/\.wav$/, "") : c.name,
    ).sort();
    expect(wired).toEqual(onDisk);
  });

  it("carries the same content through both loaders", () => {
    const fromDisk = oracleCasesFromDisk();
    expect(ORACLE_CASES.length).toBe(fromDisk.length);
    for (const c of ORACLE_CASES) {
      const twin = fromDisk.find((d) => d.name === c.name);
      expect(twin, `${c.name} missing from the disk loader`).toBeDefined();
      expect(c.segments.length).toBe(twin!.segments.length);
      expect(c.toneHz).toBe(twin!.toneHz);
    }
  });

  it("covers the timing cases the app has to get right", () => {
    // Named constants rather than indices, so a reordered corpus cannot
    // silently swap which recording a test is talking about.
    expect(caseNamed(SLOPPY).name).toBe(SLOPPY);
    expect(caseNamed(CLEAN).name).toBe(CLEAN);
    expect(caseNamed(FARNSWORTH).name).toBe(FARNSWORTH);

    // The sloppy one has to have something wrong with it, or half the report
    // and focus tests would be asserting against an empty table.
    expect(reviewFrom(caseNamed(SLOPPY)).review.analysis.deviations.length).toBeGreaterThan(0);
    // And the Farnsworth one has to actually be Farnsworth.
    const f = caseNamed(FARNSWORTH);
    expect(f.farnsworthWpm!).toBeLessThan(f.charWpm * 0.8);
  });

  it("builds a usable review from every case", () => {
    for (const c of ORACLE_CASES) {
      const { review } = reviewFrom(c);
      expect(review.actual.blocks.length, `${c.name} has no blocks`).toBeGreaterThan(0);
      expect(review.ideal.chars.length, `${c.name} has no ideal`).toBeGreaterThan(0);
      expect(review.slots.length, `${c.name} paired nothing`).toBeGreaterThan(0);
    }
  });
});
