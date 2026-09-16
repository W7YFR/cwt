/* The review's fixed numbers: its geometry, and the handful of durations that
 * go with it.
 *
 * Kept apart from the drawing so the layout math, the hit testing and the
 * renderer all read the same numbers, and so a test can assert against them by
 * name instead of hard-coding values that go stale. The times live here for
 * the same reason — a count-in quoted in help text and used by a clock is one
 * number, not two.
 */

/** Left band for track labels. Content never enters it — it is clipped out,
 *  so scrolled blocks pass behind the labels instead of over them. */
export const GUTTER = 44;
/** Right margin inside the plot. */
export const PAD_R = 10;
/** Leading margin, in content coordinates. */
export const PAD_X = 8;
/** Character captions.
 *
 * Tall enough for two lines, because it carries two: the character, and —
 * under yours — a note when the gap before it was a word boundary that should
 * not have been there or should have been. Sized for a caption alone, the note
 * was written across the character it was about. */
export const LABEL_H = 30;

/** Where the text sits inside a caption band, from the edge nearest the row it
 *  belongs to. The target's band is above its row and yours is below, so both
 *  are measured toward their own marks and the two face each other across the
 *  chart the way the rows do. */
export const CAP_CHAR = 10;
/** And the note under it, from the same edge. */
export const CAP_NOTE = 22;

/** Air above a row's grade strip, separating it from whatever is above.
 *
 * Belongs to the row below rather than to the one above: the grade strip is
 * part of the attempt it reports on, so the break in the page goes before it.
 * Left out of the row's own band, so a hovered row washes to its edges and the
 * gap stays as the thing that says where one row ends. */
export const LANE_GAP = 8;
/** One track. Marks are drawn inside this. */
export const ROW_H = 34;
/** The OK / ~ / ** marker strip between the tracks. */
export const GRADE_H = 14;
/** Cumulative timing drift. */
export const DRIFT_H = 46;
export const RULER_H = 18;
/** The canvas-drawn scrollbar band. */
export const SCROLL_H = 14;
/** Height of a dit/dah block. */
export const MARK_H = 20;

/** Stroke width of the playhead, and of the pacing cursor that rides on it. */
export const PLAYHEAD_W = 1.5;

/** Width of a character marker, in pixels and deliberately not in units.
 *
 * The marker says WHEN a character starts and nothing else. Giving it a width
 * that tracked the character's length would put the length back on screen —
 * and the whole reason for drawing one is to practice the rhythm without
 * thinking about how long a character ought to take. Fixed pixels, so it does
 * not grow with the zoom either.
 *
 * The same width as the cursor, and tied to it rather than merely set to the
 * same number: the two are meant to line up. What you are watching for is the
 * cursor arriving on a tick, and a cursor fatter or thinner than the thing it
 * is arriving at makes that moment harder to judge than it needs to be. */
export const MARKER_W = PLAYHEAD_W;

/** Narrowest a character may be drawn on the clock axes.
 *
 * There a character marker spans the character's own extent — position on
 * those axes is time, so how long it took is already on screen whether it is
 * drawn or not, and leaving the space empty withholds nothing except the
 * ability to see it. A floor rather than a width: zoomed far enough out a
 * single dit is a fraction of a pixel, and a character you cannot see is a
 * character you cannot point at either. */
export const CLOCK_MARKER_MIN_W = 6;

/** How much room a character marker answers to in the per-character view.
 *
 * A marker is the whole of a character on screen there and is a pixel and a
 * half wide, which is not something a pointer can be asked to land on. So the
 * region it answers to is a pointer's worth of room starting where the
 * character does. That overlaps the near edge of the gap after it, which is
 * the right trade: the near edge of a gap is exactly where "the character
 * ended" and "the silence began" are hardest to tell apart by eye anyway. */
export const MARKER_HIT_W = 9;

/* The rows, top to bottom.
 *
 * The target is above your sending, with a caption band of its own, and that
 * order is the point rather than a preference. The target row is the one thing
 * on the chart that does not change between attempts: it is the message you
 * meant to send, rendered at the speeds now set. Putting the reference on top
 * and the attempt under it is how every comparison of this shape is read —
 * and it lets each row carry its own text, the intended message above and what
 * actually came out below, instead of one caption band trying to be both.
 *
 * The captions sit on the outside — target's above its row, yours below its
 * own — so the two tracks face each other across the grade strip and can be
 * read against each other without a line of text in between. */
export const Y_RULER = 0;
export const Y_TGT_LABEL = RULER_H;
export const Y_TGT = Y_TGT_LABEL + LABEL_H;
export const Y_GRADE = Y_TGT + ROW_H + LANE_GAP;
export const Y_YOU = Y_GRADE + GRADE_H;
export const Y_YOU_LABEL = Y_YOU + ROW_H;
export const Y_DRIFT = Y_YOU_LABEL + LABEL_H + 6;
export const Y_SCROLL = Y_DRIFT + DRIFT_H + 2;
export const HEIGHT = Y_SCROLL + SCROLL_H;
/** Where scrollable content ends. */
export const PLOT_BOTTOM = Y_DRIFT + DRIFT_H;

/** Where one attempt sits. */
export interface RunRow {
  /** The OK / ~ / ** strip, above the row it belongs to. */
  grade: number;
  /** The marks. */
  row: number;
  /** The per-character caption, or null when this run is not the one being
   *  read in detail. */
  label: number | null;
  /** One past the bottom of the whole lane. */
  bottom: number;
}

export interface Rows {
  tgtLabel: number;
  tgt: number;
  runs: RunRow[];
  drift: number;
  scroll: number;
  height: number;
  plotBottom: number;
}

/** Lay the rows out for a given number of attempts.
 *
 * The grade strip belongs to a RUN rather than to the space between two rows.
 * With one attempt on screen those are the same place and the distinction
 * never had to be made; with several it does, because each run is graded
 * against the target separately and a strip between rows would be ambiguous
 * about which one it was reporting on.
 *
 * `captioned` is the run being read in detail, and by default only it gets a
 * band of per-character text: six rows of captions is not the comparison most
 * people are making, and a run that dropped a letter already says so by
 * leaving a hole in its column. `all` is for when it is — reading what every
 * attempt came out as, rather than how they line up.
 *
 * The band is reserved on every lane all the same, and that is the point of
 * this being a layout rather than a consequence: selecting a row is a change
 * of what is highlighted, not of where anything is. Given to the captioned
 * lane alone, every row under it moved by the height of a caption each time
 * the selection changed — and the marks you were comparing jumped out from
 * under the pointer that was about to click the next one.
 *
 * With one captioned run this reproduces the constants above exactly, which is
 * asserted rather than hoped for: the fixed layout was correct, and stacking
 * must not quietly move a chart that has nothing stacked on it. */
export function rowsFor(runs: number, captioned: number, all = false): Rows {
  const tgtLabel = RULER_H;
  const tgt = tgtLabel + LABEL_H;
  let y = tgt + ROW_H;

  const lanes: RunRow[] = [];
  for (let r = 0; r < Math.max(runs, 1); r++) {
    const grade = y + LANE_GAP;
    const row = grade + GRADE_H;
    const label = all || r === captioned ? row + ROW_H : null;
    const bottom = row + ROW_H + LABEL_H;
    lanes.push({ grade, row, label, bottom });
    y = bottom;
  }

  const drift = y + 6;
  const scroll = drift + DRIFT_H + 2;
  return {
    tgtLabel,
    tgt,
    runs: lanes,
    drift,
    scroll,
    height: scroll + SCROLL_H,
    plotBottom: drift + DRIFT_H,
  };
}

/** Overlay superimposes the tracks, so it gets the whole band the two separate
 *  rows and the grade strip would have used. */
export const OVER_H = Y_YOU + ROW_H - Y_TGT;
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

/** Quiet after the record button before the pacing cursor sets off, seconds.
 *
 * A starting point, not a rule — it is settable, because how long somebody
 * needs to get a hand back to the paddle is about them and not about the
 * chart. The recording itself starts at once either way: the lead-in is a
 * count, not a delay, and a microphone take is trimmed at both ends anyway, so
 * the silence costs nothing. */
export const PACE_LEAD_DEFAULT_SEC = 3;
export const PACE_LEAD_MIN_SEC = 1;
export const PACE_LEAD_MAX_SEC = 10;

/** How long the flash card stays lit, seconds. Long enough to catch out of the
 *  corner of an eye, short enough to be over before the next character. */
export const FLASH_SEC = 0.12;

/** How far ahead of the beat the card flashes, milliseconds.
 *
 * Not zero, which is the honest default and the useless one: a cue that fires
 * exactly on the beat leaves you late by your own reaction time on every
 * character, and that reads as the cue being wrong rather than as something to
 * dial in. Two hundred milliseconds is roughly a visual reaction — a guess,
 * and the control exists because the guess is wrong for somebody. */
export const FLASH_LEAD_DEFAULT_MS = 25;

/** How long after the target's last character a paced recording stops itself.
 *
 * You declared the message and the pace, so where the take ends is already
 * known and reaching for the mouse to say so is a second of dead air and a
 * hand off the paddle. Long enough to let the last element ring out; short
 * enough that it does not feel like a hang.
 *
 * It ends on the SCHEDULE, not on what you sent — so falling far enough behind
 * the cursor will cut the take short. That is the honest behavior for a clock
 * you asked to be held to, and Restart is one key away. */
export const PACED_STOP_AFTER_SEC = 1;
export const FLASH_LEAD_MIN_MS = 0;
export const FLASH_LEAD_MAX_MS = 1000;
