/* The column axis several attempts share.
 *
 * Driven off real pairings rather than hand-built slots wherever it can be:
 * what the alignment does with a dropped letter is the whole input to this,
 * and a slot list written by hand would be a guess about it.
 */

import { describe, expect, it } from "vitest";
import { planColumns } from "@/render/columns";
import { buildLayout, measureColumns } from "@/render/layout";
import { buildTimeline, idealTimeline, pair, targetTiming } from "@/timing";
import type { Char, Slot } from "@/types";
import { caseNamed, CLEAN, reviewFrom, SLOPPY } from "../fixture";
import { oracleSegments } from "../oracle";

const REF = targetTiming(20, 20);
const TARGET = "CQ DE W7YFR";

/** A pairing of one oracle recording against the target above. */
function runOf(name: string): Slot[] {
  return pair(buildTimeline(oracleSegments(caseNamed(name)), REF), idealTimeline(TARGET, REF));
}

/** Slots standing in for a run: a string where "." is a dropped character and
 *  "+" is one keyed that the target has no place for. */
function fake(shape: string): Slot[] {
  const ch = (c: string): Char => ({
    char: c,
    pattern: "",
    t0: 0,
    t1: 0,
    blocks: [],
    leadGap: null,
  });
  return [...shape].map((c) =>
    c === "+"
      ? { op: "ins" as const, actual: ch("X"), ideal: null, spaceOp: null }
      : c === "."
        ? { op: "del" as const, actual: null, ideal: ch(c), spaceOp: null }
        : { op: "equal" as const, actual: ch(c), ideal: ch(c), spaceOp: null },
  ) as Slot[];
}

describe("the shared column axis", () => {
  it("gives the target one column per character", () => {
    const ideal = idealTimeline(TARGET, REF);
    const plan = planColumns([runOf(SLOPPY)]);
    const anchors = plan.columns.filter((c) => c.ideal >= 0);
    expect(anchors).toHaveLength(ideal.chars.length);
    // In order, and numbered by the target rather than by where they landed.
    expect(anchors.map((c) => c.ideal)).toEqual(anchors.map((_, i) => i));
  });

  it("puts two different attempts at the same message in the same columns", () => {
    /* The point of the whole module. These two recordings decode differently
       — that is what the fixtures are for — and they still have to line up. */
    const a = runOf(SLOPPY);
    const b = runOf(CLEAN);
    const plan = planColumns([a, b]);

    const columnOfTarget = (run: Slot[], at: readonly number[], i: number) =>
      at[run.findIndex((s) => s.ideal === run.filter((x) => x.ideal)[i]!.ideal)]!;

    const targets = a.filter((s) => s.ideal).length;
    for (let i = 0; i < targets; i++) {
      expect(columnOfTarget(a, plan.at[0]!, i)).toBe(columnOfTarget(b, plan.at[1]!, i));
    }
  });

  it("leaves a hole rather than shifting what follows, when a run drops one", () => {
    /* The failure this exists to prevent: run 2 is short one character, and
       without a shared axis everything after it would slide left by a column
       and stop lining up with run 1. */
    const full = fake("ABCD");
    const dropped = fake("AB.D");
    const plan = planColumns([full, dropped]);

    expect(plan.at[0]).toEqual(plan.at[1]);
    expect(plan.columns).toHaveLength(4);
  });

  it("opens an interstice for a character the target has no place for", () => {
    const plan = planColumns([fake("AB"), fake("A+B")]);
    expect(plan.columns.map((c) => c.ideal)).toEqual([0, -1, 1]);
    // The run that keyed nothing extra simply has nothing in that column.
    expect(plan.at[0]).toEqual([0, 2]);
    expect(plan.at[1]).toEqual([0, 1, 2]);
  });

  it("makes an interstice as wide as the most any one run put in it", () => {
    /* The most, not the total: summing would give every run its own lane and
       the extras would never sit above each other. */
    const plan = planColumns([fake("A++B"), fake("A+B"), fake("AB")]);
    expect(plan.columns.map((c) => c.ideal)).toEqual([0, -1, -1, 1]);
    expect(plan.at[0]).toEqual([0, 1, 2, 3]);
    expect(plan.at[1]).toEqual([0, 1, 3]);
    expect(plan.at[2]).toEqual([0, 3]);
  });

  it("keeps interstices apart when they fall between different characters", () => {
    const plan = planColumns([fake("A+BC"), fake("AB+C")]);
    expect(plan.columns.map((c) => c.ideal)).toEqual([0, -1, 1, -1, 2]);
    expect(plan.at[0]).toEqual([0, 1, 2, 4]);
    expect(plan.at[1]).toEqual([0, 2, 3, 4]);
  });

  it("handles an extra keyed after the last character of the target", () => {
    const plan = planColumns([fake("AB"), fake("AB+")]);
    expect(plan.columns.map((c) => c.ideal)).toEqual([0, 1, -1]);
    expect(plan.at[1]).toEqual([0, 1, 2]);
  });

  it("has nothing to plan for no runs, or for runs with nothing in them", () => {
    expect(planColumns([])).toEqual({ columns: [], at: [] });
    expect(planColumns([[]])).toEqual({ columns: [], at: [[]] });
  });

  it("gives every slot of every run a column, and never the same one twice", () => {
    /* Two runs may share a column — that is the point — but one run putting
       two of its own characters in one column would draw them on top of each
       other. */
    const runs = [runOf(SLOPPY), runOf(CLEAN), fake("CQ+DE")];
    const plan = planColumns(runs);
    plan.at.forEach((at, r) => {
      expect(at).toHaveLength(runs[r]!.length);
      expect(new Set(at).size).toBe(at.length);
      for (const c of at) expect(plan.columns[c]).toBeDefined();
    });
  });
});

describe("laying runs out against the shared columns", () => {
  const PPU = 12;

  /** Two real recordings graded against ONE message, which is what a session
   *  is: several attempts at the same text. They decode differently — that is
   *  what makes them worth stacking — and CLEAN is not even a recording of
   *  this message, which only makes the alignment work harder. */
  const reviews = () =>
    [SLOPPY, CLEAN].map(
      (name) => reviewFrom(caseNamed(name), { expected: TARGET, charWpm: 20, farnsworthWpm: 20 }).review,
    );

  it("puts a lone run exactly where it was put before there were several", () => {
    /* The whole reason there is one code path rather than two. Measured with
       no shared axis at all, against the axis it measures for itself. */
    const review = reviews()[0]!;
    const bare = buildLayout(review, { view: "per-char", ppu: PPU, durationSec: 10 });
    const cols = measureColumns([review.slots], PPU);
    const shared = buildLayout(review, {
      view: "per-char",
      ppu: PPU,
      durationSec: 10,
      columns: cols,
      run: 0,
    });
    expect(shared.items.map((i) => i.x)).toEqual(bare.items.map((i) => i.x));
    expect(shared.width).toBe(bare.width);
  });

  it("gives two runs the same x for the same target character", () => {
    const [a, b] = reviews() as [ReturnType<typeof reviewFrom>["review"], ReturnType<typeof reviewFrom>["review"]];
    const cols = measureColumns([a.slots, b.slots], PPU);
    const opts = { view: "per-char" as const, ppu: PPU, durationSec: 10, columns: cols };
    const la = buildLayout(a, { ...opts, run: 0 });
    const lb = buildLayout(b, { ...opts, run: 1 });

    /* Walk the target's characters, which both runs hold in order, and check
       each one lands in the same place on both rows. */
    const xsOfTargets = (layout: typeof la) =>
      layout.items.filter((it) => it.slot.ideal).map((it) => it.x);
    expect(xsOfTargets(la)).toEqual(xsOfTargets(lb));
    expect(la.width).toBe(lb.width);
  });

  it("makes every row as wide as the widest thing in each column", () => {
    /* A column has to fit whatever any run put there, or a slow character on
       one row would be drawn over the top of the next column on another. */
    const [a, b] = reviews() as [ReturnType<typeof reviewFrom>["review"], ReturnType<typeof reviewFrom>["review"]];
    const cols = measureColumns([a.slots, b.slots], PPU);
    const alone = [measureColumns([a.slots], PPU), measureColumns([b.slots], PPU)];
    expect(cols.width).toBeGreaterThanOrEqual(Math.max(alone[0]!.width, alone[1]!.width));
  });
});

