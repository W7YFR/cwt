/* Where everything goes, in content pixels. Pure geometry — no canvas.
 *
 * Two modes, deliberately different:
 *   per-char  every character pair starts at the same x, so element shape is
 *             readable. Accumulated drift is invisible here, which is exactly
 *             what the drift strip exists to show.
 *   absolute  one shared wall clock, so drift shears the tracks apart.
 *             `overlay` is the same axis with the tracks superimposed.
 *
 * Separated from the renderer because this is the half worth testing: zoom
 * anchoring, the piecewise time axis, and what a collapsed rest does to it are
 * all decided here, and none of them need a drawing context to check.
 */

import type { Block, Char, Review, Slot, ViewMode } from "@/types";
import { PAD_X, REST_W, SLOT_GAP } from "./geometry";

/** Breakpoints of a piecewise time->x map, as [seconds, contentX] pairs. */
export type AxisMap = Array<readonly [number, number]>;

export interface LayoutItem {
  slot: Slot;
  /** per-char: left edge of the slot, gap included. absolute: where the
   *  decoded character starts, or null if there isn't one. */
  x: number | null;
  /** absolute only: where the intended character starts. */
  ix: number | null;
  /** per-char only. */
  gapW: number;
  youGapW: number;
  tgtGapW: number;
  bodyW: number;
  w: number;
}

export interface Layout {
  view: ViewMode;
  items: LayoutItem[];
  /** Total content width, including both margins. */
  width: number;
  maps: { you: AxisMap; tgt: AxisMap };
  /** absolute only: the decode's t=0, pinned to its first keyed mark. */
  origin: number;
  /** absolute only: slot indices where a rest re-anchored the axis. */
  breaks: number[];
  ppu: number;
  unitSec: number;
}

/** Is this gap the sender resting rather than spacing?
 *
 * Reads `targetKind`, not `kind`: a long silence the intended text says is a
 * real word gap is being graded, so it must not be drawn or skipped as a rest. */
export function isRest(gap: Block | null | undefined): boolean {
  return !!gap && gap.targetKind === "pause";
}

/** Drawn width of a gap. Rests are clamped — see REST_W. */
export function gapWidth(gap: Block | null | undefined, ppu: number): number {
  if (!gap) return 0;
  const w = gap.units * ppu;
  return isRest(gap) ? Math.min(w, REST_W) : w;
}

/** Drawn width of a character: the sum of its own blocks. */
export function charWidth(ch: Char | null | undefined, ppu: number): number {
  if (!ch) return 0;
  let u = 0;
  for (const b of ch.blocks) u += b.units;
  return u * ppu;
}

export interface LayoutOptions {
  readonly view: ViewMode;
  readonly ppu: number;
  /** The recording's full length, so the axis can carry past the last mark. */
  readonly durationSec: number;
  /** Room to reserve before the first character, in seconds.
   *
   * For the pacing cursor's count-in, and nothing else. The axis stops at the
   * first character — `timeToX` clamps anything earlier to it — so without
   * this there is nowhere for a cursor to approach from, and a count-in you
   * cannot watch approach is not a count-in. Zero, and everything below is
   * exactly as it was. */
  readonly leadSec?: number;
}

/** Reserve `leadSec` of empty axis in front of everything.
 *
 * A post-pass rather than a branch inside the two builders: the change is the
 * same shift whichever way the chart is laid out, and threading it through
 * both would mean two chances to get it subtly different.
 *
 * The prepended breakpoint sits at the first one's *unshifted* x, which is
 * exactly `leadPx` to the left of where that point has moved to — so the
 * count-in runs at the same pixels-per-second as everything after it. A
 * count-in at some other tempo would be worse than none. */
function withLead(layout: Layout, leadSec: number): Layout {
  if (!(leadSec > 0)) return layout;
  const leadPx = (leadSec / layout.unitSec) * layout.ppu;
  const shift = (m: AxisMap): AxisMap => {
    const first = m[0];
    if (!first) return m;
    return [
      [first[0] - leadSec, first[1]],
      ...m.map(([t, x]) => [t, x + leadPx] as const),
    ];
  };
  return {
    ...layout,
    items: layout.items.map((it) => ({
      ...it,
      x: it.x === null ? null : it.x + leadPx,
      ix: it.ix === null ? null : it.ix + leadPx,
    })),
    maps: { you: shift(layout.maps.you), tgt: shift(layout.maps.tgt) },
    width: layout.width + leadPx,
  };
}

export function buildLayout(review: Review, options: LayoutOptions): Layout {
  const { view, ppu, durationSec } = options;
  const unitSec = review.ref.unitSec;
  const slots = review.slots;

  const items: LayoutItem[] = [];
  const maps: { you: AxisMap; tgt: AxisMap } = { you: [], tgt: [] };

  if (view === "per-char") {
    let x = PAD_X;
    for (const slot of slots) {
      const yg = gapWidth(slot.actual?.leadGap, ppu);
      const tg = gapWidth(slot.ideal?.leadGap, ppu);
      const gapW = Math.max(yg, tg);
      const bodyW = Math.max(charWidth(slot.actual, ppu), charWidth(slot.ideal, ppu));
      items.push({
        slot,
        x,
        ix: null,
        gapW,
        youGapW: yg,
        tgtGapW: tg,
        bodyW,
        w: gapW + bodyW,
      });

      // Time->x breakpoints, taken from the blocks as they are actually drawn.
      if (slot.actual) {
        let bx = x + gapW;
        if (slot.actual.leadGap) {
          maps.you.push([slot.actual.leadGap.t0, x], [slot.actual.leadGap.t1, x + yg]);
        }
        for (const b of slot.actual.blocks) {
          maps.you.push([b.t0, bx]);
          bx += b.units * ppu;
          maps.you.push([b.t1, bx]);
        }
      }
      if (slot.ideal) {
        let ix = x + gapW;
        if (slot.ideal.leadGap) {
          maps.tgt.push([slot.ideal.leadGap.t0, x], [slot.ideal.leadGap.t1, x + tg]);
        }
        for (const b of slot.ideal.blocks) {
          maps.tgt.push([b.t0, ix]);
          ix += b.units * ppu;
          maps.tgt.push([b.t1, ix]);
        }
      }
      x += gapW + bodyW + SLOT_GAP;
    }
    return withLead({
      view,
      items,
      width: x + PAD_X,
      maps,
      origin: 0,
      breaks: [],
      ppu,
      unitSec,
    }, options.leadSec ?? 0);
  }

  // Absolute time (and overlay, the same axis with the tracks superimposed):
  // pin the ideal's t=0 to the first keyed mark, so the two tracks share an
  // origin and every later divergence is real drift.
  const origin = review.actual.chars.length ? review.actual.chars[0]!.t0 : 0;
  const toX = (t: number, base: number) => PAD_X + ((t - base) / unitSec) * ppu;

  /* A collapsed rest re-anchors the axis: both tracks resume side by side
     after it, each shifted by its own amount. Shifting them equally would keep
     the drift reading but squash the target track into itself, since the
     silence it stands against is nothing like as long. Re-anchoring says what
     a rest actually means — you stopped, and what follows starts fresh — so
     drift is measured within a transmission rather than across a break. */
  let offYou = 0;
  let offTgt = 0;
  const breaks: number[] = [];
  let endYou = PAD_X;
  let endTgt = PAD_X;

  slots.forEach((slot, i) => {
    const lead = slot.actual?.leadGap ?? null;
    if (isRest(lead) && slot.actual) {
      const anchor = Math.max(endYou, endTgt) + REST_W;
      offYou = toX(slot.actual.t0, origin) - anchor;
      if (slot.ideal) offTgt = toX(slot.ideal.t0, 0) - anchor;
      breaks.push(i);
    }
    const x = slot.actual ? toX(slot.actual.t0, origin) - offYou : null;
    const ix = slot.ideal ? toX(slot.ideal.t0, 0) - offTgt : null;
    if (x !== null) endYou = x + charWidth(slot.actual, ppu);
    if (ix !== null) endTgt = ix + charWidth(slot.ideal, ppu);

    items.push({ slot, x, ix, gapW: 0, youGapW: 0, tgtGapW: 0, bodyW: 0, w: 0 });

    // Breakpoints per character, not just at the ends: with a rest folded out
    // the axis is piecewise, and the playhead and the ruler both read it here.
    if (slot.actual && x !== null) {
      if (lead) maps.you.push([lead.t0, x - gapWidth(lead, ppu)]);
      maps.you.push([slot.actual.t0, x], [slot.actual.t1, endYou]);
    }
    if (slot.ideal && ix !== null) {
      const ig = slot.ideal.leadGap;
      if (ig) maps.tgt.push([ig.t0, ix - gapWidth(ig, ppu)]);
      maps.tgt.push([slot.ideal.t0, ix], [slot.ideal.t1, endTgt]);
    }
  });

  if (!maps.you.length) maps.you.push([origin, PAD_X]);
  if (!maps.tgt.length) maps.tgt.push([0, PAD_X]);
  // Carry each axis out to the full duration at its final scale, so seeking
  // into the trailing silence still lands somewhere sensible.
  maps.you.push([durationSec, toX(durationSec, origin) - offYou]);
  maps.tgt.push([review.ideal.duration, toX(review.ideal.duration, 0) - offTgt]);

  const width =
    Math.max(
      toX(durationSec, origin) - offYou,
      toX(review.ideal.duration, 0) - offTgt,
    ) + PAD_X;

  return withLead(
    { view, items, width, maps, origin, breaks, ppu, unitSec },
    options.leadSec ?? 0,
  );
}

/** Content x for a moment on one track. The map is piecewise, so this
 *  interpolates between breakpoints rather than assuming a linear axis. */
export function timeToX(layout: Layout, t: number, side: "you" | "tgt"): number {
  const m = layout.maps[side];
  if (!m.length) return PAD_X;
  if (t <= m[0]![0]) return m[0]![1];
  for (let i = 1; i < m.length; i++) {
    const cur = m[i]!;
    const prev = m[i - 1]!;
    if (t <= cur[0]) {
      const span = cur[0] - prev[0];
      const f = span > 1e-12 ? (t - prev[0]) / span : 0;
      return prev[1] + f * (cur[1] - prev[1]);
    }
  }
  return m[m.length - 1]![1];
}

/** The inverse. Used for seeking and for anchoring a zoom on a moment. */
export function xToTime(layout: Layout, x: number, side: "you" | "tgt"): number {
  const m = layout.maps[side];
  if (!m.length) return 0;
  for (let i = 1; i < m.length; i++) {
    const cur = m[i]!;
    const prev = m[i - 1]!;
    if (x <= cur[1]) {
      const span = cur[1] - prev[1];
      const f = span > 1e-12 ? (x - prev[1]) / span : 0;
      return prev[0] + f * (cur[0] - prev[0]);
    }
  }
  return m[m.length - 1]![0];
}

/** The x-range one slot occupies on one track, in content pixels. Null when
 *  that side has no character in the slot (a missed or an extra one).
 *
 * `withLeadGap` because only the gaps *between* the characters of a range
 * belong to it: the leading character's own lead gap sits outside, and
 * including it made a letter-gap highlight read as gap-char-gap-char. The time
 * window playback uses starts at `Char.t0`, the first mark, so this is what
 * keeps the highlight and the audio agreeing. */
export function slotSpan(
  layout: Layout,
  side: "you" | "tgt",
  i: number,
  withLeadGap: boolean,
): [number, number] | null {
  const it = layout.items[i];
  if (!it) return null;
  const ch = side === "you" ? it.slot.actual : it.slot.ideal;
  if (!ch) return null;

  if (layout.view === "per-char") {
    // Both rows' gaps start at the slot's left edge, but the slot is as wide as
    // the longer of the two, so the shorter one starts further in.
    const gapW = !withLeadGap ? 0 : side === "you" ? it.youGapW : it.tgtGapW;
    const bx = it.x! + it.gapW;
    return [bx - gapW, bx + charWidth(ch, layout.ppu)];
  }

  const x = side === "you" ? it.x : it.ix;
  if (x === null) return null;
  return [
    x - (withLeadGap ? gapWidth(ch.leadGap, layout.ppu) : 0),
    x + charWidth(ch, layout.ppu),
  ];
}

/** The zoom at which the content just fills `trackW`, clamped to the slider.
 *
 * Measured rather than solved for: content width is not proportional to the
 * zoom, because the per-character view pads every slot by a fixed amount and a
 * collapsed rest is a fixed sliver whatever the scale. That fixed part means
 * the obvious guess — scale by how much room is left over — always undershoots,
 * so this converges from below without ever overshooting. A few passes and it
 * is inside a tenth of a pixel. */
export function fitZoom(
  review: Review,
  options: Omit<LayoutOptions, "ppu">,
  trackW: number,
  min: number,
  max: number,
): number {
  let ppu = min;
  for (let i = 0; i < 8; i++) {
    const layout = buildLayout(review, { ...options, ppu });
    if (!(layout.width > 0)) break;
    const next = Math.max(min, Math.min(max, (ppu * trackW) / layout.width));
    const settled = Math.abs(next - ppu) < 0.05;
    ppu = next;
    if (settled) break;
  }
  return Math.round(ppu * 10) / 10;
}
