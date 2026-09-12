/* Fixed geometry of the review chart.
 *
 * Kept apart from the drawing so the layout math, the hit testing and the
 * renderer all read the same numbers, and so a test can assert against them by
 * name instead of hard-coding pixel values that go stale.
 */

/** Left band for track labels. Content never enters it — it is clipped out,
 *  so scrolled blocks pass behind the labels instead of over them. */
export const GUTTER = 44;
/** Right margin inside the plot. */
export const PAD_R = 10;
/** Leading margin, in content coordinates. */
export const PAD_X = 8;
/** Character captions. */
export const LABEL_H = 22;
/** One track. Marks are drawn inside this. */
export const ROW_H = 34;
/** The OK / ~ / ** marker strip between the tracks. */
export const GRADE_H = 14;
/** Cumulative timing drift. */
export const DRIFT_H = 46;
export const RULER_H = 18;
/** The canvas-drawn scrollbar band. */
export const SCROLL_H = 14;
/** Breathing room between per-character slots. */
export const SLOT_GAP = 10;
/** Height of a dit/dah block. */
export const MARK_H = 20;

export const Y_RULER = 0;
export const Y_LABEL = RULER_H;
export const Y_YOU = RULER_H + LABEL_H;
export const Y_GRADE = Y_YOU + ROW_H;
export const Y_TGT = Y_GRADE + GRADE_H;
export const Y_DRIFT = Y_TGT + ROW_H + 6;
export const Y_SCROLL = Y_DRIFT + DRIFT_H + 2;
export const HEIGHT = Y_SCROLL + SCROLL_H;
/** Where scrollable content ends. */
export const PLOT_BOTTOM = Y_DRIFT + DRIFT_H;

/** Overlay superimposes the tracks, so it gets the whole band the two separate
 *  rows and the grade strip would have used. */
export const OVER_H = Y_TGT + ROW_H - Y_YOU;
export const OVER_MARK_H = OVER_H - 14;

/** Pixels a collapsed rest gets, whatever its real length.
 *
 * Its true width is both uninformative — nobody is graded on a rest — and
 * ruinous to the rest of the chart, since one 200-unit silence at a readable
 * zoom pushes everything after it off screen. Wide enough for the "Rest 206u"
 * label to sit inside it with the wavy spine still showing either side; at 62
 * the label's own background covered the whole thing and it read as a
 * rendering fault. */
export const REST_W = 124;

export const ZOOM_MIN = 4;
export const ZOOM_MAX = 60;

/** e-folds of px/unit per unit of wheel delta. */
export const ZOOM_RATE = 0.0025;

/** Pixels a press may move before it counts as a pan rather than a click. */
export const DRAG_SLOP = 4;

/** Silence either side of a played span, so a clip doesn't start hard on the
 *  first edge. */
export const PLAY_PAD = 0.08;
