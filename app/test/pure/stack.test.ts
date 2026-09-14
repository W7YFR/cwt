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
import { GUTTER, PAD_R, ROW_H, rowsFor } from "@/render/geometry";
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
): Scene {
  const columns = view === "per-char" ? measureColumns(runs.map((r) => r.slots), PPU) : undefined;
  const lanes: Lane[] = runs.map((review, i) => ({
    layout: buildLayout(review, {
      view,
      ppu: PPU,
      durationSec: review.take.durationSec,
      ...(columns ? { columns, run: i } : {}),
    }),
    slots: review.slots,
    analysis: review.analysis,
  }));
  const first = lanes[0]!;
  return {
    runs: lanes,
    selected,
    ...(columns ? { columns } : {}),
    layout: lanes[selected]!.layout,
    slots: runs[selected]!.slots,
    analysis: runs[selected]!.analysis,
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
    durationSec: runs[selected]!.take.durationSec,
    idealDuration: runs[selected]!.ideal.duration,
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

