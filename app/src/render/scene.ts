/* Drawing the review chart.
 *
 * Takes a fully-resolved scene and a 2D context, and owns no state of its own.
 * That is what lets the pure test tier drive it with a recording stub and
 * assert on the calls: a canvas test that needs a real GPU can only check that
 * nothing threw, which is not a useful thing to know about a chart.
 *
 * The context is typed as the subset actually used (`Ctx2D`) rather than as
 * CanvasRenderingContext2D, so the stub is a complete implementation rather
 * than a cast.
 */

import type { Analysis, Block, Char, Slot, ViewMode } from "@/types";
import {
  DRIFT_H,
  GRADE_H,
  GUTTER,
  HEIGHT,
  LABEL_H,
  MARK_H,
  OVER_H,
  OVER_MARK_H,
  PAD_R,
  PLOT_BOTTOM,
  RULER_H,
  ROW_H,
  SCROLL_H,
  Y_DRIFT,
  Y_GRADE,
  Y_LABEL,
  Y_RULER,
  Y_SCROLL,
  Y_TGT,
  Y_YOU,
} from "./geometry";
import { focusSpan, type Focus } from "./focus";
import { gapWidth, isRest, timeToX, type Layout } from "./layout";
import type { Palette } from "./theme";

/** Exactly the 2D context surface the renderer uses. */
export interface Ctx2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  translate(x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

export type Grade = "ok" | "warn" | "bad" | "none";

export const GRADE_MARK: Record<Grade, string> = {
  ok: "OK",
  warn: "~",
  bad: "**",
  none: "",
};

/** Grade a measured/target unit pair. Shared with the report table so the
 *  chart and the numbers below it never disagree about what counts as clean. */
export function gradeOf(units: number, target: number, tolerance: number): Grade {
  if (!(target > 0)) return "none";
  const rel = Math.abs(units - target) / target;
  if (rel <= tolerance) return "ok";
  return rel <= 2 * tolerance ? "warn" : "bad";
}

export interface Viewport {
  viewW: number;
  trackW: number;
  contentW: number;
  maxScroll: number;
}

export interface Scene {
  layout: Layout;
  slots: readonly Slot[];
  analysis: Analysis;
  palette: Palette;
  view: ViewMode;
  tolerance: number;
  scrollX: number;
  viewport: Viewport;
  durationSec: number;
  idealDuration: number;
  hover: Block | null;
  focus: Focus | null;
  playhead: { t: number; side: "you" | "tgt" } | null;
  /** Filled in by draw(), read by the gutter: the drift axis bound. */
  driftMax?: number;
}

function roundRect(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fmtU(u: number): string {
  return u.toFixed(u < 10 ? 1 : 0) + "u";
}

function visible(x: number, w: number, scene: Scene): boolean {
  return (
    x + w >= scene.scrollX - 40 && x <= scene.scrollX + scene.viewport.trackW + 40
  );
}

export function draw(ctx: Ctx2D, scene: Scene): void {
  const { palette: C, viewport: v } = scene;
  ctx.clearRect(0, 0, v.viewW, HEIGHT);

  drawFrame(ctx, scene);

  // Content is clipped to the right of the gutter, so scrolled blocks pass
  // behind the label band instead of over it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, 0, v.viewW - GUTTER, PLOT_BOTTOM);
  ctx.clip();
  ctx.translate(GUTTER - scene.scrollX, 0);
  ctx.font = `500 11px ${C.mono}`;

  drawTicks(ctx, scene);
  drawFocus(ctx, scene);
  if (scene.view === "per-char") drawPerChar(ctx, scene);
  else if (scene.view === "overlay") drawOverlay(ctx, scene);
  else drawAbsolute(ctx, scene);
  drawDrift(ctx, scene);

  ctx.restore();

  drawGutter(ctx, scene);
  drawScrollbar(ctx, scene);
  drawPlayhead(ctx, scene);
}

/** Structural rules, in screen coordinates so they span the visible track. */
function drawFrame(ctx: Ctx2D, scene: Scene): void {
  const right = scene.viewport.viewW - PAD_R;
  ctx.strokeStyle = scene.palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GUTTER, Y_RULER + RULER_H - 0.5);
  ctx.lineTo(right, Y_RULER + RULER_H - 0.5);
  ctx.moveTo(GUTTER, Y_DRIFT + DRIFT_H / 2 + 0.5);
  ctx.lineTo(right, Y_DRIFT + DRIFT_H / 2 + 0.5);
  ctx.stroke();
}

/** Second ticks. The per-character mapping is piecewise, so these go through
 *  timeToX rather than assuming a linear axis. */
function drawTicks(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  ctx.font = `10px ${C.mono}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  // Only label times the axis can actually place. Past the final keyed mark the
  // per-character map has no breakpoints left, so timeToX clamps — and every
  // remaining second would stack another wrong label on the right edge.
  let maxT = scene.durationSec;
  const mapYou = scene.layout.maps.you;
  if (scene.view === "per-char" && mapYou.length) {
    maxT = mapYou[mapYou.length - 1]![0];
  }

  let last = -1e9;
  for (let s = 0; s <= Math.floor(maxT); s++) {
    const x = timeToX(scene.layout, s, "you");
    if (!visible(x, 1, scene)) continue;
    if (x - last < 34) continue; // don't crowd the labels
    last = x;
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, Y_RULER + 4);
    ctx.lineTo(x + 0.5, Y_RULER + RULER_H);
    ctx.stroke();
    ctx.fillStyle = C["ink-faint"];
    ctx.fillText(`${s}s`, x + 4, Y_RULER + 8);
  }
}

/** Wash the focused stretch, behind the marks so it reads as a spotlight rather
 *  than a veil. In overlay both tracks share one band; otherwise only the row
 *  the hovered button would play is lit, which is what distinguishes hovering
 *  "yours" from hovering "target". */
function drawFocus(ctx: Ctx2D, scene: Scene): void {
  const span = focusSpan(scene.layout, scene.slots, scene.focus);
  if (!span || !scene.focus) return;
  const pad = 4;
  const x = span[0] - pad;
  const w = span[1] - span[0] + 2 * pad;
  if (!visible(x, w, scene)) return;

  let top: number;
  let h: number;
  if (scene.view === "overlay") {
    top = Y_LABEL;
    h = Y_YOU + OVER_H + 4 - Y_LABEL;
  } else if (scene.focus.side === "you") {
    top = Y_LABEL;
    h = Y_YOU + ROW_H + 2 - Y_LABEL;
  } else {
    top = Y_TGT - 2;
    h = ROW_H + 4;
  }

  const color = scene.focus.side === "you" ? scene.palette.you : scene.palette.tgt;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.14;
  roundRect(ctx, x, top, w, h, 4);
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, top + 0.5, w - 1, h - 1, 4);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** One slot: the lead gap, then the character's marks, on both tracks. */
function drawPerChar(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  for (const it of scene.layout.items) {
    if (it.x === null || !visible(it.x, it.w, scene)) continue;
    const slot = it.slot;

    // Caption: the decoded character, plus what it should have been.
    let cap = slot.actual ? slot.actual.char : "·";
    let capColor = C.ink;
    if (slot.op === "sub" && slot.actual && slot.ideal) {
      cap = `${slot.actual.char}→${slot.ideal.char}`;
      capColor = C.bad;
    } else if (slot.op === "del" && slot.ideal) {
      cap = `–${slot.ideal.char}`;
      capColor = C.bad;
    } else if (slot.op === "ins" && slot.actual) {
      cap = `+${slot.actual.char}`;
      capColor = C.bad;
    }
    ctx.fillStyle = capColor;
    ctx.font = `600 12px ${C.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cap, it.x + it.gapW + it.bodyW / 2, Y_LABEL + LABEL_H / 2);

    // A word-boundary error is called out above the gap that caused it.
    if (slot.spaceOp === "del" || slot.spaceOp === "ins") {
      ctx.fillStyle = C.bad;
      ctx.font = `600 9px ${C.mono}`;
      ctx.fillText(
        slot.spaceOp === "del" ? "no space" : "extra space",
        it.x + it.gapW / 2,
        Y_LABEL + 5,
      );
    }

    const bx = it.x + it.gapW;

    // Where the character starts. Both rows' gaps begin at the slot's left
    // edge, but the slot is as wide as the LONGER of the two, so the shorter
    // gap's bracket stops short of this line. Without the line that shortfall
    // reads as a rendering gap instead of the measurement it is.
    if (it.gapW > 0 && Math.abs(it.youGapW - it.tgtGapW) > 1.5) {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 0.5, Y_YOU + 2);
      ctx.lineTo(bx - 0.5, Y_TGT + ROW_H - 2);
      ctx.stroke();
    }

    drawGap(ctx, scene, slot.actual?.leadGap ?? null, it.x, it.youGapW, Y_YOU, false);
    drawGap(ctx, scene, slot.ideal?.leadGap ?? null, it.x, it.tgtGapW, Y_TGT, true);

    // A side with no character gets an outlined ghost, so a missed or an extra
    // character reads as a hole rather than as a shifted neighbor.
    if (slot.actual) drawMarks(ctx, scene, slot.actual, bx, Y_YOU, false);
    else drawGhost(ctx, scene, bx, it.bodyW, Y_YOU);
    if (slot.ideal) drawMarks(ctx, scene, slot.ideal, bx, Y_TGT, true);
    else drawGhost(ctx, scene, bx, it.bodyW, Y_TGT);

    drawGradeStrip(ctx, scene, slot, bx, it.bodyW);
  }
}

function drawAbsolute(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  const u = scene.layout.unitSec;
  const ppu = scene.layout.ppu;

  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (slot.actual && it.x !== null) {
      const w = ((slot.actual.t1 - slot.actual.t0) / u) * ppu;
      if (visible(it.x, w, scene)) {
        const g = slot.actual.leadGap;
        const gw = gapWidth(g, ppu);
        if (g) drawGap(ctx, scene, g, it.x - gw, gw, Y_YOU, false);
        drawMarks(ctx, scene, slot.actual, it.x, Y_YOU, false);
        ctx.fillStyle = slot.op === "equal" ? C["ink-dim"] : C.bad;
        ctx.font = `600 11px ${C.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(slot.actual.char, it.x + w / 2, Y_LABEL + LABEL_H / 2);
      }
    }
    if (slot.ideal && it.ix !== null) {
      const iw = ((slot.ideal.t1 - slot.ideal.t0) / u) * ppu;
      if (visible(it.ix, iw, scene)) {
        const ig = slot.ideal.leadGap;
        const igw = gapWidth(ig, ppu);
        if (ig) drawGap(ctx, scene, ig, it.ix - igw, igw, Y_TGT, true);
        drawMarks(ctx, scene, slot.ideal, it.ix, Y_TGT, true);
      }
    }
  }
}

/** Overlay: both tracks superimposed on one absolute-time axis, each
 *  translucent, so alignment reads as a blend and divergence as a colored
 *  fringe. This is the view that shows drift directly — no drift plot needed to
 *  infer it. */
function drawOverlay(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  const u = scene.layout.unitSec;
  const ppu = scene.layout.ppu;
  const y = Y_YOU + (OVER_H - OVER_MARK_H) / 2;

  const band = (ch: Char, x: number, color: string, alpha: number) => {
    let bx = x;
    for (const b of ch.blocks) {
      const w = b.units * ppu;
      if (b.kind !== "element-gap") {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        roundRect(ctx, bx, y, Math.max(w, 2), OVER_MARK_H, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      bx += w;
    }
  };

  // Target underneath, yours on top: where they coincide you see the mix, where
  // they don't you see one color alone.
  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (slot.ideal && it.ix !== null) {
      const iw = ((slot.ideal.t1 - slot.ideal.t0) / u) * ppu;
      if (visible(it.ix, iw, scene)) band(slot.ideal, it.ix, C.tgt, 0.55);
    }
  }
  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (!slot.actual || it.x === null) continue;
    const w = ((slot.actual.t1 - slot.actual.t0) / u) * ppu;
    if (!visible(it.x, w, scene)) continue;
    band(slot.actual, it.x, slot.op === "equal" ? C.you : C.bad, 0.55);
    ctx.fillStyle = slot.op === "equal" ? C["ink-dim"] : C.bad;
    ctx.font = `600 11px ${C.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(slot.actual.char, it.x + w / 2, Y_LABEL + LABEL_H / 2);
  }

  // A leader from each character to where the target put it, so the amount of
  // slip is readable as a length rather than guessed from the fringe.
  ctx.strokeStyle = C["ink-faint"];
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (!slot.actual || !slot.ideal || it.x === null || it.ix === null) continue;
    if (Math.abs(it.x - it.ix) < 2) continue;
    if (!visible(Math.min(it.x, it.ix), Math.abs(it.x - it.ix), scene)) continue;
    const ly = Y_YOU + OVER_H - 4;
    ctx.beginPath();
    ctx.moveTo(it.ix, ly);
    ctx.lineTo(it.x, ly);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawGap(
  ctx: Ctx2D,
  scene: Scene,
  gap: Block | null,
  x: number,
  w: number,
  yTop: number,
  isTarget: boolean,
): void {
  if (!gap || w <= 0) return;
  const C = scene.palette;
  const y = yTop + (ROW_H - MARK_H) / 2;
  const grade = isTarget ? "none" : gradeOf(gap.units, gap.targetUnits, scene.tolerance);
  const rest = isRest(gap);
  const color = rest
    ? C.rest
    : isTarget
      ? C.tgt
      : grade === "warn"
        ? C.warn
        : grade === "bad"
          ? C.bad
          : C.you;

  // The gap is drawn as a bracketed void — it is absence of tone, and shading
  // it like a mark would read as keying.
  ctx.strokeStyle = color;
  ctx.globalAlpha = rest ? 0.9 : 0.8;
  ctx.lineWidth = 1;
  const mid = y + MARK_H / 2;
  ctx.beginPath();
  ctx.moveTo(x + 1, mid - 4);
  ctx.lineTo(x + 1, mid + 4);
  ctx.moveTo(x + w - 1, mid - 4);
  ctx.lineTo(x + w - 1, mid + 4);
  if (rest) {
    /* A wave, not a rule: a rest is drawn at a fixed width regardless of how
       long it really was, and a straight spine would claim a length it is not
       keeping. The squiggle is the standard "not to scale" mark, and the label
       carries the real figure. */
    for (let wx = x + 1; wx <= x + w - 1; wx += 2) {
      const wy = mid + Math.sin((wx - x) / 3.2) * 2.5;
      if (wx === x + 1) ctx.moveTo(wx, wy);
      else ctx.lineTo(wx, wy);
    }
  } else {
    ctx.moveTo(x + 1, mid);
    ctx.lineTo(x + w - 1, mid);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Label char/word gaps and rests; element gaps are self-evident.
  if (gap.kind === "element-gap" || w < 22) return;
  const label = rest ? `Rest ${gap.units.toFixed(0)}u` : fmtU(gap.units);
  ctx.font = `${rest ? "600 10px" : "10px"} ${C.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width + 6;
  ctx.fillStyle = C.panel;
  ctx.fillRect(x + w / 2 - tw / 2, mid - 6, tw, 12);
  ctx.fillStyle = color;
  ctx.fillText(label, x + w / 2, mid);
}

function drawMarks(
  ctx: Ctx2D,
  scene: Scene,
  ch: Char,
  x0: number,
  yTop: number,
  isTarget: boolean,
): void {
  const C = scene.palette;
  const y = yTop + (ROW_H - MARK_H) / 2;
  let x = x0;
  for (const b of ch.blocks) {
    const w = b.units * scene.layout.ppu;
    if (b.kind === "element-gap") {
      // A faint baseline keeps intra-character spacing visible without
      // competing with the marks.
      ctx.strokeStyle = isTarget ? C.tgt : C["ink-faint"];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + MARK_H - 0.5);
      ctx.lineTo(x + w, y + MARK_H - 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      const grade = isTarget
        ? "none"
        : gradeOf(b.units, b.targetUnits, scene.tolerance);
      ctx.fillStyle = isTarget
        ? C.tgt
        : grade === "warn"
          ? C.warn
          : grade === "bad"
            ? C.bad
            : C.you;
      ctx.globalAlpha = isTarget ? 0.55 : 1;
      roundRect(ctx, x, y, Math.max(w, 2), MARK_H, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (scene.hover === b) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x + 0.5, y + 0.5, Math.max(w, 2) - 1, MARK_H - 1, 3);
        ctx.stroke();
      }
    }
    x += w;
  }
}

function drawGhost(
  ctx: Ctx2D,
  scene: Scene,
  x: number,
  w: number,
  yTop: number,
): void {
  const y = yTop + (ROW_H - MARK_H) / 2;
  ctx.strokeStyle = scene.palette.ghost;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(w, 2) - 1, MARK_H - 1, 3);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The per-character verdict: the worst grade among its own blocks. */
function drawGradeStrip(
  ctx: Ctx2D,
  scene: Scene,
  slot: Slot,
  x: number,
  w: number,
): void {
  if (!slot.actual || !slot.ideal) return; // nothing to compare
  // Never "none": this only runs when both sides have a character, and every
  // block of a real character carries a target.
  let worst: "ok" | "warn" | "bad" = "ok";
  const blocks = [...slot.actual.blocks];
  if (slot.actual.leadGap) blocks.push(slot.actual.leadGap);
  for (const b of blocks) {
    const g = gradeOf(b.units, b.targetUnits, scene.tolerance);
    if (g === "bad") worst = "bad";
    else if (g === "warn" && worst !== "bad") worst = "warn";
  }
  ctx.fillStyle = scene.palette[worst];
  ctx.font = `600 9px ${scene.palette.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(GRADE_MARK[worst], x + w / 2, Y_GRADE + GRADE_H / 2);
}

/** Cumulative timing drift: how far behind or ahead of the ideal clock you have
 *  fallen. This is the information the per-character view necessarily hides.
 *
 * Measured against a reference that restarts after every rest, because a rest
 * is the sender stopping: the silence is not drift, and whatever follows begins
 * in step again. Without the restart one long rest dwarfs the axis — a 200-unit
 * stop reads as ±580u of "drift" and flattens every real deviation into the
 * center line. The runs are drawn separately so the plot shows a break rather
 * than a cliff between them. */
function drawDrift(ctx: Ctx2D, scene: Scene): void {
  const u = scene.layout.unitSec;
  const runs: Array<Array<[number, number]>> = [];
  let pts: Array<[number, number]> | null = null;
  let base: number | null = null;

  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (!slot.actual || !slot.ideal) continue;
    if (base === null || isRest(slot.actual.leadGap)) {
      base = slot.actual.t0 - slot.ideal.t0;
      pts = [];
      runs.push(pts);
    }
    const drift = (slot.actual.t1 - base - slot.ideal.t1) / u;
    const x =
      scene.view === "per-char"
        ? it.x! + it.gapW + it.bodyW / 2
        : it.x! + (((slot.actual.t1 - slot.actual.t0) / u) * scene.layout.ppu) / 2;
    pts!.push([x, drift]);
  }

  let driftMax = 1;
  for (const run of runs) {
    for (const p of run) driftMax = Math.max(driftMax, Math.abs(p[1]));
  }
  scene.driftMax = driftMax;

  const half = DRIFT_H / 2 - 8;
  const mid = Y_DRIFT + DRIFT_H / 2;
  ctx.strokeStyle = scene.palette.you;
  ctx.lineWidth = 1.5;
  for (const run of runs) {
    if (run.length < 2) continue;
    ctx.beginPath();
    run.forEach((p, i) => {
      const y = mid - (p[1] / driftMax) * half;
      if (i === 0) ctx.moveTo(p[0], y);
      else ctx.lineTo(p[0], y);
    });
    ctx.stroke();
  }
}

/** The left band: track names and the drift axis bound. Drawn after the content
 *  and outside its clip, so nothing can slide underneath. */
function drawGutter(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, GUTTER, HEIGHT);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GUTTER - 0.5, RULER_H);
  ctx.lineTo(GUTTER - 0.5, PLOT_BOTTOM);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 10px ${C.mono}`;

  // In overlay the tracks share one band, so the two names stack as a color key
  // inside it rather than labeling separate rows.
  const rows: Array<[number, string, string]> =
    scene.view === "overlay"
      ? [
          [Y_YOU + OVER_H / 2 - 9, "YOU", C.you],
          [Y_YOU + OVER_H / 2 + 9, "TGT", C.tgt],
          [Y_DRIFT + 7, "DRIFT", C["ink-dim"]],
        ]
      : [
          [Y_YOU + ROW_H / 2, "YOU", C.you],
          [Y_TGT + ROW_H / 2, "TGT", C.tgt],
          [Y_DRIFT + 7, "DRIFT", C["ink-dim"]],
        ];
  for (const [y, label, color] of rows) {
    ctx.fillStyle = color;
    ctx.fillText(label, 4, y);
  }

  // The axis bound goes on its own line below the label rather than at the
  // gridlines: 44px cannot fit a number beside "DRIFT" without colliding, and
  // the zero rule already shows where the middle is. Up is ahead of the ideal
  // clock, down is behind. The decimal is dropped once the figure is wide, so
  // the label cannot spill past the gutter at extreme drift.
  const driftMax = scene.driftMax ?? 1;
  ctx.font = `9px ${C.mono}`;
  ctx.fillStyle = C["ink-faint"];
  ctx.fillText(
    `±${driftMax.toFixed(driftMax < 10 ? 1 : 0)}u`,
    4,
    Y_DRIFT + 20,
  );
}

/** Thumb geometry for the canvas-drawn scrollbar, also used for hit testing. */
export function scrollbarThumb(
  scrollX: number,
  v: Viewport,
): { x: number; w: number; trackX: number; trackW: number } | null {
  if (!v.maxScroll) return null;
  const w = Math.max(v.trackW * (v.trackW / v.contentW), 28);
  const x = GUTTER + (scrollX / v.maxScroll) * (v.trackW - w);
  return { x, w, trackX: GUTTER, trackW: v.trackW };
}

/** Drawn rather than native, so it matches the panel instead of the OS. */
function drawScrollbar(ctx: Ctx2D, scene: Scene): void {
  const th = scrollbarThumb(scene.scrollX, scene.viewport);
  if (!th) return;
  const y = Y_SCROLL + 4;
  ctx.fillStyle = scene.palette.line;
  ctx.globalAlpha = 0.5;
  roundRect(ctx, th.trackX, y, th.trackW, 5, 2.5);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = scene.palette["ink-faint"];
  roundRect(ctx, th.x, y - 0.5, th.w, 6, 3);
  ctx.fill();
}

function drawPlayhead(ctx: Ctx2D, scene: Scene): void {
  if (!scene.playhead) return;
  const x =
    GUTTER + timeToX(scene.layout, scene.playhead.t, scene.playhead.side) - scene.scrollX;
  if (x < GUTTER || x > scene.viewport.viewW - PAD_R) return;

  // In overlay both tracks share one band, so the playhead spans all of it.
  const y0 =
    scene.view === "overlay" ? Y_YOU : scene.playhead.side === "you" ? Y_YOU : Y_TGT;
  const h = scene.view === "overlay" ? OVER_H : ROW_H;
  ctx.strokeStyle = scene.playhead.side === "you" ? scene.palette.you : scene.palette.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y0 - 4);
  ctx.lineTo(x, y0 + h + 2);
  ctx.stroke();
}

/** The y-bands the two tracks occupy, for hit testing. */
export function trackBands(view: ViewMode): {
  you: [number, number];
  tgt: [number, number];
} {
  if (view === "overlay") {
    // Split the shared band: the upper half picks yours, the lower the target.
    return {
      you: [Y_YOU, Y_YOU + OVER_H / 2],
      tgt: [Y_YOU + OVER_H / 2, Y_YOU + OVER_H],
    };
  }
  return {
    you: [Y_YOU, Y_YOU + ROW_H],
    tgt: [Y_TGT, Y_TGT + ROW_H],
  };
}

export { HEIGHT, GUTTER, PAD_R, RULER_H, Y_SCROLL, SCROLL_H };
