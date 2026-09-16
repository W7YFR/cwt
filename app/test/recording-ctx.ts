/* A 2D context that records instead of drawing.
 *
 * The renderer is written against `Ctx2D`, the subset of the canvas API it
 * actually uses, so this is a complete implementation of that interface rather
 * than a cast with holes in it. Which means the pure tier can assert on what
 * the chart decided to draw — how many marks, in what color, where — without a
 * browser, a GPU, or a screenshot to eyeball.
 *
 * A real-canvas test can only tell you that nothing threw. That is not a useful
 * thing to know about a chart.
 */

import type { Ctx2D } from "@/render/scene";

export interface DrawCall {
  op: string;
  args: number[];
  text?: string;
  fill: string;
  stroke: string;
  alpha: number;
  font: string;
  /** Which end of the text `args[0]` is. Text drawn at a given x means two
   *  different pictures depending on it, so it has to be recorded with it. */
  align: CanvasTextAlign;
}

export interface RecordingCtx extends Ctx2D {
  calls: DrawCall[];
  /** Every call of one op. */
  ofType(op: string): DrawCall[];
  /** Every piece of text drawn, in order. */
  texts(): string[];
  /** Distinct fill colors used by a given op. */
  fillsFor(op: string): string[];
  reset(): void;
}

export function recordingCtx(charWidth = 6): RecordingCtx {
  const calls: DrawCall[] = [];

  const state = {
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "10px monospace",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };

  const record = (op: string, args: number[], text?: string) => {
    const call: DrawCall = {
      op,
      args,
      fill: state.fillStyle,
      stroke: state.strokeStyle,
      alpha: state.globalAlpha,
      font: state.font,
      align: state.textAlign,
    };
    if (text !== undefined) call.text = text;
    calls.push(call);
  };

  const ctx: RecordingCtx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: CanvasTextAlign) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: CanvasTextBaseline) {
      state.textBaseline = v;
    },

    save: () => record("save", []),
    restore: () => record("restore", []),
    beginPath: () => record("beginPath", []),
    closePath: () => record("closePath", []),
    moveTo: (x, y) => record("moveTo", [x, y]),
    lineTo: (x, y) => record("lineTo", [x, y]),
    arcTo: (x1, y1, x2, y2, r) => record("arcTo", [x1, y1, x2, y2, r]),
    rect: (x, y, w, h) => record("rect", [x, y, w, h]),
    clip: () => record("clip", []),
    fill: () => record("fill", []),
    stroke: () => record("stroke", []),
    fillRect: (x, y, w, h) => record("fillRect", [x, y, w, h]),
    clearRect: (x, y, w, h) => record("clearRect", [x, y, w, h]),
    fillText: (t, x, y) => record("fillText", [x, y], t),
    // Proportional enough to exercise the label-fits logic without pulling in
    // a font metric nobody can reproduce offline.
    measureText: (t: string) => ({ width: t.length * charWidth }),
    translate: (x, y) => record("translate", [x, y]),
    setLineDash: (d: number[]) => record("setLineDash", d),

    calls,
    ofType: (op) => calls.filter((c) => c.op === op),
    texts: () => calls.filter((c) => c.text !== undefined).map((c) => c.text!),
    fillsFor: (op) => [...new Set(calls.filter((c) => c.op === op).map((c) => c.fill))],
    reset: () => {
      calls.length = 0;
    },
  };

  return ctx;
}
