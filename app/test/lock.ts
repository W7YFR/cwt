/* The clean-path lock: what the DSP says today, recorded so it cannot drift.
 *
 * This is not the oracle. That one allows 1.5 ms per boundary, which is the
 * right tolerance for a reference derived along different lines — but it means
 * a change to the DSP could move every boundary on every clean recording by
 * 1.4 ms and still pass. That is exactly the kind of change this file exists
 * to refuse.
 *
 * So the comparison here is against our own previous answer, and the tolerance
 * is nothing at all. Work on poor-quality audio must leave good
 * audio bit-identical, and "bit-identical" is the only version of that promise
 * a test can actually enforce.
 *
 * Segment durations are integer sample counts divided by the rate, so they are
 * exactly representable and compare exactly. A boundary only moves if the
 * threshold crossing lands on a different *sample*, which is a discrete
 * decision and a real change every time.
 *
 * Re-record deliberately, never reflexively:
 *
 *     LOCK_RECORD=1 npx vitest run --project pure clean-path
 *
 * A diff in the recorded file is a diff in what users get. If you did not mean
 * to change the numbers, the failure is the point.
 */

import type { Segment } from "@/types";
import { segmentsFrom } from "@/dsp";
import { estimateTiming, buildTimeline, targetTiming } from "@/timing";
import { synthesize, peakNormalize } from "@/audio/synth";
import { targetTiming as ideal } from "@/timing/model";

/** A recording that is already good, and must stay exactly as good.
 *
 * `virtual` is the loopback capture — no microphone, no room, every mark at
 * the same level. It is the best input the app will ever see and the reference
 * the impaired-audio work is not allowed to cost anything. */
export interface CleanWav {
  readonly file: string;
  readonly expected: string;
  readonly charWpm: number;
  readonly farnsworthWpm: number | null;
}

export const CLEAN_WAVS: readonly CleanWav[] = [
  { file: "cq-ab1cd-20wpm-k3ng.wav", expected: "CQ CQ DE AB1CD K", charWpm: 20, farnsworthWpm: 20 },
  { file: "cq-de-w7yfr.wav", expected: "CQ DE W7YFR", charWpm: 25, farnsworthWpm: null },
  { file: "cq-de-w7yfr-virtual.wav", expected: "CQ DE W7YFR", charWpm: 25, farnsworthWpm: null },
];

/** Everything a change to the DSP could move, in one record. */
export interface Reading {
  name: string;
  rate: number;
  toneHz: number;
  threshold: number;
  /** Flat [state, duration, state, duration, ...] — one line per case in the
   *  recorded JSON instead of one line per segment, so a real diff is legible
   *  rather than a thousand-line wall. */
  segments: number[];
  text: string;
  charWpm: number;
  farnsworthWpm: number;
}

function flatten(segs: readonly Segment[]): number[] {
  const out: number[] = [];
  for (const [state, dur] of segs) out.push(state, dur);
  return out;
}

/** Run the pipeline and write down everything it decided. */
export function read(
  name: string,
  samples: Float32Array,
  rate: number,
  expected: string,
  charWpm: number,
  farnsworthWpm: number | null,
): Reading {
  const got = segmentsFrom(samples, rate);
  const measured = estimateTiming(got.segments, expected);
  return {
    name,
    rate,
    toneHz: got.toneHz,
    threshold: got.threshold,
    segments: flatten(got.segments),
    text: buildTimeline(got.segments, targetTiming(charWpm, farnsworthWpm)).text,
    charWpm: measured.charWpm,
    farnsworthWpm: measured.farnsworthWpm,
  };
}

/** The synthesized half of the corpus, rendered the same way the oracle test
 *  renders it so the two are talking about the same signal. */
export function readSynth(
  name: string,
  text: string,
  wpm: number,
  farnsworthWpm: number,
  rate: number,
): Reading {
  const { samples } = synthesize(text, ideal(wpm, farnsworthWpm), {
    rate,
    toneHz: 600,
    padSec: 0.1,
  });
  peakNormalize(samples);
  return read(name, samples, rate, text, wpm, farnsworthWpm);
}
