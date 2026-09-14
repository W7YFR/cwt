/* The grading as numbers: one JSON shape, so a directory of them is a trend.
 *
 * It reports what is on screen *now*, not what was measured when the recording
 * was made: move the speed, the tolerance or the intended message and this
 * follows. That is the value of exporting from the review rather than from the
 * raw take — and it is why the `review` block records the settings that shaped
 * the numbers, without which a re-graded dump cannot be interpreted later.
 *
 * A stable, documented shape, key for key, so
 * reports from either source drop into the same file and compare.
 */

import { diffText } from "@/timing";
import type { Review, ReviewSettings } from "@/types";

/** To `n` decimals. Rounded on the way out so a report is stable to read and
 *  to diff, rather than carrying float noise nobody asked for. */
function round(v: number, n: number): number {
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

export interface JsonReport {
  source: string;
  generated: string;
  text: string;
  tone_hz: number;
  sample_rate: number;
  measured: { char_wpm: number; farnsworth_wpm: number; unit_ms: number };
  target: { char_wpm: number; farnsworth_wpm: number; unit_ms: number };
  analysis: {
    tolerance: number;
    within_tolerance_frac: number;
    pauses_ignored: number;
    elements: Array<{
      name: string;
      n: number;
      mean_units: number;
      std_units: number;
      target_units: number;
      ok: boolean;
    }>;
    deviations: Array<{
      time_sec: number;
      kind: string;
      value_units: number;
      target_units: number;
      context: string;
    }>;
  };
  comparison: {
    expected_source: string | null;
    accuracy: number;
    n_expected: number;
    substitutions: number;
    insertions: number;
    deletions: number;
    diff: string;
  } | null;
  review: {
    from: string;
    recorded_at: string;
    take_id: string;
    expected: string | null;
    collapse_rests: boolean;
    /* Which microphone profile the timings came from, and what it corrected
       by. Null is a real and common answer — no calibration — and is written
       out rather than omitted, so a reader can tell "not calibrated" from "a
       report too old to say". */
    calibration: {
      profile: string;
      offset_ms: number;
      /** True when that offset was set by hand rather than measured. */
      adjusted: boolean;
    } | null;
  };
}

export function buildJsonReport(
  review: Review,
  settings: ReviewSettings,
  now = new Date(),
): JsonReport {
  const { take, analysis: g, ref } = review;
  const tol = settings.tolerance;

  /* Whatever is in the intended-message box is the target — including a message
     typed in there, which is the whole reason it is editable. The one
     exception: with nothing supplied the box defaults to your own decode, and
     scoring that would be a meaningless 100%, so an untouched box with no
     recorded target reports no comparison at all. */
  const edited = settings.expected !== (take.expected ?? take.decoded);
  const intended = edited ? settings.expected : take.expected;

  const report: JsonReport = {
    source: take.source,
    // `...+00:00` at second resolution: an offset rather than a `Z`, and no
    // fractional part, so reports sort as text in the order they were made.
    generated: now.toISOString().replace(/\.\d+Z$/, "+00:00"),
    text: review.actual.text,
    tone_hz: take.toneHz,
    sample_rate: take.rate,
    // Measured speed comes from the recording's own DSP and does not move with
    // the controls — it is what you actually sent.
    measured: {
      char_wpm: round(take.measured.charWpm, 2),
      farnsworth_wpm: round(take.measured.farnsworthWpm, 2),
      unit_ms: round(take.measured.unitSec * 1000, 2),
    },
    target: {
      char_wpm: round(settings.charWpm, 2),
      farnsworth_wpm: round(settings.farnsworthWpm, 2),
      unit_ms: round(ref.unitSec * 1000, 2),
    },
    analysis: {
      tolerance: tol,
      within_tolerance_frac: round(g.withinTolFrac, 4),
      pauses_ignored: g.nPauses,
      elements: g.stats.map((s) => ({
        name: s.name,
        n: s.n,
        mean_units: round(s.meanUnits, 3),
        std_units: round(s.stdUnits, 3),
        target_units: round(s.targetUnits, 3),
        ok: Math.abs(s.meanUnits - s.targetUnits) <= tol * s.targetUnits,
      })),
      deviations: g.deviations.map((d) => ({
        time_sec: round(d.timeSec, 2),
        kind: d.kind,
        value_units: round(d.valueUnits, 2),
        target_units: round(d.targetUnits, 2),
        context: d.context,
      })),
    },
    comparison: null,
    review: {
      from: "cw-trainer",
      recorded_at: take.recordedAt,
      take_id: take.id,
      expected: intended,
      // Off, every long silence is graded as spacing, which moves both the
      // consistency figure and the deviation list. Recording it is what keeps
      // two dumps of the same session comparable.
      collapse_rests: settings.collapseRests,
      calibration: take.profile
        ? {
            profile: take.profile.nickname,
            offset_ms: round(take.profile.releaseOffsetSec * 1000, 2),
            adjusted: take.profile.adjusted === true,
          }
        : null,
    },
  };

  if (intended && review.comparison) {
    const c = review.comparison;
    report.comparison = {
      expected_source: edited ? "(edited in the review)" : take.expectedSource,
      accuracy: round(c.accuracy, 4),
      n_expected: c.nExpected,
      substitutions: c.substitutions,
      insertions: c.insertions,
      deletions: c.deletions,
      diff: diffText(c.ops),
    };
  }

  return report;
}
