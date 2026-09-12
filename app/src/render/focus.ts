/* What a deviation row is actually about.
 *
 * The highlight on the chart and the audio window both come from here rather
 * than each doing its own arithmetic — they drifted apart once, and the symptom
 * (hovering a row lit a stretch that was not what clicking it played) is very
 * hard to notice and very easy to disbelieve.
 */

import type { BlockKind, Char, Review, Slot } from "@/types";
import { PLAY_PAD } from "./geometry";
import { gapWidth, slotSpan, type Layout } from "./layout";

export type Side = "you" | "tgt";

export interface Focus {
  side: Side;
  /** Slot index the deviation belongs to. */
  idx: number;
  kind: BlockKind;
}

function charAt(slots: readonly Slot[], side: Side, i: number): Char | null {
  const s = slots[i];
  if (!s) return null;
  return side === "you" ? s.actual : s.ideal;
}

/** Does this character open a word?
 *
 * Read off `targetKind`, so the words are the ones the intended text has and
 * not the ones an overlong gap made the decoder see — the same basis the row's
 * own class comes from. */
function opensWord(ch: Char | null): boolean {
  const g = ch?.leadGap;
  return !!g && (g.targetKind === "word-gap" || g.targetKind === "pause");
}

/** The slot range a deviation is about, scoped to the class being graded.
 *
 *   char-gap  the character before, the gap, the character after — nothing
 *             more, or a neighboring gap competes with the one in question
 *   word-gap  the whole word either side, since a word gap separates words and
 *             half a word does not read as one
 *   otherwise a dit, a dah or an intra-character gap lives *inside* one
 *             character, so that character and nothing else
 *
 * That last case is deliberately narrow. Taking a neighbor on each side reads
 * as the natural choice — a mark's length only means anything in context — but
 * it fails twice over: it highlights three characters for a fault in the middle
 * one, and it buries a 23 ms hesitation inside a second and a half of audio. A
 * character is its own context; the other elements it is made of are right
 * there.
 *
 * A gap is the *lead* gap of slot `idx`, so it sits between idx-1 and idx. */
export function contextSlots(
  slots: readonly Slot[],
  side: Side,
  idx: number,
  kind: BlockKind,
): [number, number] | null {
  if (!(idx >= 0) || slots.length === 0) return null;
  const last = slots.length - 1;

  if (kind === "char-gap") return [Math.max(idx - 1, 0), Math.min(idx, last)];

  if (kind === "word-gap") {
    let lo = idx - 1;
    while (lo > 0 && !opensWord(charAt(slots, side, lo))) lo--;
    let hi = Math.min(idx, last);
    while (hi < last && !opensWord(charAt(slots, side, hi + 1))) hi++;
    return [Math.max(lo, 0), hi];
  }

  const at = Math.min(idx, last);
  return [at, at];
}

/** The same range as a time window, for playback. */
export function contextWindow(
  slots: readonly Slot[],
  side: Side,
  idx: number,
  kind: BlockKind,
): [number, number] | null {
  const r = contextSlots(slots, side, idx, kind);
  if (!r) return null;
  let first: Char | null = null;
  let last: Char | null = null;
  for (let i = r[0]; i <= r[1]; i++) {
    const c = charAt(slots, side, i);
    if (!c) continue;
    if (!first) first = c;
    last = c;
  }
  if (!first || !last) return null;
  return [Math.max(first.t0 - PLAY_PAD, 0), last.t1 + PLAY_PAD];
}

/** The same range as an x-span on the chart, for the highlight. */
export function focusSpan(
  layout: Layout,
  slots: readonly Slot[],
  focus: Focus | null,
): [number, number] | null {
  if (!focus) return null;
  const r = contextSlots(slots, focus.side, focus.idx, focus.kind);
  if (!r) return null;

  const hi = Math.min(r[1], layout.items.length - 1);
  let x0 = Infinity;
  let x1 = -Infinity;
  let leading = true;
  for (let i = r[0]; i <= hi; i++) {
    // The first character *present* on this side opens the range, so its own
    // lead gap is excluded; every later one contributes the gap that joins it
    // to the character before.
    const s = slotSpan(layout, focus.side, i, !leading);
    if (!s) continue;
    leading = false;
    x0 = Math.min(x0, s[0]);
    x1 = Math.max(x1, s[1]);
  }
  return x1 > x0 ? [x0, x1] : null;
}

/** Which slot a moment on the recording belongs to.
 *
 * Deviations carry a time, not a character, so this is how a report row finds
 * its counterpart on the chart and on the target track.
 *
 * A gap deviation's time is its lead gap's start, which is also the instant the
 * *previous* slot ends — and a slot's span runs from its lead gap to its last
 * mark, so both slots contain it. Matching the lead gap first resolves that tie
 * the right way: the row is about the gap before this character, so it belongs
 * to the character the gap leads into. Getting it backwards scoped every gap
 * row one character early. */
export function slotIndexAtTime(slots: readonly Slot[], t: number): number {
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i]!.actual;
    if (a?.leadGap && Math.abs(a.leadGap.t0 - t) < 1e-9) return i;
  }
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i]!.actual;
    if (!a) continue;
    const from = a.leadGap ? a.leadGap.t0 : a.t0;
    if (t >= from - 1e-9 && t <= a.t1 + 1e-9) return i;
    const d = Math.min(Math.abs(from - t), Math.abs(a.t1 - t));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export interface HitResult {
  block: Review["actual"]["blocks"][number];
  char: Char;
  row: Side;
  slot: Slot;
}

/** What is under a point, in content coordinates. Pure — no canvas needed. */
export function hitTest(
  layout: Layout,
  contentX: number,
  y: number,
  bands: { you: [number, number]; tgt: [number, number] },
): HitResult | null {
  const inBand = (b: [number, number]) => y >= b[0] && y < b[1];
  const row: Side | null = inBand(bands.you)
    ? "you"
    : inBand(bands.tgt)
      ? "tgt"
      : null;
  if (!row) return null;

  for (const it of layout.items) {
    const ch = row === "you" ? it.slot.actual : it.slot.ideal;
    if (!ch) continue;
    const gap = ch.leadGap;
    let bx: number;

    if (layout.view === "per-char") {
      bx = it.x! + it.gapW;
      const gw = row === "you" ? it.youGapW : it.tgtGapW;
      if (gap && contentX >= it.x! && contentX < it.x! + gw) {
        return { block: gap, char: ch, row, slot: it.slot };
      }
    } else {
      const start = row === "you" ? it.x : it.ix;
      // A slot with no character on this side has no x; comparing against null
      // would coerce to 0 and match everything to its left.
      if (start === null) continue;
      bx = start;
      const gw = gapWidth(gap, layout.ppu);
      if (gap && contentX >= bx - gw && contentX < bx) {
        return { block: gap, char: ch, row, slot: it.slot };
      }
    }

    for (const b of ch.blocks) {
      const w = b.units * layout.ppu;
      if (contentX >= bx && contentX < bx + w) {
        return { block: b, char: ch, row, slot: it.slot };
      }
      bx += w;
    }
  }
  return null;
}
