/* Segments + thresholds -> what was keyed, and text -> what should have been.
 *
 * `buildTimeline` is the single source of truth for "what did the sender
 * actually key": the decoded text, the per-character grouping, and every mark
 * and gap measured against a timing all come out of this one pass. The decode,
 * the grade, and the chart are all thin layers over it, which is why they can
 * never disagree about where a character starts.
 */

import type { Block, BlockKind, Char, Segment, Timeline, Timing } from "@/types";
import { median } from "@/dsp/segments";
import { CHAR_TO_MORSE, decodePattern, keyableSymbols } from "@/morse";

/** A silence shorter than this many nominal word gaps is always spacing, never
 *  a rest — the floor under REST_OUTLIER, so a wide word gap in otherwise tight
 *  sending can't be written off as a stop. */
export const PAUSE_FACTOR = 2.0;

/** A silence longer than this many times the sender's own typical
 *  inter-character gap is them resting between transmissions, not a spacing
 *  error.
 *
 *  Measured against the sender rather than the target because that is what
 *  actually separates the two cases. Sending with the spacing wound out puts
 *  *every* gap several times over nominal — consistently, and that is a real
 *  spacing error worth grading. Stopping to read the next exercise puts *one*
 *  gap far out of line with all the others. A fixed multiple of the target's
 *  word gap cannot tell those apart at any setting: measured that way,
 *  wide-but-even spacing and a genuine stop overlap. */
export const REST_OUTLIER = 3.0;

function block(
  t0: number,
  t1: number,
  kind: BlockKind,
  units: number,
  targetUnits: number,
  context = "",
): Block {
  return { t0, t1, kind, units, targetUnits, context, targetKind: kind };
}

/** Turn (state, duration) segments plus timing thresholds into a Timeline.
 *
 * `pauseFactor` is where a long silence stops being spacing and becomes a rest;
 * pass Infinity to grade every silence as spacing however long it ran. */
export function buildTimeline(
  segs: readonly Segment[],
  timing: Timing,
  pauseFactor: number = PAUSE_FACTOR,
): Timeline {
  const u = timing.unitSec;
  const charGapU = timing.charGapSec ? timing.charGapSec / u : 3;
  const wordGapU = timing.wordGapSec ? timing.wordGapSec / u : 7;

  // What this sender's own between-character silences look like, so a rest can
  // be judged as an outlier against them. Median, not mean: one 200-unit stop
  // would drag a mean up far enough to hide itself.
  const spacing: number[] = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (seg[0] === 0 && seg[1] >= timing.elementCharSplit) {
      spacing.push(seg[1] / u);
    }
  }
  const pauseFloor = Math.max(
    pauseFactor * wordGapU,
    REST_OUTLIER * median(spacing),
  );

  const text: string[] = [];
  const chars: Char[] = [];
  const blocks: Block[] = [];

  let pending: Block[] = []; // blocks of the character in progress
  let pattern: string[] = []; // its elements
  let lead: Block | null = null; // the char-or-word gap that preceded it
  let t = 0;

  /** Close out the character in progress.
   *
   * A character ends at its own last mark, never at the cursor: `t` has
   * already advanced past the gap that triggered the flush, and at the end of
   * the loop it sits beyond the trailing silence. Reading the end off
   * `pending` keeps that silence out of the character's span. */
  const flush = () => {
    if (pattern.length === 0) return;
    const pat = pattern.join("");
    const ch = decodePattern(pat);
    text.push(ch);
    chars.push({
      char: ch,
      pattern: pat,
      t0: pending[0]!.t0,
      t1: pending[pending.length - 1]!.t1,
      blocks: pending,
      leadGap: lead,
    });
    pending = [];
    pattern = [];
    lead = null;
  };

  const tail = () => text.join("").slice(-10).trim();

  const n = segs.length;
  for (let i = 0; i < n; i++) {
    const [state, dur] = segs[i]!;
    const start = t;
    t += dur;
    const vu = dur / u;

    if (state === 1) {
      const isDit = dur < timing.ditDahSplit;
      pattern.push(isDit ? "." : "-");
      const b = block(start, t, isDit ? "dit" : "dah", vu, isDit ? 1 : 3);
      pending.push(b);
      blocks.push(b);
      continue;
    }

    // The very first and last silences are the recording, not the sending.
    if (i === 0 || i === n - 1) continue;

    if (dur < timing.elementCharSplit) {
      const b = block(start, t, "element-gap", vu, 1);
      pending.push(b);
      blocks.push(b);
    } else if (dur < timing.charWordSplit) {
      flush();
      lead = block(start, t, "char-gap", vu, charGapU, tail());
      blocks.push(lead);
    } else {
      flush();
      const isPause = vu > pauseFloor;
      lead = block(
        start,
        t,
        isPause ? "pause" : "word-gap",
        vu,
        isPause ? 0 : wordGapU,
        tail(),
      );
      blocks.push(lead);
      text.push(" ");
    }
  }
  flush();

  return { text: text.join(""), chars, blocks, duration: 0 };
}

/** Segments straight to text, for when nothing but the message matters. */
export function decodeSegments(
  segs: readonly Segment[],
  timing: Timing,
): string {
  return buildTimeline(segs, timing).text;
}

/** Render `text` as the timeline a machine sender would have keyed.
 *
 * Same shape as a decoded Timeline, laid out exactly the way the synthesizer
 * builds its on/off list — so "perfect" here is precisely what you hear when
 * you play the target track, and every block's `units` equals its
 * `targetUnits` by construction. */
export function idealTimeline(text: string, timing: Timing): Timeline {
  const u = timing.unitSec;
  const charGap = timing.charGapSec || 3 * u;
  const wordGap = timing.wordGapSec || 7 * u;

  const chars: Char[] = [];
  const blocks: Block[] = [];
  let t = 0;

  const words = text
    .toUpperCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  words.forEach((word, wi) => {
    let lead: Block | null = null;
    if (wi > 0) {
      lead = block(t, t + wordGap, "word-gap", wordGap / u, wordGap / u);
      blocks.push(lead);
      t += wordGap;
    }
    keyableSymbols(word).forEach((ch, li) => {
      if (li > 0) {
        lead = block(t, t + charGap, "char-gap", charGap / u, charGap / u);
        blocks.push(lead);
        t += charGap;
      }
      const pattern = CHAR_TO_MORSE[ch]!;
      const pending: Block[] = [];
      const c0 = t;
      for (let ei = 0; ei < pattern.length; ei++) {
        if (ei > 0) {
          const gap = block(t, t + u, "element-gap", 1, 1);
          pending.push(gap);
          blocks.push(gap);
          t += u;
        }
        const isDit = pattern[ei] === ".";
        const dur = isDit ? u : 3 * u;
        const mark = block(
          t,
          t + dur,
          isDit ? "dit" : "dah",
          isDit ? 1 : 3,
          isDit ? 1 : 3,
        );
        pending.push(mark);
        blocks.push(mark);
        t += dur;
      }
      chars.push({ char: ch, pattern, t0: c0, t1: t, blocks: pending, leadGap: lead });
      lead = null;
    });
  });

  return { text: words.join(" "), chars, blocks, duration: t };
}
