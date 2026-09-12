/* The grading port, held to the Python implementation exactly.
 *
 * This is the half that is a *port*, not a reimplementation: every function in
 * timing/ has a named counterpart in core.py and is supposed to compute the
 * identical number. So the Python segments go in verbatim and the outputs are
 * compared at 1e-9. A disagreement here is a bug, never a modeling difference
 * — which is what makes this the test to read first when something is off.
 *
 * The DSP is the opposite case and gets its own file.
 */

import { describe, expect, it } from "vitest";
import { oracleSegments, type OracleCase, type OracleTiming } from "../oracle";
import { oracleCasesFromDisk } from "../oracle-fs";
import {
  buildTimeline,
  compareText,
  estimateTiming,
  grade,
  idealTimeline,
  pair,
  retarget,
  targetTiming,
} from "@/timing";
import { PAUSE_FACTOR } from "@/timing/timeline";
import type { Timing } from "@/types";

const cases = oracleCasesFromDisk();

/** Tight enough that only floating-point association differs. */
const EXACT = 1e-9;

function expectTiming(got: Timing, want: OracleTiming, label: string) {
  for (const key of [
    "unitSec",
    "charWpm",
    "farnsworthWpm",
    "ditDahSplit",
    "elementCharSplit",
    "charWordSplit",
    "charGapSec",
    "wordGapSec",
  ] as const) {
    expect(got[key], `${label}.${key}`).toBeCloseTo(want[key]!, 9);
  }
}

describe("grading agrees with the Python oracle", () => {
  it("has cases to check", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c: OracleCase) => {
    const segs = oracleSegments(c);
    const g = c.grading;

    it("measures the same timing off the same segments", () => {
      expectTiming(estimateTiming(segs, c.expected), g.measured, "measured");
    });

    it("builds the same target timing", () => {
      expectTiming(targetTiming(c.charWpm, c.farnsworthWpm), g.ref, "ref");
    });

    // Both rest policies, because "collapse rests" is a control the user can
    // move and the boundary it shifts is exactly what a port gets wrong.
    for (const arm of ["rests", "noRests"] as const) {
      describe(arm, () => {
        const want = g[arm];
        const ref = targetTiming(c.charWpm, c.farnsworthWpm);
        const build = () =>
          buildTimeline(segs, ref, arm === "rests" ? PAUSE_FACTOR : Infinity);

        it("decodes the same text", () => {
          expect(build().text).toBe(want.timeline.text);
        });

        // Before and after retarget, separately. The difference between the
        // two is the whole of what retarget does, so checking only the second
        // would let a port that never retargeted pass whenever its duration
        // guess happened to be right.
        const expectBlocks = (
          got: ReturnType<typeof build>["blocks"],
          want_: typeof want.timeline,
          label: string,
        ) => {
          expect(got.length, `${label} block count`).toBe(want_.blocks.length);
          got.forEach((b, i) => {
            const w = want_.blocks[i]!;
            expect(b.kind, `${label} block ${i} kind`).toBe(w.kind);
            expect(b.targetKind, `${label} block ${i} targetKind`).toBe(w.targetKind);
            expect(b.t0, `${label} block ${i} t0`).toBeCloseTo(w.t0, 9);
            expect(b.t1, `${label} block ${i} t1`).toBeCloseTo(w.t1, 9);
            expect(b.units, `${label} block ${i} units`).toBeCloseTo(w.units, 9);
            expect(b.targetUnits, `${label} block ${i} targetUnits`).toBeCloseTo(
              w.targetUnits,
              9,
            );
            expect(b.context, `${label} block ${i} context`).toBe(w.context);
          });
        };

        it("produces the same blocks before the intended text is consulted", () => {
          expectBlocks(build().blocks, want.timeline, "pre-retarget");
        });

        it("produces the same blocks after retargeting", () => {
          const tl = build();
          if (c.expected) retarget(pair(tl, idealTimeline(c.expected, ref)));
          expectBlocks(tl.blocks, want.retargetedTimeline, "post-retarget");
        });

        it("groups the same characters", () => {
          const got = build().chars;
          expect(got.length).toBe(want.timeline.chars.length);
          got.forEach((ch, i) => {
            const w = want.timeline.chars[i]!;
            expect(ch.char, `char ${i}`).toBe(w.char);
            expect(ch.pattern, `char ${i} pattern`).toBe(w.pattern);
            expect(ch.t0, `char ${i} t0`).toBeCloseTo(w.t0, 9);
            expect(ch.t1, `char ${i} t1`).toBeCloseTo(w.t1, 9);
            expect(ch.blocks.length, `char ${i} nBlocks`).toBe(w.nBlocks);
            expect(ch.leadGap?.kind ?? null, `char ${i} leadGap`).toBe(w.leadGapKind);
          });
        });

        it("retargets the same number of gaps from the intended text", () => {
          const tl = build();
          const moved = c.expected
            ? retarget(pair(tl, idealTimeline(c.expected, ref)))
            : 0;
          expect(moved).toBe(want.retargeted);
        });

        it("grades to the same numbers", () => {
          const tl = build();
          if (c.expected) retarget(pair(tl, idealTimeline(c.expected, ref)));
          const measured = estimateTiming(segs, c.expected);
          const a = grade(tl, ref, measured, want.analysis.tolerance);

          expect(a.nPauses).toBe(want.analysis.nPauses);
          expect(a.withinTolFrac).toBeCloseTo(want.analysis.withinTolFrac, 9);

          expect(a.stats.map((s) => s.name)).toEqual(
            want.analysis.stats.map((s) => s.name),
          );
          a.stats.forEach((s, i) => {
            const w = want.analysis.stats[i]!;
            expect(s.n, `${s.name}.n`).toBe(w.n);
            expect(s.meanUnits, `${s.name}.mean`).toBeCloseTo(w.meanUnits, 9);
            expect(s.stdUnits, `${s.name}.std`).toBeCloseTo(w.stdUnits, 9);
            expect(s.targetUnits, `${s.name}.target`).toBeCloseTo(w.targetUnits, 9);
          });

          expect(a.deviations.length).toBe(want.analysis.deviations.length);
          a.deviations.forEach((d, i) => {
            const w = want.analysis.deviations[i]!;
            expect(d.kind, `dev ${i} kind`).toBe(w.kind);
            expect(d.timeSec, `dev ${i} time`).toBeCloseTo(w.timeSec, 9);
            expect(d.valueUnits, `dev ${i} value`).toBeCloseTo(w.valueUnits, 9);
            expect(d.targetUnits, `dev ${i} target`).toBeCloseTo(w.targetUnits, 9);
            expect(d.context, `dev ${i} context`).toBe(w.context);
          });
        });
      });
    }

    it("renders the same ideal timeline for the intended text", () => {
      const ref = targetTiming(c.charWpm, c.farnsworthWpm);
      const got = idealTimeline(c.expected ?? "", ref);
      expect(got.text).toBe(g.ideal.text);
      expect(got.duration).toBeCloseTo(g.ideal.duration, 9);
      expect(got.blocks.length).toBe(g.ideal.blocks.length);
      got.blocks.forEach((b, i) => {
        const w = g.ideal.blocks[i]!;
        expect(b.kind, `ideal block ${i}`).toBe(w.kind);
        expect(b.t0, `ideal block ${i} t0`).toBeCloseTo(w.t0, 9);
        expect(b.units, `ideal block ${i} units`).toBeCloseTo(w.units, 9);
      });
    });

    it("scores the text comparison the same way", () => {
      if (!g.comparison) return;
      const ref = targetTiming(c.charWpm, c.farnsworthWpm);
      const decoded = buildTimeline(segs, ref).text;
      const got = compareText(c.expected, decoded);
      expect(got.decoded).toBe(g.comparison.decoded);
      expect(got.expected).toBe(g.comparison.expected);
      expect(got.nExpected).toBe(g.comparison.nExpected);
      expect(got.substitutions).toBe(g.comparison.substitutions);
      expect(got.insertions).toBe(g.comparison.insertions);
      expect(got.deletions).toBe(g.comparison.deletions);
      expect(Math.abs(got.accuracy - g.comparison.accuracy)).toBeLessThan(EXACT);
      expect(got.diff).toBe(g.comparison.diff);
    });
  });
});
