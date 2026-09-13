/* Splitting one continuous recording into the things it contains.
 *
 * Calibration needs several drills — silence, held dits, held dahs, and
 * whatever else is worth capturing — and asking somebody to start and stop a
 * recorder between each one is a poor way to get them. Far better to record
 * once, leave a few seconds of quiet between sections, and work out afterwards
 * which part was which.
 *
 * Sections are found by silence, but not by a fixed amount of it. A fixed
 * threshold cannot work, and the reason is worth stating because it is not
 * obvious: the quiet somebody leaves between sections and the quiet inside the
 * single-element drill are the same quiet. Asked to key isolated dits "about
 * two seconds apart" and to pause "a few seconds" between sections, a real
 * recording comes back with separators of 2.8, 2.1 and 1.9 seconds and
 * internal gaps of 2.0 — interleaved, with no value between them.
 *
 * So the separator is chosen from the recording itself, by looking for the
 * widest relative jump in the sorted gap lengths. That adapts to whoever was
 * keying and to whatever speed they were keying at, where a fixed figure in
 * seconds is wrong for one or the other. It splits the single-element drill
 * into single elements, which is then put back together afterwards: a run of
 * consecutive sections holding one element each was one drill all along.
 *
 * Each section is classified by the shape of what is in it, which is
 * unambiguous for exactly the drills calibration cares about — a held paddle
 * produces elements that are all the same length, and that is a very
 * distinctive thing for a recording to contain.
 *
 * Nothing here assumes an order. The caller usually knows what it asked for
 * and can check this against it, but the classification stands on its own, so
 * a recording made in the wrong order still comes apart correctly.
 */

import { envelope } from "./envelope";
import { detectTone } from "./tone";
import { segmentsFrom, type SegmentOptions } from "./index";
import type { Segment } from "@/types";

/** Shortest quiet that may ever be treated as a separator.
 *
 * Not the separator itself — that is measured per recording — but a floor
 * under it, so that ordinary spacing inside a message can never be mistaken
 * for the end of a section however the gaps happen to fall. A word gap is
 * seven units, which is half a second even at a slow 15 wpm. */
export const MIN_SEPARATOR_SEC = 0.8;

/** How much wider a separator must be than the gap below it in the sorted
 *  list, before the split is believed. Below this the recording has no clear
 *  break in it and is treated as one section. */
const SEPARATOR_JUMP = 1.8;

/** Shortest thing worth calling a section. Below this it is a cough. */
const MIN_SECTION_SEC = 0.5;

export type SectionKind =
  /** Nothing keyed. The noise floor lives here. */
  | "silence"
  /** Every element the same length — a held paddle. */
  | "uniform"
  /** Same, but spaced far apart: single elements, one at a time. */
  | "isolated"
  /** Elements of more than one length: iambic, or a message. */
  | "mixed";

export interface Section {
  readonly kind: SectionKind;
  /** Bounds in the original recording. */
  readonly from: number;
  readonly to: number;
  readonly startSec: number;
  readonly durationSec: number;
  /** Element lengths found inside it, in seconds. */
  readonly marks: readonly number[];
  /** Median element length. NaN for silence. */
  readonly medianMarkSec: number;
  /** Median gap between elements. NaN when there are fewer than two. */
  readonly medianGapSec: number;
}

function median(v: readonly number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function percentile(v: readonly number[], p: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(((s.length - 1) * p) / 100)))]!;
}

/** Every stretch where something is being keyed, with no merging at all.
 *
 * Deliberately a crude threshold rather than the real segmenter: this only has
 * to answer "is anything happening here", and a loose answer is more robust
 * across sections recorded at different levels than a careful one. */
function keyedRuns(env: Float32Array): Array<[number, number]> {
  const floor = percentile(Array.from(env), 10);
  const peak = percentile(Array.from(env), 99);
  if (!(peak > floor)) return [];
  const level = floor + 0.2 * (peak - floor);

  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i]! > level) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, env.length]);
  return runs;
}

/** The quiet that separates sections in THIS recording, in seconds.
 *
 * Found as the widest relative jump in the sorted gaps, at or above the floor.
 * A recording with a clean break has an obvious one — half a second of word
 * spacing on one side, two seconds of somebody reading the next instruction on
 * the other. A recording without one returns Infinity and stays whole, which
 * is the right answer for a single take of ordinary sending. */
export function separatorSec(gapsSec: readonly number[]): number {
  // Only gaps that could be a separator at all are considered. Without this
  // the widest jump in a calibration recording is the one between spacing
  // inside a drill and the two seconds between isolated elements — a real
  // jump, twenty-five fold, and entirely the wrong one. Everything below the
  // floor is ordinary spacing and has no say in where sections divide.
  const candidates = [...gapsSec]
    .filter((g) => g >= MIN_SEPARATOR_SEC)
    .sort((a, b) => a - b);
  if (candidates.length === 0) return Infinity;

  let best = Infinity;
  let bestJump = SEPARATOR_JUMP;
  for (let i = 1; i < candidates.length; i++) {
    const lo = candidates[i - 1]!;
    const hi = candidates[i]!;
    const jump = hi / lo;
    if (jump > bestJump) {
      bestJump = jump;
      // Geometric mean, so the threshold sits in the middle of the jump in the
      // same proportional sense the jump was measured.
      best = Math.sqrt(lo * hi);
    }
  }

  // No clear break among them: they are all of a kind, so every one is a
  // separator. That is the case where somebody left a couple of seconds
  // between sections and also between isolated elements, and the elements get
  // put back together afterwards.
  return best === Infinity ? MIN_SEPARATOR_SEC : best;
}

function classify(marks: readonly number[], gaps: readonly number[]): SectionKind {
  if (marks.length === 0) return "silence";
  if (marks.length < 3) return "mixed";

  // A held paddle makes every element the same length. Anything with dits and
  // dahs in it spreads by a factor of three, so the two populations are not
  // close and the split does not need to be delicate.
  const spread = percentile(marks, 90) / Math.max(percentile(marks, 10), 1e-9);
  if (spread > 1.8) return "mixed";

  // Uniform, so the only question left is whether they came one after another
  // or one at a time.
  const gap = median(gaps);
  const mark = median(marks);
  if (Number.isFinite(gap) && gap > 6 * mark) return "isolated";
  return "uniform";
}

export interface SplitOptions extends SegmentOptions {
  /** Force the separator instead of measuring it. Tests mostly. */
  readonly gapSec?: number;
}

/** A run of consecutive one-element sections was one drill all along.
 *
 * The single-element drill is spaced like a separator, so the split above cuts
 * it into individual elements. Nothing is lost by that — putting it back is
 * unambiguous, because no other part of a calibration recording produces a row
 * of sections holding exactly one element each. */
function mergeIsolated(groups: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  const flush = () => {
    if (run.length === 0) return;
    // Two or more singles in a row were a drill; one on its own stays alone.
    if (run.length >= 2) out.push(run);
    else out.push([run[0]!]);
    run = [];
  };
  for (const g of groups) {
    if (g.length === 1) {
      run.push(...g);
      continue;
    }
    flush();
    out.push(g);
  }
  flush();
  return out;
}

/** Break a recording into its sections and say what each one holds. */
export function splitSections(
  samples: Float32Array,
  rate: number,
  options: SplitOptions = {},
): Section[] {
  if (samples.length === 0) return [];
  const toneHz = options.toneHz ?? detectTone(samples, rate);
  const env = envelope(samples, rate, toneHz);
  const runs = keyedRuns(env);

  const gapsSec: number[] = [];
  for (let i = 1; i < runs.length; i++) gapsSec.push((runs[i]![0] - runs[i - 1]![1]) / rate);
  const sepSec = options.gapSec ?? separatorSec(gapsSec);
  const sep = sepSec * rate;

  // Group the keyed runs into sections, then put the single-element drill back
  // together.
  const groups: Array<Array<[number, number]>> = [];
  for (const r of runs) {
    const last = groups[groups.length - 1];
    if (last && r[0] - last[last.length - 1]![1] < sep) last.push(r);
    else groups.push([r]);
  }
  const merged = mergeIsolated(groups);

  const out: Section[] = [];
  let at = 0;

  const quiet = (from: number, to: number) => {
    if (to - from < MIN_SECTION_SEC * rate) return;
    out.push({
      kind: "silence",
      from,
      to,
      startSec: from / rate,
      durationSec: (to - from) / rate,
      marks: [],
      medianMarkSec: NaN,
      medianGapSec: NaN,
    });
  };

  for (const group of merged) {
    const from = group[0]![0];
    const to = group[group.length - 1]![1];
    quiet(at, from);
    at = to;
    if (to - from < MIN_SECTION_SEC * rate) continue;

    // Each section is segmented on its own, so a quiet drill is not measured
    // against a loud one's threshold.
    let segs: Segment[] = [];
    try {
      segs = segmentsFrom(samples.subarray(from, to), rate, { ...options, toneHz }).segments;
    } catch {
      segs = [];
    }
    const marks = segs.filter((g) => g[0] === 1).map((g) => g[1]);
    // Gaps from the segmenter rather than from the crude run finder above.
    // The crude pass splits an element whose envelope ripples, so its idea of
    // a gap includes a lot of gaps that are not between elements at all — and
    // the median of those is milliseconds, which would make a drill of
    // isolated elements look like a held paddle.
    const innerGaps = segs.slice(1, -1).filter((g) => g[0] === 0).map((g) => g[1]);

    out.push({
      kind: classify(marks, innerGaps),
      from,
      to,
      startSec: from / rate,
      durationSec: (to - from) / rate,
      marks,
      medianMarkSec: median(marks),
      medianGapSec: median(innerGaps),
    });
  }
  quiet(at, samples.length);
  return out;
}

/** Which uniform section is the dits and which the dahs.
 *
 * Told apart by length relative to each other rather than against an absolute
 * figure, so neither the speed nor the room has to be known first. A dah is
 * three times a dit, so a factor of two either way is plenty of margin. */
export function pairDrills(
  sections: readonly Section[],
): { dits: Section | null; dahs: Section | null } {
  const uniform = sections
    .filter((s) => s.kind === "uniform")
    .sort((a, b) => a.medianMarkSec - b.medianMarkSec);
  if (uniform.length < 2) {
    return { dits: uniform[0] ?? null, dahs: null };
  }
  const dits = uniform[0]!;
  const dahs = uniform[uniform.length - 1]!;
  // If the longest is not meaningfully longer than the shortest, they are not
  // a dit drill and a dah drill — they are the same drill recorded twice.
  if (dahs.medianMarkSec < 2 * dits.medianMarkSec) return { dits, dahs: null };
  return { dits, dahs };
}
