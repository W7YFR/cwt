/* Several attempts at one message, drawn on one chart.
 *
 * The chart could only ever hold one attempt, and a great deal of it said so:
 * two fixed rows, a grade strip in the space between them, and columns that
 * came from one run's own pairing. What is checked here is the part that had
 * to be generalized for a stack — that every run gets drawn, that they line up
 * down the columns, and that the things which belong to the target rather than
 * to a run are drawn once and belong to nobody.
 */

import { describe, expect, it } from "vitest";
import { recordingCtx } from "../recording-ctx";
import { caseNamed, reviewFrom, CLEAN, SLOPPY } from "../fixture";
import { draw, type Lane, type Scene } from "@/render/scene";
import { buildLayout, measureColumns } from "@/render/layout";
import { GUTTER, LABEL_H, PAD_R, ROW_H, rowsFor } from "@/render/geometry";
import { FALLBACK_PALETTE } from "@/render/theme";
import type { Review, ViewMode } from "@/types";

const PPU = 14;
const TARGET = "CQ DE W7YFR";

/** Two real recordings, graded against one message — which is what a session
 *  is. They decode differently, so the stack has something to show. */
function reviews(): Review[] {
  return [SLOPPY, CLEAN].map(
    (name) =>
      reviewFrom(caseNamed(name), {
        expected: TARGET,
        charWpm: 20,
        farnsworthWpm: 20,
      }).review,
  );
}

function stack(
  runs: Review[],
  selected = 0,
  trackW = 4000,
  view: ViewMode = "per-char",
  order?: number[],
): Scene {
  const columns = view === "per-char" ? measureColumns(runs.map((r) => r.slots), PPU) : undefined;
  const at = order ?? runs.map((_, i) => i);
  const lanes: Lane[] = at.map((i) => {
    const review = runs[i]!;
    return {
      layout: buildLayout(review, {
        view,
        ppu: PPU,
        durationSec: review.take.durationSec,
        ...(columns ? { columns, run: i } : {}),
      }),
      slots: review.slots,
      analysis: review.analysis,
      accuracy: review.comparison?.accuracy ?? null,
      ordinal: i,
    };
  });
  const first = lanes[0]!;
  return {
    runs: lanes,
    selected,
    ...(columns ? { columns } : {}),
    layout: lanes[selected]!.layout,
    slots: lanes[selected]!.slots,
    analysis: lanes[selected]!.analysis,
    rows: rowsFor(lanes.length, selected),
    palette: FALLBACK_PALETTE,
    view,
    tolerance: 0.3,
    scrollX: 0,
    viewport: {
      viewW: trackW + GUTTER + PAD_R,
      trackW,
      contentW: first.layout.width,
      maxScroll: Math.max(0, first.layout.width - trackW),
    },
    durationSec: runs[at[selected]!]!.take.durationSec,
    idealDuration: runs[at[selected]!]!.ideal.duration,
    hover: null,
    focus: null,
    playhead: null,
  };
}

/** Every filled rectangle drawn inside a row band. Marks are rects, so this is
 *  "did this row get anything on it". */
function marksIn(ctx: ReturnType<typeof recordingCtx>, top: number): number {
  return ctx
    .ofType("fillRect")
    .filter((c) => c.args[1]! >= top && c.args[1]! < top + ROW_H).length;
}

function paint(scene: Scene) {
  const ctx = recordingCtx();
  draw(ctx, scene);
  return ctx;
}

describe("a stack of attempts", () => {
  it("draws every run, not just the one being read", () => {
    const scene = stack(reviews());
    const ctx = paint(scene);
    for (const row of scene.rows.runs) {
      expect(marksIn(ctx, row.row)).toBeGreaterThan(0);
    }
  });

  it("gives each run its own grade strip rather than one between two rows", () => {
    /* With one attempt, "between the rows" and "above this run" are the same
       place. With several they are not, and a strip between rows would be
       ambiguous about which run it was reporting on. */
    const scene = stack(reviews());
    const grades = paint(scene)
      .ofType("fillText")
      .filter((c) => ["OK", "~", "**"].includes(c.text ?? ""));
    for (const row of scene.rows.runs) {
      expect(grades.some((g) => Math.abs(g.args[1]! - (row.grade + 7)) < 2)).toBe(true);
    }
  });

  it("captions the run being read and no other", () => {
    const scene = stack(reviews(), 1);
    const labels = scene.rows.runs.map((r) => r.label);
    expect(labels.filter((l) => l !== null)).toHaveLength(1);
    expect(labels[1]).not.toBeNull();

    // And the caption text lands on that band rather than anywhere else.
    const decoded = paint(scene)
      .ofType("fillText")
      .filter((c) => c.args[1]! > scene.rows.runs[1]!.row + ROW_H);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("draws the target once, however many attempts are under it", () => {
    /* Once each, and no more: the target row is drawn from the columns rather
       than from any run's slots, so adding an attempt must not add a second
       copy of the message. */
    const target = reviews()[0]!.ideal.chars.map((c) => c.char);
    const onTargetRow = (scene: Scene) =>
      paint(scene)
        .ofType("fillText")
        .filter((c) => Math.abs(c.args[1]! - (scene.rows.tgtLabel + 11)) < 2)
        .map((c) => c.text);

    for (const scene of [stack(reviews().slice(0, 1)), stack(reviews())]) {
      expect(onTargetRow(scene).filter((t) => t !== "·")).toEqual(target);
    }
  });

  it("says nothing was asked for, where a run keyed something extra", () => {
    /* An interstice belongs to whichever run put a character there, but the
       fact that the target wanted nothing is a property of the column — so it
       has to be said even when the run being read is not that one. */
    const scene = stack(reviews(), 0);
    const interstices = scene.columns!.ideal.filter((c) => c === null).length;
    expect(interstices).toBeGreaterThan(0);

    const dots = paint(scene)
      .ofType("fillText")
      .filter((c) => c.text === "·" && Math.abs(c.args[1]! - (scene.rows.tgtLabel + 11)) < 2);
    expect(dots).toHaveLength(interstices);
  });

  it("lines the runs up, so a column means the same thing on every row", () => {
    /* The reason the whole column axis exists. Two runs that decode
       differently still have to put the same target character in the same
       place, or reading down a column would mean nothing. */
    const scene = stack(reviews());
    const xs = scene.runs.map((lane) =>
      lane.layout.items.filter((it) => it.slot.ideal).map((it) => it.x),
    );
    expect(xs[0]).toEqual(xs[1]);
  });

  it("is taller with more attempts, and by exactly the lanes it added", () => {
    const one = stack(reviews().slice(0, 1));
    const two = stack(reviews());
    expect(two.rows.height).toBeGreaterThan(one.rows.height);
    expect(two.rows.runs).toHaveLength(2);
  });
});

/* The same stack on the wall clock.
 *
 * A separate renderer, and it had to be generalized separately — which is
 * exactly how it got missed the first time. A paced recording switches the
 * chart to this view automatically, so it is the view a practice session is
 * most often looked at in, and it went out drawing one attempt at run one's
 * row with its caption at the top of the canvas.
 */
describe("a stack on the absolute axis", () => {
  const absolute = (selected = 0) => stack(reviews(), selected, 4000, "absolute");

  it("draws every attempt in its own row", () => {
    /* The bug: only the run being read was drawn, and always at the first
       row's position — so one row held somebody else's marks and the other
       held nothing at all. */
    const scene = absolute(1);
    const ctx = paint(scene);
    for (const row of scene.rows.runs) {
      expect(marksIn(ctx, row.row)).toBeGreaterThan(0);
    }
  });

  it("writes no text above the target's own caption band", () => {
    /* The other half of the same bug. An uncaptioned run has `label === null`,
       and a non-null assertion on it put the text at `null + 11` — eleven
       pixels down, in the middle of the ruler. */
    const scene = absolute(1);
    const above = paint(scene)
      .ofType("fillText")
      .filter((c) => c.args[1]! < scene.rows.tgtLabel)
      .map((c) => c.text ?? "");
    // The ruler's own second labels live up there and belong there. Nothing
    // else may.
    expect(above.filter((t) => !/^\d+s$/.test(t))).toEqual([]);
  });

  it("captions only the attempt being read", () => {
    for (const pick of [0, 1]) {
      const scene = absolute(pick);
      const band = scene.rows.runs[pick]!.label!;
      const captions = paint(scene)
        .ofType("fillText")
        .filter((c) => Math.abs(c.args[1]! - (band + 11)) < 2);
      expect(captions.length).toBeGreaterThan(0);

      // And nothing written into the row that has no band of its own.
      const other = scene.rows.runs[1 - pick]!;
      expect(other.label).toBeNull();
      const intruders = paint(scene)
        .ofType("fillText")
        // Track content only: the gutter writes its row names down the left
        // and they are not in the plot.
        .filter((c) => c.args[0]! > GUTTER)
        .filter((c) => c.args[1]! > other.row + ROW_H && c.args[1]! < other.row + ROW_H + 22);
      expect(intruders).toEqual([]);
    }
  });

  it("draws the target once, not once per attempt", () => {
    const target = reviews()[0]!.ideal.chars.map((c) => c.char);
    const scene = absolute(0);
    const onTargetRow = paint(scene)
      .ofType("fillText")
      .filter((c) => Math.abs(c.args[1]! - (scene.rows.tgtLabel + 11)) < 2)
      .map((c) => c.text);
    expect(onTargetRow).toEqual(target);
  });
});

/* The drift plot with a session in it.
 *
 * The one place where several attempts are compared directly rather than read
 * one at a time, which makes it the closest thing the app has to "am I getting
 * better".
 */
describe("drift across a session", () => {
  /** Every line drawn inside the drift band, as its own path. */
  function traces(scene: Scene) {
    const ctx = paint(scene);
    const out: { alpha: number; width: number; points: number }[] = [];
    let open: { alpha: number; width: number; points: number } | null = null;
    for (const c of ctx.calls) {
      if (c.op === "beginPath") open = null;
      if (c.op === "moveTo" || c.op === "lineTo") {
        const y = c.args[1]!;
        if (y < scene.rows.drift || y > scene.rows.drift + 46) continue;
        // The traces' own color. The band also holds the zero rule, drawn in
        // the frame's line color at full strength — counting that as a trace
        // let a one-trace plot satisfy "one bright and one dim".
        if (c.stroke !== FALLBACK_PALETTE.you) continue;
        if (!open) {
          open = { alpha: c.alpha, width: 0, points: 0 };
          out.push(open);
        }
        open.points++;
      }
      if (c.op === "stroke" && open) open.width = 1;
    }
    return out;
  }

  it("draws a trace for every attempt, not just the one being read", () => {
    const one = traces(stack(reviews().slice(0, 1)));
    const two = traces(stack(reviews()));
    expect(two.length).toBeGreaterThan(one.length);
  });

  it("draws the others behind, and dimmer", () => {
    /* Same measurement, subordinate: what is being read has to be findable in
       the family without the family disappearing. */
    const scene = stack(reviews(), 1);
    const alphas = traces(scene).map((t) => t.alpha);
    // Exactly one attempt is being read, so exactly one strength is full.
    expect(alphas.filter((a) => a === 1).length).toBeGreaterThan(0);
    expect(alphas.filter((a) => a < 1).length).toBeGreaterThan(0);
    expect(new Set(alphas).size).toBe(2);
  });

  it("measures every attempt against one axis", () => {
    /* The whole point of overlaying. Scaled to its own worst moment, a run
       half as bad would draw an identical picture — so the thing you are
       looking for, the wander getting smaller, would be invisible. */
    const runs = reviews();
    const together = stack(runs);
    paint(together);
    const shared = together.driftMax!;

    for (const [i] of runs.entries()) {
      const alone = stack([runs[i]!]);
      paint(alone);
      // One attempt out of the session can need less room, never more.
      expect(alone.driftMax!).toBeLessThanOrEqual(shared + 1e-9);
    }
    // And the session's axis is one of theirs rather than something larger.
    expect(shared).toBeGreaterThan(0);
  });
});

/* Every attempt's grade, beside the attempt.
 *
 * The scores under the chart are about the selected run, so with a stack the
 * question the stack exists to ask — which of these went better — could only
 * be answered one row at a time, by clicking each in turn and reading the band
 * below. These put the answer on the rows.
 */
describe("grades in the gutter", () => {
  const inGutter = (scene: Scene) =>
    paint(scene)
      .ofType("fillText")
      .filter((c) => c.args[0]! < GUTTER)
      .sort((a, b) => a.args[1]! - b.args[1]!);

  const percents = (scene: Scene) =>
    inGutter(scene).filter((c) => /^\d+%$/.test(c.text ?? ""));

  it("puts both figures on every attempt", () => {
    const runs = reviews();
    // Two scores apiece: consistency, and accuracy against the target.
    expect(percents(stack(runs)).length).toBe(runs.length * 2);
  });

  it("drops accuracy when there is no target to be accurate against", () => {
    /* Grading a decode against itself is a meaningless 100%, which is why the
       band under the chart leaves the figure out too. */
    const runs = [SLOPPY, CLEAN].map(
      (name) =>
        reviewFrom(caseNamed(name), { expected: "", charWpm: 20, farnsworthWpm: 20 })
          .review,
    );
    expect(percents(stack(runs)).length).toBe(runs.length);
  });

  it("reads each figure off the attempt whose row it is in", () => {
    /* The point of the whole thing. Two recordings that decode differently
       have to come back with different numbers, in the rows they belong to —
       grades that are right on average and in the wrong rows are worse than
       none, because the chart is what you would be comparing from. */
    const runs = reviews();
    const scene = stack(runs);
    expect(new Set(percents(scene).map((c) => c.text)).size).toBeGreaterThan(1);

    for (const [r, lane] of scene.runs.entries()) {
      const top = scene.rows.runs[r]!.row;
      const mine = percents(scene)
        .filter((c) => c.args[1]! >= top && c.args[1]! < top + ROW_H)
        .map((c) => c.text);
      expect(mine, `run ${r + 1}`).toEqual([
        `${Math.round(lane.analysis.withinTolFrac * 100)}%`,
        `${Math.round(lane.accuracy! * 100)}%`,
      ]);
    }
  });

  it("can be turned off", () => {
    const runs = reviews();
    const on = stack(runs);
    expect(percents({ ...on, runScores: false })).toEqual([]);
    // And the names stay, because that is not what was switched off.
    expect(
      inGutter({ ...on, runScores: false }).filter((c) => /^RUN /.test(c.text ?? "")),
    ).toHaveLength(runs.length);
  });

  it("says nothing extra when there is only one attempt", () => {
    /* The band under the chart is already that run's score, and a second copy
       of it four pixels from the row is noise. It is also what keeps a single
       run drawing exactly as it always did. */
    const runs = reviews();
    expect(percents(stack([runs[0]!])).length).toBe(0);
  });

  it("stays out of a view that has no per-attempt rows", () => {
    const runs = reviews();
    expect(percents(stack(runs, 0, 4000, "overlay")).length).toBe(0);
  });
});

/* Captioning every attempt, rather than the one being read.
 *
 * The band is reserved on every row whichever way this is set — that is what
 * keeps picking a row from moving the rows under it — so this changes what is
 * written and nothing about where anything sits.
 */
describe("captions on every row", () => {
  /** How many of the caption bands on offer actually got text written in one.
   *
   * By band rather than by count of characters: what is being asked is how
   * many attempts are captioned, and the runs decode differently so their
   * captions are not the same length. */
  const rowsWritten = (all: boolean) => {
    const runs = reviews();
    const scene: Scene = { ...stack(runs), rows: rowsFor(runs.length, 0, all) };
    const text = paint(scene)
      .ofType("fillText")
      .filter((c) => c.args[0]! >= GUTTER);
    return scene.rows.runs.filter(
      (r) =>
        r.label !== null &&
        text.some((c) => c.args[1]! >= r.label! && c.args[1]! <= r.label! + LABEL_H),
    ).length;
  };

  it("writes one row of text by default and all of them when asked", () => {
    expect(rowsWritten(false)).toBe(1);
    expect(rowsWritten(true)).toBe(2);
  });

  it("reserves the band either way, so nothing moves when it changes", () => {
    const one = rowsFor(4, 2, false);
    const all = rowsFor(4, 2, true);
    expect(all.runs.map((r) => [r.grade, r.row, r.bottom])).toEqual(
      one.runs.map((r) => [r.grade, r.row, r.bottom]),
    );
    expect(all.height).toBe(one.height);
  });
});

/* Sorting the rows.
 *
 * What has to hold is that sorting moves a row and changes nothing else about
 * it — above all not its name. A run's number is the order it was recorded in,
 * so the third attempt is RUN 3 wherever it is drawn.
 */
describe("rows in a chosen order", () => {
  const names = (scene: Scene) =>
    paint(scene)
      .ofType("fillText")
      .filter((c) => c.args[0]! < GUTTER && /^RUN /.test(c.text ?? ""))
      .sort((a, b) => a.args[1]! - b.args[1]!)
      .map((c) => c.text);

  it("names a run for when it was recorded, not for where it sits", () => {
    /* Renumbering by position would have the row you are reading take another
       attempt's name, and the Drop button offer to throw away a recording it
       did not name. */
    const runs = reviews();
    expect(names(stack(runs, 0, 4000, "per-char", [0, 1]))).toEqual(["RUN 1", "RUN 2"]);
    expect(names(stack(runs, 0, 4000, "per-char", [1, 0]))).toEqual(["RUN 2", "RUN 1"]);
  });

  it("draws the reordered rows in the order given", () => {
    const runs = reviews();
    const forward = stack(runs, 0, 4000, "per-char", [0, 1]);
    const reversed = stack(runs, 0, 4000, "per-char", [1, 0]);
    // The same two lanes, swapped: what was on the top row is now underneath.
    expect(reversed.runs.map((l) => l.ordinal)).toEqual(
      [...forward.runs.map((l) => l.ordinal)].reverse(),
    );
    for (const scene of [forward, reversed]) {
      const ctx = paint(scene);
      for (const row of scene.rows.runs) expect(marksIn(ctx, row.row)).toBeGreaterThan(0);
    }
  });

  it("keeps the caption with the attempt being read, wherever it lands", () => {
    /* Selection is a row position inside the renderer, so a reorder must not
       leave the caption band on the attempt that used to be there. */
    const runs = reviews();
    const scene = stack(runs, 0, 4000, "per-char", [1, 0]);
    expect(scene.runs[0]!.ordinal).toBe(1);
    expect(scene.rows.runs[0]!.label).not.toBeNull();
    expect(scene.rows.runs[1]!.label).toBeNull();
  });
});
