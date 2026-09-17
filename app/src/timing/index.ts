/* Segments in, a graded review out.
 *
 * `reviewTake` is the one function the UI calls. It is pure and synchronous:
 * the same take and the same settings always give the same review, and moving
 * a slider is a recompute rather than a mutation. That is what makes the whole
 * review re-derivable from a saved file with no audio present.
 */

import { FLASH_LEAD_DEFAULT_MS, PACE_LEAD_DEFAULT_SEC } from "@/render/geometry";
import type { Review, ReviewSettings, Segment, Take, Timeline, Timing } from "@/types";
import { compareText } from "./align";
import { grade } from "./grade";
import { pair, retarget } from "./pair";
import { buildTimeline, idealTimeline, PAUSE_FACTOR } from "./timeline";
import { estimateTiming } from "./estimate";
import { targetTiming } from "./model";

export * from "./align";
export * from "./estimate";
export * from "./grade";
export * from "./model";
export * from "./pair";
export * from "./timeline";

/** Build every derived structure for one take at one set of settings.
 *
 * The order matters and is not arbitrary:
 *   1. build the decode against the *target* timing, so measured and target
 *      units are comparable;
 *   2. pair it against the intended message, which reads `kind`;
 *   3. retarget, which writes `targetKind` and leaves `kind` alone;
 *   4. grade, which reads only `targetKind`.
 * Swapping 2 and 3 would have the pairing read classes the pairing itself
 * produced. */
export function reviewTake(take: Take, settings: ReviewSettings): Review {
  const ref = targetTiming(settings.charWpm, settings.farnsworthWpm);
  const expected = settings.expected.trim();

  const actual = buildTimeline(
    take.segments,
    ref,
    settings.collapseRests ? PAUSE_FACTOR : Infinity,
  );
  const ideal = idealTimeline(expected || actual.text, ref);

  const slots = pair(actual, ideal);
  const retargeted = expected ? retarget(slots) : 0;

  const analysis = grade(actual, ref, take.measured, settings.tolerance);
  const comparison = expected ? compareText(expected, actual.text) : null;

  return { take, ref, actual, ideal, slots, analysis, comparison, retargeted };
}

export interface DecodeOptions {
  readonly targetWpm?: number | undefined;
  readonly targetFarnsworth?: number | null | undefined;
  readonly tolerance?: number;
  readonly expected?: string | null | undefined;
}

export interface DecodeResult {
  readonly text: string;
  readonly measured: Timing;
  readonly timeline: Timeline;
  readonly ref: Timing | null;
}

/** Decode segments and, if a target speed is given, grade against it.
 *
 * The headless counterpart to `reviewTake`, used by the oracle test and by
 * anything that wants the text without building a review. */
export function decodeSegments(
  segments: readonly Segment[],
  options: DecodeOptions = {},
): DecodeResult {
  const measured = estimateTiming(segments, options.expected ?? null);
  if (options.targetWpm === undefined) {
    return {
      text: buildTimeline(segments, measured).text,
      measured,
      timeline: buildTimeline(segments, measured),
      ref: null,
    };
  }

  const ref = targetTiming(options.targetWpm, options.targetFarnsworth ?? null);
  const timeline = buildTimeline(segments, ref);
  const expected = (options.expected ?? "").trim();
  if (expected) retarget(pair(timeline, idealTimeline(expected, ref)));
  return { text: timeline.text, measured, timeline, ref };
}

/** The settings a take opens at, before the user touches anything. */
export function defaultSettings(take: Take): ReviewSettings {
  return {
    charWpm: take.target.charWpm,
    farnsworthWpm: take.target.farnsworthWpm,
    tolerance: 0.3,
    expected: take.expected ?? take.decoded,
    collapseRests: true,
    paceCursor: false,
    paceLeadSec: PACE_LEAD_DEFAULT_SEC,
    paceAbsolute: true,
    charMarkers: false,
    runScores: true,
    captionAll: false,
    advancedGrading: true,
    showDownloads: false,
    showHints: true,
    showChartControls: true,
    showRuns: "all",
    zenMode: false,
    flashCard: false,
    flashCue: true,
    flashLeadMs: FLASH_LEAD_DEFAULT_MS,
    wordPreview: false,
    runSort: "oldest",
    gainDb: 0,
    view: "per-char",
    ppu: 12,
  };
}
