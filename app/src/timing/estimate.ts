/* Measuring the sender's own timing off the recording.
 *
 * Nothing here knows the target speed. The question is only "what did this
 * person actually do", answered by clustering: marks fall into two groups (dit
 * and dah) and silences fall into three (inside a character, between
 * characters, between words).
 */

import type { Segment, Timing } from "@/types";
import { median } from "@/dsp/segments";
import { keyableSymbols } from "@/morse";
import { farnsworthFromCharGap } from "./model";

/** Tiny deterministic 1-D k-means. Returns sorted cluster centers.
 *
 * Deterministic matters more than it sounds: centers seeded by chance would
 * make the measured speed wobble between runs on the same recording, and the
 * user would reasonably read that as the tool being unreliable. Seeding them
 * evenly across the sorted range gives the same answer every time. */
export function kmeans1d(
  values: readonly number[],
  k: number,
  iters = 50,
): number[] {
  if (values.length === 0) return [];
  const kk = Math.min(k, values.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return [lo];

  let centers = Array.from({ length: kk }, (_, j) =>
    kk === 1 ? lo : lo + ((hi - lo) * j) / (kk - 1),
  );

  for (let it = 0; it < iters; it++) {
    const sums = new Float64Array(kk);
    const counts = new Int32Array(kk);
    for (const v of values) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < kk; j++) {
        const d = Math.abs(v - centers[j]!);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      sums[best] = sums[best]! + v;
      counts[best] = counts[best]! + 1;
    }
    const next = centers.map((c, j) =>
      counts[j]! > 0 ? sums[j]! / counts[j]! : c,
    );
    // Relative-plus-absolute tolerance, so a center near zero settles on the
    // absolute term and a large one on the relative.
    const settled = next.every(
      (v, j) => Math.abs(v - centers[j]!) <= 1e-8 + 1e-5 * Math.abs(centers[j]!),
    );
    // Break *before* adopting `next`: once the move is below the tolerance the
    // OLD centers are the answer. Taking the new ones would be one more
    // iteration than the test just said was needed, which sounds harmless and
    // is exactly the kind of off-by-one that makes two runs disagree.
    if (settled) break;
    centers = next;
  }
  return centers.sort((a, b) => a - b);
}

/** Assign each value to its nearest center. */
function labelsFor(values: readonly number[], centers: readonly number[]): number[] {
  return values.map((v) => {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < centers.length; j++) {
      const d = Math.abs(v - centers[j]!);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
  });
}

/** Estimate the character-gap length from the inter-character silences.
 *
 * Character gaps usually outnumber word gaps, which outnumber pauses between
 * transmissions, so the character gap is normally the most populous cluster —
 * not simply the shortest, since a few spurious short gaps can form a small
 * low cluster in heavily Farnsworth-spaced sending. But when the text is made
 * of very short words the word gaps can outnumber the character gaps, so if
 * the lowest cluster holds a substantial share we take *it*.
 *
 * Clustered in log space so a single long pause doesn't drag the means. */
export function dominantGap(inter: readonly number[]): number {
  if (inter.length <= 2) return median(inter);

  const log = inter.map((v) => Math.log(v));
  const k = inter.length >= 6 ? 3 : 2;
  const centers = kmeans1d(log, k);
  const labels = labelsFor(log, centers);
  const counts = centers.map((_, j) => labels.filter((l) => l === j).length);

  // Scan clusters shortest-first and take the first "real" one: the character
  // gap is the shortest gap class that occurs often. That skips a handful of
  // spurious short gaps and a couple of intra-character gaps that leaked past
  // the element/character split, while still preferring character gaps over
  // word gaps when the words are short.
  const bar = Math.max(3, 0.2 * inter.length);
  let chosen = counts.indexOf(Math.max(...counts)); // fallback: most populous
  const byCenter = centers.map((c, j) => ({ c, j })).sort((a, b) => a.c - b.c);
  for (const { j } of byCenter) {
    if (counts[j]! >= bar) {
      chosen = j;
      break;
    }
  }

  const members = inter.filter((_, i) => labels[i] === chosen);
  return members.length ? median(members) : Math.exp(centers[chosen]!);
}

/** How many character gaps and word gaps the intended text calls for. */
export function gapClasses(text: string): { chars: number; words: number } {
  const words = text
    .toUpperCase()
    .split(/\s+/)
    .map((w) => keyableSymbols(w))
    .filter((w) => w.length > 0);
  return {
    chars: words.reduce((a, w) => a + Math.max(w.length - 1, 0), 0),
    words: Math.max(words.length - 1, 0),
  };
}

/** Derive dit length, speeds, and classification thresholds from segments.
 *
 * `expected` is the intended message. It is used for exactly one thing — see
 * the note at the character-gap decision below — and changes nothing else. */
export function estimateTiming(
  segs: readonly Segment[],
  expected?: string | null,
): Timing {
  const marks = segs.filter((s) => s[0] === 1).map((s) => s[1]);
  if (marks.length === 0) {
    throw new Error("No keyed tone detected — check tone frequency / input.");
  }

  /* Only the silences BETWEEN marks measure spacing.
   *
   * A recording opens and closes with dead air — the capture starts when you
   * click and ends when you click, and even after trimming there is half a
   * second of pad left at each end by design. Those two silences are not gaps
   * between anything: nothing was keyed on one side of them, so they say
   * nothing about how the sender spaced their sending.
   *
   * Counted, they are simply outliers among dozens of real gaps and the
   * clustering below absorbs them. But send ONE character — a prosign, a
   * single letter drilled on its own — and there are no real inter-character
   * gaps at all, so the two pads become the entire evidence for the character
   * gap: half a second of it, read as enormously Farnsworthed sending. A
   * clean <BK> at 25 wpm was reported as 25 wpm characters at 13 overall,
   * which for a single character cannot be true at any speed — with no gaps
   * inside it, the overall rate IS the character rate. */
  let firstMark = -1;
  let lastMark = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i]![0] !== 1) continue;
    if (firstMark < 0) firstMark = i;
    lastMark = i;
  }
  const gaps = segs
    .slice(firstMark, lastMark + 1)
    .filter((s) => s[0] === 0)
    .map((s) => s[1]);

  // --- Marks: cluster into dit and dah. ---------------------------------- //
  const markCenters = kmeans1d(marks, 2);
  let unit: number;
  let ditDahSplit: number;
  if (markCenters.length === 2) {
    const ditC = markCenters[0]!;
    const dahC = markCenters[1]!;
    // Combine both estimates of the unit; a dah is three of them.
    unit = (ditC + dahC / 3) / 2;
    ditDahSplit = (ditC + dahC) / 2;
  } else {
    unit = markCenters[0]!;
    ditDahSplit = unit * 2;
  }

  const charWpm = 1.2 / unit;

  // --- Gaps: element vs character vs word. ------------------------------- //
  // Element gaps stay ~1 unit even under Farnsworth, so element-vs-character
  // splits at a fixed 2 units. Character and word gaps both stretch but keep
  // the standard 3:7 ratio, so once the character gap is known the word split
  // is charGap * 5/3.
  const elementCharSplit = unit * 2;
  const inter = gaps.filter((g) => g >= elementCharSplit);

  let charGap = unit * 3;
  if (inter.length > 0) {
    charGap = dominantGap(inter);
    /* dominantGap returns the most populous inter-character silence and calls
       it the character gap, which holds for ordinary text. It does not hold
       for a single-letter drill: "A B C D E F" has no character gaps at all,
       so the dominant silence there is a *word* gap. Reading it as a character
       gap puts Ta out by 7/3 — an overall speed of 8 wpm for sending that was
       14, and a decode of "ABCDEF" with every word break swallowed, because
       charWordSplit lands above the gaps that made it.

       The audio cannot settle this. Equal silences between single letters are
       loose character gaps or word gaps depending only on what was meant, and
       both readings fit the same recording exactly. The intended text is the
       one thing that knows, so use it when it is there: whichever class the
       text has more of is the class the dominant cluster belongs to. */
    if (expected) {
      const { chars, words } = gapClasses(expected);
      if (words > chars) charGap *= 3 / 7; // it was a word gap all along
    }
  }
  const wordGap = charGap * (7 / 3);
  const charWordSplit = charGap * (5 / 3);

  const farns = farnsworthFromCharGap(charWpm, charGap);

  const notes: string[] = [];
  if (farns < charWpm * 0.95) {
    notes.push(
      `Farnsworth spacing detected (~${Math.round(charWpm)} wpm characters, ` +
        `~${Math.round(farns)} wpm overall).`,
    );
  }

  return {
    unitSec: unit,
    charWpm,
    farnsworthWpm: farns,
    ditDahSplit,
    elementCharSplit,
    charWordSplit,
    charGapSec: charGap,
    wordGapSec: wordGap,
    notes,
  };
}
