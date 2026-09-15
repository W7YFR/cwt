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
  MARKER_W,
  PLAYHEAD_W,
  OVER_H,
  OVER_MARK_H,
  PAD_R,
  RULER_H,
  ROW_H,
  SCROLL_H,
  Y_RULER,
  Y_SCROLL,
  rowsFor,
  type Rows,
} from "./geometry";
import {
  ACCURATE_BANDS,
  CONSISTENT_BANDS,
  scoreBand,
  subLabel,
} from "@/timing";
import { focusSpan, type Focus } from "./focus";
import {
  gapWidth,
  isRest,
  timeToX,
  type ColumnMetrics,
  type Layout,
} from "./layout";
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

/** One attempt, and everything drawing its row needs.
 *
 * Every lane is paired against the same target, so they share a column axis
 * and can be read down a column as well as along a row. */
export interface Lane {
  layout: Layout;
  slots: readonly Slot[];
  analysis: Analysis;
  /** Which attempt this is, counted in the order they were recorded.
   *
   * Carried on the lane rather than taken from its position, because the rows
   * can be sorted. The third attempt is RUN 3 wherever it lands — renumbering
   * by position would have the row you were reading take another attempt's
   * name, and the Drop button offer to throw away a recording it did not
   * name. */
  ordinal: number;
  /** How well this attempt was decoded against the target, or null when there
   *  is no intended message — grading a decode against itself is a meaningless
   *  100%, which is why the band under the chart drops the figure too. */
  accuracy: number | null;
  /** Nothing was recorded into this one, so its row is ghosts and none of
   *  them is a mistake. */
  blank?: boolean;
}

export interface Scene {
  /** The attempts on screen, in the order they are drawn. */
  runs: readonly Lane[];
  /** Which of them is being read in detail: the one with a caption band, and
   *  the one the report below the chart is about. */
  selected: number;
  /** The run whose name in the gutter the pointer is over, if any. Lights it,
   *  because a word you can click has to look different from a word you
   *  cannot. */
  picking?: number;
  /** The shared per-character column axis. Absent in the time views, which
   *  need no columns — there the axis is the clock. */
  columns?: ColumnMetrics;
  /** Draw each character as a fixed-width marker at the moment it starts,
   *  rather than as its own dits and dahs. See `drawCharMarker`. */
  charMarkers?: boolean;
  /** Count-in reserved in front of the first character, in seconds. Absent or
   *  zero outside a paced recording — see `LayoutOptions.leadSec`. */
  leadSec?: number;
  layout: Layout;
  slots: readonly Slot[];
  analysis: Analysis;
  /** Where the rows sit, for however many attempts are on screen.
   *
   * Carried on the scene rather than read from constants because the chart is
   * a different height with four attempts stacked on it than with one. With
   * one it is exactly the height it always was — see `rowsFor`. */
  rows: Rows;
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
  ctx.clearRect(0, 0, v.viewW, scene.rows.height);

  drawFrame(ctx, scene);

  // Content is clipped to the right of the gutter, so scrolled blocks pass
  // behind the label band instead of over it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, 0, v.viewW - GUTTER, scene.rows.plotBottom);
  ctx.clip();
  ctx.translate(GUTTER - scene.scrollX, 0);
  ctx.font = `500 11px ${C.mono}`;

  drawTicks(ctx, scene);
  drawFocus(ctx, scene);
  if (scene.view === "per-char") drawPerChar(ctx, scene);
  else if (scene.view === "overlay") drawOverlay(ctx, scene);
  else drawAbsolute(ctx, scene);
  drawLead(ctx, scene);
  drawDrift(ctx, scene);

  ctx.restore();

  drawGutter(ctx, scene);
  drawScrollbar(ctx, scene);
  drawPlayhead(ctx, scene);
  drawCountIn(ctx, scene);
}

/** Structural rules, in screen coordinates so they span the visible track. */
function drawFrame(ctx: Ctx2D, scene: Scene): void {
  const right = scene.viewport.viewW - PAD_R;
  ctx.strokeStyle = scene.palette.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GUTTER, Y_RULER + RULER_H - 0.5);
  ctx.lineTo(right, Y_RULER + RULER_H - 0.5);
  ctx.moveTo(GUTTER, scene.rows.drift + DRIFT_H / 2 + 0.5);
  ctx.lineTo(right, scene.rows.drift + DRIFT_H / 2 + 0.5);
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
  /* A row and its own caption, and nothing else. Each track now carries its
     text on the outside — the target's above it, yours below — so lighting a
     row means lighting the band from its caption through its marks. */
  const lit = scene.rows.runs[scene.focus.run ?? scene.selected] ?? scene.rows.runs[0]!;
  if (scene.view === "overlay") {
    top = scene.rows.tgtLabel;
    h = (lit.label ?? lit.row + ROW_H) + LABEL_H - scene.rows.tgtLabel;
  } else if (scene.focus.side === "you") {
    top = lit.row - 2;
    // A row without a caption band of its own is lit to its own bottom edge
    // rather than into the row below it.
    h = ROW_H + (lit.label === null ? 2 : LABEL_H + 2);
  } else {
    top = scene.rows.tgtLabel;
    h = LABEL_H + ROW_H + 2;
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

/** What to write under your row for one slot.
 *
 * One function, used by all three views. It was per-view once and only the
 * per-character view ever gained the annotations, so a substitution was
 * spelled out on one axis and shown as a bare red character on another —
 * which looks like the chart having lost track of what you meant rather than
 * like two views disagreeing about how much to say. */
function sentCaption(slot: Slot, blank: boolean): { text: string; bad: boolean } {
  /* With nothing recorded, every slot is a "deletion" — the target has a
     character and your side does not — and marking them all as missed would
     be an accusation about sending that has not happened yet. The row is
     ghosts, and ghosts need no caption. */
  if (blank) return { text: "", bad: false };
  if (slot.op === "sub" && slot.actual && slot.ideal) {
    // Intended first, then what came out — the same order the accuracy panel
    // uses, and the same order the two rows are stacked in.
    return { text: subLabel(slot.ideal.char, slot.actual.char), bad: true };
  }
  if (slot.op === "del" && slot.ideal) return { text: `–${slot.ideal.char}`, bad: true };
  if (slot.op === "ins" && slot.actual) return { text: `+${slot.actual.char}`, bad: true };
  return { text: slot.actual ? slot.actual.char : "·", bad: false };
}

/** The per-character view: the target once, then every attempt at it.
 *
 * Split that way because the two halves answer to different things. The target
 * belongs to the COLUMN — it is the same on every row and it is what the
 * columns are keyed to — while what was sent belongs to a run. Drawing the
 * target from whichever run happened to be selected would leave a column the
 * selected run has nothing in saying nothing about what was asked for there.
 */
function drawTargetRow(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  const cols = scene.columns;
  if (!cols) return;
  const bottom = scene.rows.runs[scene.rows.runs.length - 1]!;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let c = 0; c < cols.x.length; c++) {
    const x = cols.x[c]!;
    const gapW = cols.gapW[c]!;
    const bodyW = cols.bodyW[c]!;
    if (!visible(x, gapW + bodyW, scene)) continue;
    const ideal = cols.ideal[c] ?? null;
    const bx = x + gapW;

    /* The message you meant to send, and nothing else. It is the reference, so
       it is never marked up — a character cannot be wrong in the text that
       defines what right is. Where some run sent something that was not asked
       for there is no intended character at all, and the blank says so. */
    ctx.fillStyle = C.ink;
    ctx.font = `600 12px ${C.mono}`;
    ctx.fillText(ideal ? ideal.char : "·", bx + bodyW / 2, scene.rows.tgtLabel + LABEL_H / 2);

    // Where the character starts, when the gaps arriving here disagree about
    // it. Drawn once, down the whole stack: it is a fact about the column.
    if (cols.ragged[c]) {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 0.5, scene.rows.tgt + 2);
      ctx.lineTo(bx - 0.5, bottom.row + ROW_H - 2);
      ctx.stroke();
    }

    drawGap(ctx, scene, ideal?.leadGap ?? null, x, gapWidth(ideal?.leadGap, scene.layout.ppu), scene.rows.tgt, true);
    if (ideal) drawMarks(ctx, scene, ideal, bx, scene.rows.tgt, true);
    else drawGhost(ctx, scene, bx, bodyW, scene.rows.tgt);
  }
}

/** One attempt's row: its lead gaps, its marks, its grade, and — if it is the
 *  one being read — what it decoded to. */
function drawRunRow(ctx: Ctx2D, scene: Scene, r: number): void {
  const C = scene.palette;
  const lane = scene.runs[r]!;
  const row = scene.rows.runs[r]!;
  const blank = lane.blank === true;

  for (const it of lane.layout.items) {
    if (it.x === null || !visible(it.x, it.w, scene)) continue;
    const slot = it.slot;
    const bx = it.x + it.gapW;
    const mid = bx + it.bodyW / 2;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    /* What came out, and how it differs from the target above.
     *
     * All of it suppressed when nothing has been recorded. Against an empty
     * decode the alignment quite correctly calls every character a deletion
     * and every word boundary a missing space — and drawing that reads as a
     * page of faults in sending that has not happened yet. */
    if (row.label !== null) {
      const cap = sentCaption(slot, blank);
      ctx.fillStyle = cap.bad ? C.bad : C.ink;
      ctx.font = `600 12px ${C.mono}`;
      ctx.fillText(cap.text, mid, row.label + LABEL_H / 2);

      // A word-boundary error is a fault in what was sent, so it is called out
      // beside that row's caption, over the gap that caused it.
      if (!blank && (slot.spaceOp === "del" || slot.spaceOp === "ins")) {
        ctx.fillStyle = C.bad;
        ctx.font = `600 9px ${C.mono}`;
        ctx.fillText(
          slot.spaceOp === "del" ? "no space" : "extra space",
          it.x + it.gapW / 2,
          row.label + LABEL_H - 5,
        );
      }
    }

    drawGap(ctx, scene, slot.actual?.leadGap ?? null, it.x, it.youGapW, row.row, false);

    // A side with no character gets an outlined ghost, so a missed or an extra
    // character reads as a hole rather than as a shifted neighbor.
    if (slot.actual) drawMarks(ctx, scene, slot.actual, bx, row.row, false);
    else drawGhost(ctx, scene, bx, it.bodyW, row.row);

    drawGradeStrip(ctx, scene, slot, bx, it.bodyW, row.grade);
  }
}

function drawPerChar(ctx: Ctx2D, scene: Scene): void {
  drawTargetRow(ctx, scene);
  for (let r = 0; r < scene.runs.length; r++) drawRunRow(ctx, scene, r);
}

function drawAbsolute(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;

  /* The target once, on its own row. Read off the run being read, since every
     attempt in a session is paired against the same target and places it at
     the same time — so any of them would say the same thing. */
  const ref = scene.runs[scene.selected] ?? scene.runs[0];
  if (ref) {
    const u = ref.layout.unitSec;
    const ppu = ref.layout.ppu;
    for (const it of ref.layout.items) {
      const slot = it.slot;
      if (!slot.ideal || it.ix === null) continue;
      const iw = ((slot.ideal.t1 - slot.ideal.t0) / u) * ppu;
      const ig = slot.ideal.leadGap;
      const igw = gapWidth(ig, ppu);
      if (!visible(it.ix - igw, igw + iw, scene)) continue;
      if (ig) drawGap(ctx, scene, ig, it.ix - igw, igw, scene.rows.tgt, true);
      drawMarks(ctx, scene, slot.ideal, it.ix, scene.rows.tgt, true);
      /* Labeled too, on this axis. The target row used to go unnamed here
         because there was one caption band and it belonged to the decode —
         but on a wall clock the two rows' characters sit at different x, and
         that offset IS the drift. Naming both is what makes it readable. */
      ctx.fillStyle = C["ink-dim"];
      ctx.font = `600 11px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(slot.ideal.char, it.ix + iw / 2, scene.rows.tgtLabel + LABEL_H / 2);
    }
  }

  /* Culled over the gap as well as the character.
   *
   * On this axis a gap is drawn to the LEFT of the character it leads into, so
   * a character just off the right edge can have a gap reaching a long way
   * back into view. Testing the character alone dropped that whole line until
   * the character itself was nearly on screen, and then it appeared all at
   * once — so the chart looked like it simply stopped, and the connection to
   * what came next snapped into existence out of nowhere. The span that gets
   * drawn is the span that decides. */
  scene.runs.forEach((lane, r) => {
    const row = scene.rows.runs[r];
    if (!row) return;
    const u = lane.layout.unitSec;
    const ppu = lane.layout.ppu;
    const blank = lane.blank === true;

    for (const it of lane.layout.items) {
      const slot = it.slot;
      if (!slot.actual || it.x === null) continue;
      const w = ((slot.actual.t1 - slot.actual.t0) / u) * ppu;
      const g = slot.actual.leadGap;
      const gw = gapWidth(g, ppu);
      if (!visible(it.x - gw, gw + w, scene)) continue;

      if (g) drawGap(ctx, scene, g, it.x - gw, gw, row.row, false);
      drawMarks(ctx, scene, slot.actual, it.x, row.row, false);

      // Only the attempt being read carries text; the others have no band to
      // put it in, and writing it anyway would land it on somebody else's row.
      if (row.label === null) continue;
      const cap = sentCaption(slot, blank);
      ctx.fillStyle = cap.bad ? C.bad : C["ink-dim"];
      ctx.font = `600 11px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cap.text, it.x + w / 2, row.label + LABEL_H / 2);
    }
  });
}

/** Overlay: both tracks superimposed on one absolute-time axis, each
 *  translucent, so alignment reads as a blend and divergence as a colored
 *  fringe. This is the view that shows drift directly — no drift plot needed to
 *  infer it. */
function drawOverlay(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  const u = scene.layout.unitSec;
  const ppu = scene.layout.ppu;
  const y = scene.rows.tgt + (OVER_H - OVER_MARK_H) / 2;

  const band = (ch: Char, x: number, color: string, alpha: number) => {
    const paint = (bx: number, w: number) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      roundRect(ctx, bx, y, Math.max(w, 2), OVER_MARK_H, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (scene.charMarkers) {
      // One tick for the character here too — the setting is about what a
      // block on the chart means, not about which axis it is drawn on.
      paint(x, MARKER_W);
      return;
    }
    let bx = x;
    for (const b of ch.blocks) {
      const w = b.units * ppu;
      if (b.kind !== "element-gap") paint(bx, w);
      bx += w;
    }
  };

  // Target underneath, yours on top: where they coincide you see the mix, where
  // they don't you see one color alone.
  for (const it of scene.layout.items) {
    const slot = it.slot;
    if (slot.ideal && it.ix !== null) {
      const iw = ((slot.ideal.t1 - slot.ideal.t0) / u) * ppu;
      if (visible(it.ix, iw, scene)) {
        band(slot.ideal, it.ix, C.tgt, 0.55);
        ctx.fillStyle = C["ink-dim"];
        ctx.font = `600 11px ${C.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(slot.ideal.char, it.ix + iw / 2, scene.rows.tgtLabel + LABEL_H / 2);
      }
    }
  }
  /* Every attempt in the one band — superimposing them is what this view is.
     Only the one being read is captioned: there is a single band of text here
     and four runs' worth of characters written into it would be unreadable. */
  const capY = scene.rows.runs[scene.selected]?.label;
  scene.runs.forEach((lane, r) => {
    for (const it of lane.layout.items) {
      const slot = it.slot;
      if (!slot.actual || it.x === null) continue;
      const w = ((slot.actual.t1 - slot.actual.t0) / u) * ppu;
      if (!visible(it.x, w, scene)) continue;
      band(slot.actual, it.x, slot.op === "equal" ? C.you : C.bad, 0.55);
      if (r !== scene.selected || capY === null || capY === undefined) continue;
      const cap = sentCaption(slot, lane.blank === true);
      ctx.fillStyle = cap.bad ? C.bad : C["ink-dim"];
      ctx.font = `600 11px ${C.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cap.text, it.x + w / 2, capY + LABEL_H / 2);
    }
  });

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
    const ly = scene.rows.tgt + OVER_H - 4;
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

/** Where the count-in runs from and to, in content coordinates.
 *
 * The layout reserved it by prepending one breakpoint to each axis map, so the
 * span is simply the first two — no second copy of the arithmetic that put it
 * there. */
function leadSpan(scene: Scene): { x0: number; x1: number; seconds: number } | null {
  const lead = scene.leadSec ?? 0;
  if (!(lead > 0)) return null;
  const m = scene.layout.maps.tgt.length >= 2 ? scene.layout.maps.tgt : scene.layout.maps.you;
  if (m.length < 2) return null;
  const a = m[0]!;
  const b = m[1]!;
  return { x0: a[1], x1: b[1], seconds: b[0] - a[0] };
}

/** The count-in, drawn the way every other stretch of silence is drawn.
 *
 * Empty space says nothing: it reads as the chart starting late rather than as
 * time you are meant to be counting through. Bracketed and labeled, it is the
 * same object as the gaps below it — a measured silence with its length on it
 * — and the cursor crossing it means something. */
function drawLead(ctx: Ctx2D, scene: Scene): void {
  const span = leadSpan(scene);
  if (!span) return;
  const w = span.x1 - span.x0;
  if (w < 4 || !visible(span.x0, w, scene)) return;

  const C = scene.palette;
  // The target row is the top one in every view, overlay included.
  const yTop = scene.rows.tgt;
  const mid = yTop + ROW_H / 2;

  ctx.strokeStyle = C.you;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(span.x0 + 1, mid - 5);
  ctx.lineTo(span.x0 + 1, mid + 5);
  ctx.moveTo(span.x1 - 1, mid - 5);
  ctx.lineTo(span.x1 - 1, mid + 5);
  ctx.moveTo(span.x0 + 1, mid);
  ctx.lineTo(span.x1 - 1, mid);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (w < 30) return;
  const label = `${Math.round(span.seconds)}s`;
  ctx.font = `600 10px ${C.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width + 8;
  ctx.fillStyle = C.panel;
  ctx.fillRect(span.x0 + w / 2 - tw / 2, mid - 6, tw, 12);
  ctx.fillStyle = C.you;
  ctx.fillText(label, span.x0 + w / 2, mid);
}

/** How far the count-in's number sits in from the gutter and down from the
 *  rule above it. */
const COUNT_INSET_X = 14;
const COUNT_INSET_Y = 8;

/** Seconds still to go, in the corner where they cannot scroll away.
 *
 * The cursor shows where it has got to and the bracket shows how far it has to
 * come, but neither answers "how long have I got" at a glance — and that is
 * the one thing somebody with a hand on a paddle is asking. Screen
 * coordinates, outside the scrolled group, for exactly that reason. */
function drawCountIn(ctx: Ctx2D, scene: Scene): void {
  const lead = scene.leadSec ?? 0;
  const ph = scene.playhead;
  if (!(lead > 0) || !ph) return;
  const m = scene.layout.maps[ph.side];
  const arrival = m[1]?.[0];
  if (arrival === undefined) return;
  const left = arrival - ph.t;
  if (left <= 0) return;

  /* Inset from both edges rather than tucked into the corner. Measured from
     the gutter and from the rule under the ruler, the two things it would
     otherwise sit hard against — the caption band is only as tall as a caption
     and a number set to fill it has no air above it at all. */
  const C = scene.palette;
  ctx.font = `700 18px ${C.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = C.you;
  /* Tenths, not whole seconds. A count that ticks 3, 2, 1 tells you which
     second you are in and nothing about where in it — and the whole job here
     is arriving on a beat. The chart already repaints every frame while the
     cursor is running, so the precision costs nothing; monospaced figures keep
     the width from twitching as the digits change. */
  ctx.fillText(left.toFixed(1), GUTTER + COUNT_INSET_X, scene.rows.tgtLabel + COUNT_INSET_Y);
}

/** One character as a mark on the clock, instead of the dits and dahs in it.
 *
 * A fixed-width tick at the moment the character begins. The width carries no
 * information on purpose: what is being practiced is the rhythm — when the
 * next character starts — and a block whose length tracked the character would
 * put its duration back on screen, which is the thing that pulls attention
 * into counting elements instead of keeping time.
 *
 * What the markers say is in the space between them. What the color says is
 * whether that character landed where it should have: the same verdict the
 * grade strip carries, its own elements and the gap that led into it, because
 * arriving late is exactly the fault this view exists to show. */
function drawCharMarker(
  ctx: Ctx2D,
  scene: Scene,
  ch: Char,
  x0: number,
  yTop: number,
  isTarget: boolean,
): void {
  const C = scene.palette;
  const y = yTop + (ROW_H - MARK_H) / 2;

  let worst: Grade = "ok";
  if (!isTarget) {
    const blocks = ch.leadGap ? [...ch.blocks, ch.leadGap] : ch.blocks;
    for (const b of blocks) {
      if (b.targetUnits <= 0) continue;
      const g = gradeOf(b.units, b.targetUnits, scene.tolerance);
      if (g === "bad" || (g === "warn" && worst === "ok")) worst = g;
    }
  }

  ctx.fillStyle = isTarget
    ? C.tgt
    : worst === "warn"
      ? C.warn
      : worst === "bad"
        ? C.bad
        : C.you;
  ctx.globalAlpha = isTarget ? 0.55 : 1;
  roundRect(ctx, x0, y, MARKER_W, MARK_H, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  /* Hovering anywhere in the character lights its marker, since the marker is
     all there is of it — as a halo around the tick rather than an outline on
     it. At this width an outline would simply cover the thing it is meant to
     be pointing at. */
  if (scene.hover && ch.blocks.includes(scene.hover)) {
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    roundRect(ctx, x0 - 2.5, y - 2.5, MARKER_W + 5, MARK_H + 5, 3);
    ctx.stroke();
  }
}

function drawMarks(
  ctx: Ctx2D,
  scene: Scene,
  ch: Char,
  x0: number,
  yTop: number,
  isTarget: boolean,
): void {
  if (scene.charMarkers) {
    drawCharMarker(ctx, scene, ch, x0, yTop, isTarget);
    return;
  }
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
  width: number,
  yTop: number,
): void {
  // A hole where a character should have been, the same size as the thing it
  // is standing in for.
  const w = scene.charMarkers ? MARKER_W : width;
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
  y: number,
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
  ctx.fillText(GRADE_MARK[worst], x + w / 2, y + GRADE_H / 2);
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
/** One attempt's drift, as a set of traces.
 *
 * A set rather than a line because a rest breaks it: you stopped, and what
 * follows starts fresh, so carrying the accumulated drift across the break
 * would report a gap you were not being graded on as if it were sending.
 *
 * The local name is "traces" and not "runs" — a run is an attempt now, and
 * the two meanings sat on the same word in here. */
function driftTraces(scene: Scene, lane: Lane): Array<Array<[number, number]>> {
  const u = lane.layout.unitSec;
  const traces: Array<Array<[number, number]>> = [];
  let pts: Array<[number, number]> | null = null;
  let base: number | null = null;

  for (const it of lane.layout.items) {
    const slot = it.slot;
    if (!slot.actual || !slot.ideal) continue;
    if (base === null || isRest(slot.actual.leadGap)) {
      base = slot.actual.t0 - slot.ideal.t0;
      pts = [];
      traces.push(pts);
    }
    const drift = (slot.actual.t1 - base - slot.ideal.t1) / u;
    const x =
      scene.view === "per-char"
        ? it.x! + it.gapW + it.bodyW / 2
        : it.x! + (((slot.actual.t1 - slot.actual.t0) / u) * lane.layout.ppu) / 2;
    pts!.push([x, drift]);
  }
  return traces;
}

/** Every attempt's drift, in one plot.
 *
 * Overlaid rather than given a plot each, and that is the point of it: what
 * you want to know across a session is whether the wander is getting smaller,
 * and four plots each scaled to their own worst moment would hide exactly that
 * — a run half as bad would draw an identical picture. So the axis is measured
 * across ALL of them and every trace is drawn against it, which makes a
 * shrinking trace mean what it looks like it means.
 *
 * The attempt being read is drawn over the others and at full strength; the
 * rest are the same measurement, subordinate. Nothing labels them, because at
 * forty-six pixels tall there is no room for it and the question here is the
 * shape of the family rather than which line is which. */
function drawDrift(ctx: Ctx2D, scene: Scene): void {
  const perLane = scene.runs.map((lane) => driftTraces(scene, lane));

  let driftMax = 1;
  for (const traces of perLane) {
    for (const trace of traces) {
      for (const p of trace) driftMax = Math.max(driftMax, Math.abs(p[1]));
    }
  }
  scene.driftMax = driftMax;

  const half = DRIFT_H / 2 - 8;
  const mid = scene.rows.drift + DRIFT_H / 2;
  ctx.strokeStyle = scene.palette.you;

  // Others first, so the one being read is not drawn under them.
  const order = perLane.map((_, r) => r).sort((a, b) => Number(a === scene.selected) - Number(b === scene.selected));
  for (const r of order) {
    const mine = r === scene.selected;
    ctx.lineWidth = mine ? 1.5 : 1;
    ctx.globalAlpha = mine ? 1 : 0.4;
    for (const trace of perLane[r]!) {
      if (trace.length < 2) continue;
      ctx.beginPath();
      trace.forEach((p, i) => {
        const y = mid - (p[1] / driftMax) * half;
        if (i === 0) ctx.moveTo(p[0], y);
        else ctx.lineTo(p[0], y);
      });
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** The left band: track names and the drift axis bound. Drawn after the content
 *  and outside its clip, so nothing can slide underneath. */
function drawGutter(ctx: Ctx2D, scene: Scene): void {
  const C = scene.palette;
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, GUTTER, scene.rows.height);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GUTTER - 0.5, RULER_H);
  ctx.lineTo(GUTTER - 0.5, scene.rows.plotBottom);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 10px ${C.mono}`;

  /* Grades in the gutter, and only where they answer something.
   *
   * With one attempt on screen the band under the chart is already its score
   * and a second copy of the same number four pixels from the row it belongs
   * to is noise. With a stack it is the question being asked — which of these
   * went better — and the answer was only ever available one row at a time, by
   * clicking each in turn and reading the band below. The absolute and overlay
   * views have their own bands and no per-attempt rows to hang these on. */
  const graded = scene.view !== "overlay" && scene.runs.length > 1;

  // In overlay the tracks share one band, so the two names stack as a color key
  // inside it rather than labeling separate rows.
  const rows: Array<[number, string, string]> =
    scene.view === "overlay"
      ? [
          [scene.rows.tgt + OVER_H / 2 - 9, "TGT", C.tgt],
          [scene.rows.tgt + OVER_H / 2 + 9, "YOU", C.you],
          [scene.rows.drift + 7, "DRIFT", C["ink-dim"]],
        ]
      : [
          [scene.rows.tgt + ROW_H / 2, "TGT", C.tgt],
          /* One name per attempt. "YOU" only while there is one of them —
             with a stack, which attempt a row is is the thing you need from
             this band, and four rows all called YOU would not say it. Numbered
             from one, in the order they were recorded, because that is what
             the Drop button calls them too. */
          ...scene.runs.map(
            (lane, r) =>
              [
                /* Centered on its row while the name is the only thing there,
                   and pushed up to make room when the grades go under it. One
                   attempt keeps the first case, which is what leaves a single
                   run drawing exactly as it always has. */
                scene.rows.runs[r]!.row + (graded ? 9 : ROW_H / 2),
                scene.runs.length === 1 ? "YOU" : `RUN ${lane.ordinal + 1}`,
                r === scene.selected
                  ? C.you
                  : r === scene.picking
                    ? C.ink
                    : C["ink-dim"],
              ] as [number, string, string],
          ),
          [scene.rows.drift + 7, "DRIFT", C["ink-dim"]],
        ];
  for (const [y, label, color] of rows) {
    ctx.fillStyle = color;
    ctx.fillText(label, 4, y);
  }

  if (graded) {
    ctx.font = `9px ${C.mono}`;
    for (const [r, lane] of scene.runs.entries()) {
      // Nothing was keyed into it, so every figure would be a reading off an
      // empty recording — the same reason the band below dashes them.
      if (lane.blank) continue;
      const top = scene.rows.runs[r]!.row;
      ctx.fillStyle = C[scoreBand(lane.analysis.withinTolFrac, CONSISTENT_BANDS)];
      ctx.fillText(`${Math.round(lane.analysis.withinTolFrac * 100)}%`, 4, top + 20);
      if (lane.accuracy !== null) {
        // Second, under it, in the order the band below the chart reads: the
        // one that matters for keying first, then the one that needs a target
        // to mean anything.
        ctx.fillStyle = C[scoreBand(lane.accuracy, ACCURATE_BANDS)];
        ctx.fillText(`${Math.round(lane.accuracy * 100)}%`, 4, top + 29);
      }
    }
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
    scene.rows.drift + 20,
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
  const y = scene.rows.scroll + 4;
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
    scene.view === "overlay"
      ? scene.rows.tgt
      : scene.playhead.side === "you"
        ? (scene.rows.runs[scene.selected] ?? scene.rows.runs[0]!).row
        : scene.rows.tgt;
  const h = scene.view === "overlay" ? OVER_H : ROW_H;
  ctx.strokeStyle = scene.playhead.side === "you" ? scene.palette.you : scene.palette.ink;
  ctx.lineWidth = PLAYHEAD_W;
  ctx.beginPath();
  ctx.moveTo(x, y0 - 4);
  ctx.lineTo(x, y0 + h + 2);
  ctx.stroke();
}

/** The y-bands the two tracks occupy, for hit testing. */
export function trackBands(
  view: ViewMode,
  rows: Rows = rowsFor(1, 0),
): {
  you: [number, number];
  tgt: [number, number];
} {
  const lane = rows.runs[0]!;
  if (view === "overlay") {
    // Split the shared band the way the separate rows are stacked: the target
    // is the upper half, yours the lower.
    return {
      tgt: [rows.tgt, rows.tgt + OVER_H / 2],
      you: [rows.tgt + OVER_H / 2, rows.tgt + OVER_H],
    };
  }
  return {
    you: [lane.row, lane.row + ROW_H],
    tgt: [rows.tgt, rows.tgt + ROW_H],
  };
}

export { HEIGHT, GUTTER, PAD_R, RULER_H, Y_SCROLL, SCROLL_H };
