/* The shape of the Python oracle dumps.
 *
 * Types and pure helpers only — deliberately no filesystem access, because the
 * browser tier imports this too and reaching for node:fs there takes the whole
 * file down before a single test runs. Reading from disk lives in oracle-fs.ts,
 * which only the node tiers import.
 */

import type { Segment } from "@/types";

export interface OracleTiming {
  unitSec: number;
  charWpm: number;
  farnsworthWpm: number;
  ditDahSplit: number;
  elementCharSplit: number;
  charWordSplit: number;
  charGapSec: number;
  wordGapSec: number;
}

export interface OracleBlock {
  t0: number;
  t1: number;
  kind: string;
  units: number;
  targetUnits: number;
  targetKind: string;
  context: string;
}

export interface OracleTimeline {
  text: string;
  duration: number;
  blocks: OracleBlock[];
  chars: Array<{
    char: string;
    pattern: string;
    t0: number;
    t1: number;
    nBlocks: number;
    leadGapKind: string | null;
  }>;
}

export interface OracleAnalysis {
  tolerance: number;
  withinTolFrac: number;
  nPauses: number;
  stats: Array<{
    name: string;
    n: number;
    meanUnits: number;
    stdUnits: number;
    targetUnits: number;
  }>;
  deviations: Array<{
    timeSec: number;
    kind: string;
    valueUnits: number;
    targetUnits: number;
    context: string;
  }>;
}

export interface OracleGradingArm {
  /** As the decoder built it, classes guessed from duration alone. */
  timeline: OracleTimeline;
  /** The same timeline after the intended text corrected the gap classes. */
  retargetedTimeline: OracleTimeline;
  retargeted: number;
  analysis: OracleAnalysis;
}

export interface OracleCase {
  name: string;
  expected: string;
  charWpm: number;
  farnsworthWpm: number | null;
  dspRate: number;
  toneHz: number;
  segments: Array<[number, number]>;
  grading: {
    measured: OracleTiming;
    ref: OracleTiming;
    rests: OracleGradingArm;
    noRests: OracleGradingArm;
    ideal: OracleTimeline;
    comparison: {
      expected: string;
      decoded: string;
      accuracy: number;
      nExpected: number;
      substitutions: number;
      insertions: number;
      deletions: number;
      diff: string;
    } | null;
  };
  /** Present for the fixtures read from a WAV on disk. */
  sourceWav?: string;
  /** The speed the recording was really sent at — ground truth, which neither
   *  decoder is told. Only on the real-recording fixtures. */
  nominalWpm?: number;
  /** Present for the cases the Python synthesizer generated. */
  synth?: {
    text: string;
    wpm: number;
    farnsworthWpm: number;
    rate: number;
    /** Fingerprint of the Python waveform, so the TS synthesizer can be shown
     *  to produce the same signal rather than merely a decodable one. */
    nSamples: number;
    absSum: number;
    head: number[];
  };
}


/** The oracle's segments, typed the way the app's own code expects them. */
export function oracleSegments(c: OracleCase): Segment[] {
  return c.segments.map(([s, d]) => [s === 1 ? 1 : 0, d] as Segment);
}
