/* The order the attempts are drawn in.
 *
 * Checked against real reviews rather than hand-made numbers: what "most
 * consistent" comes to is whatever the grader says, and a fixture with a
 * quality score written into it would be a test of arithmetic I invented.
 */

import { describe, expect, it } from "vitest";
import { recentCount, runOrder, type RunSort } from "@/ui/runOrder";
import { caseNamed, reviewFrom, CLEAN, FARNSWORTH, SLOPPY } from "../fixture";
import type { Review } from "@/types";

const TARGET = "CQ DE W7YFR";

/** Three attempts at one message, which grade differently. */
function session(): Review[] {
  return [SLOPPY, CLEAN, FARNSWORTH].map(
    (name) =>
      reviewFrom(caseNamed(name), {
        expected: TARGET,
        charWpm: 20,
        farnsworthWpm: 20,
      }).review,
  );
}

const consistency = (r: Review) => r.analysis.withinTolFrac;

describe("the order the attempts are drawn in", () => {
  it("leaves them as recorded, oldest first", () => {
    expect(runOrder(session(), "oldest")).toEqual([0, 1, 2]);
  });

  it("puts the latest attempt at the top", () => {
    expect(runOrder(session(), "newest")).toEqual([2, 1, 0]);
  });

  it("sorts best and worst as exact opposites", () => {
    const runs = session();
    expect(runOrder(runs, "worst")).toEqual([...runOrder(runs, "best")].reverse());
  });

  it("puts the most consistent attempt first, and the least last", () => {
    const runs = session();
    const order = runOrder(runs, "best");
    const scores = order.map((i) => consistency(runs[i]!));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it("never loses or repeats an attempt, whatever the order", () => {
    /* A row for every attempt and every attempt on a row: an order that
       dropped one would hide a recording, and one that repeated an index would
       draw the same attempt twice under two different names. */
    const runs = session();
    for (const sort of ["oldest", "newest", "best", "worst"] as RunSort[]) {
      const order = runOrder(runs, sort);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    }
  });

  it("keeps recording order between attempts that graded the same", () => {
    /* Identical runs must not swap places on a redraw — the rows would shuffle
       under the pointer for no reason the operator could see. */
    const one = session()[0]!;
    const same = [one, one, one];
    expect(runOrder(same, "best")).toEqual([0, 1, 2]);
    expect(runOrder(same, "worst")).toEqual([0, 1, 2]);
  });

  it("has an order for a session with one attempt, or none", () => {
    expect(runOrder([], "best")).toEqual([]);
    expect(runOrder([session()[0]!], "newest")).toEqual([0]);
  });
});

describe("how many of them are drawn", () => {
  it("counts back from the newest, or asks for all of them", () => {
    /* The window is always a tail — nothing is ever left out of the middle —
       so how long a tail is the whole of the answer. */
    expect(recentCount("all")).toBeNull();
    expect(recentCount("last")).toBe(1);
    expect(recentCount("last5")).toBe(5);
  });

  it("asks for more than a short session has, rather than for a special case", () => {
    /* Three attempts under "last 5" is those three. A count that clamped
       itself would need a second answer for what the window is anchored on,
       and there is only one: the newest. */
    const runs = session();
    const want = recentCount("last5")!;
    expect(runs.length).toBeLessThan(want);
    expect(runs.slice(Math.max(runs.length - want, 0))).toEqual(runs);
  });
});
