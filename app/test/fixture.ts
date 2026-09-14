/* Turning an oracle case into a Take and a Review, so every tier can drive the
 * real app code from real recordings instead of from a hand-built object that
 * only resembles one.
 */

import { defaultSettings, reviewTake } from "@/timing";
import type { Review, ReviewSettings, Take } from "@/types";
import { oracleSegments, type OracleCase } from "./oracle";
import { ORACLE_CASES } from "./oracle-data";

export function takeFrom(c: OracleCase): Take {
  const segments = oracleSegments(c);
  const durationSec = segments.reduce((a, s) => a + s[1], 0);
  return {
    id: `oracle-${c.name}`,
    recordedAt: "2026-01-01T00:00:00+00:00",
    source: c.name,
    toneHz: c.toneHz,
    rate: c.dspRate,
    durationSec,
    peak: 1,
    segments,
    decoded: c.grading.rests.timeline.text,
    expected: c.expected || null,
    expectedSource: c.expected ? "the oracle fixture" : null,
    measured: {
      ...c.grading.measured,
      notes: [],
    },
    target: {
      charWpm: c.charWpm,
      farnsworthWpm: c.farnsworthWpm ?? c.charWpm,
      explicit: true,
    },
    padSec: 0.5,
  };
}

export function reviewFrom(
  c: OracleCase,
  overrides: Partial<ReviewSettings> = {},
): { take: Take; settings: ReviewSettings; review: Review } {
  const take = takeFrom(c);
  const settings = { ...defaultSettings(take), ...overrides };
  return { take, settings, review: reviewTake(take, settings) };
}

/** One case by name, so a test can say which recording it means. */
export function caseNamed(name: string): OracleCase {
  const found = ORACLE_CASES.find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `no oracle case named ${name}; have ${ORACLE_CASES.map((c) => c.name).join(", ")}`,
    );
  }
  return found;
}

/** A case with deviations to look at, for tests about the report and focus. */
export const SLOPPY = "cq-de-w7yfr.wav";
/** A clean machine-keyed case, for tests that want no deviations. */
export const CLEAN = "cq-ab1cd-20wpm-k3ng.wav";
/** Heavy Farnsworth, where the gap classes are far apart. */
export const FARNSWORTH = "synth-farnsworth";
