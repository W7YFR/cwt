/* The column axis every run is drawn against, in the per-character view.
 *
 * With one attempt on screen, columns need no thought: a slot pairs one
 * character of the decode against one of the target, and each pair is a column
 * by construction. With several attempts at the same message that breaks, and
 * it breaks in the way that matters most — each run is paired against the
 * target separately, so run 3 dropping a letter shifts everything after it and
 * its columns no longer line up with run 1's. Stacked that way the rows would
 * be unreadable exactly when they had the most to say.
 *
 * So a column is a position on the TARGET rather than a character of any one
 * run. Every run holds every target character exactly once, in order — the
 * alignment consumes each expected token once, as a match, a substitution or a
 * deletion — which makes the target's characters a spine all runs can hang
 * from. What a run dropped is then an empty cell in a column rather than a
 * shift in everything downstream, and the same letter going missing every time
 * reads as a vertical hole.
 *
 * Extra characters are the other half. A run that keys something the target
 * has no place for cannot go in an anchor column, so an interstice opens
 * between two anchors, as wide as the most any single run put there. Runs that
 * keyed nothing extra simply leave it empty — which is the honest picture: the
 * gap says one of you added something here.
 *
 * Nothing in here knows about pixels. Widths depend on the zoom and belong to
 * the layout; which column a character sits in does not.
 */

import type { Slot } from "@/types";

/** One column of the per-character view. */
export interface Column {
  /** Index into the target's characters, or -1 for an interstice — a column
   *  that exists only because some run keyed a character the target has no
   *  place for. */
  readonly ideal: number;
}

export interface ColumnPlan {
  readonly columns: readonly Column[];
  /** `at[run][slot]` is the column that slot occupies.
   *
   * Indexed rather than looked up, because the layout walks every slot of
   * every run on every frame and searching for a column each time would make
   * the zoom quadratic in the number of attempts. */
  readonly at: readonly (readonly number[])[];
}

/** Where one run's slots sit, before the runs are reconciled with each other.
 *
 * `anchor` is the target character index for a slot that has one. `gap` is the
 * interstice a slot with no target character falls in, named by the anchor it
 * comes before, with `ordinal` counting off several in a row. */
interface Placement {
  readonly anchor: number;
  readonly gap: number;
  readonly ordinal: number;
}

function placeRun(slots: readonly Slot[]): { places: Placement[]; anchors: number; extra: number[] } {
  const places: Placement[] = [];
  const extra: number[] = [];
  let anchors = 0;
  for (const slot of slots) {
    if (slot.ideal) {
      places.push({ anchor: anchors, gap: -1, ordinal: 0 });
      anchors++;
    } else {
      const gap = anchors;
      const ordinal = extra[gap] ?? 0;
      extra[gap] = ordinal + 1;
      places.push({ anchor: -1, gap, ordinal });
    }
  }
  return { places, anchors, extra };
}

/** Lay every run out against one column axis.
 *
 * Runs are given in the order they should be drawn; the plan's `at` follows
 * the same order. */
export function planColumns(runs: readonly (readonly Slot[])[]): ColumnPlan {
  const placed = runs.map(placeRun);

  /* One column per target character, however many runs there are and whatever
     any of them did with it. */
  const anchors = placed.reduce((a, r) => Math.max(a, r.anchors), 0);

  /* An interstice is as wide as the most any single run put in it — not the
     sum, which would give every run its own lane and align nothing. */
  const widest: number[] = [];
  for (const run of placed) {
    run.extra.forEach((n, gap) => {
      widest[gap] = Math.max(widest[gap] ?? 0, n ?? 0);
    });
  }

  const columns: Column[] = [];
  /** Where interstice k's columns begin, and where anchor k's column is. */
  const gapStart: number[] = [];
  const anchorAt: number[] = [];
  for (let k = 0; k <= anchors; k++) {
    gapStart[k] = columns.length;
    for (let n = 0; n < (widest[k] ?? 0); n++) columns.push({ ideal: -1 });
    if (k < anchors) {
      anchorAt[k] = columns.length;
      columns.push({ ideal: k });
    }
  }

  const at = placed.map((run) =>
    run.places.map((p) =>
      p.anchor >= 0 ? anchorAt[p.anchor]! : gapStart[p.gap]! + p.ordinal,
    ),
  );

  return { columns, at };
}
