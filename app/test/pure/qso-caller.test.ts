/* When the next station calls in a run: Immediate, Varied or Uncertain. */

import { describe, expect, it } from "vitest";
import { seeded } from "@/audio/qsb";
import { IMMEDIATE_SEC, NOBODY_SHARE, QUICK_SEC, SLOW_SEC, SLOW_SHARE, whenNext, type NextCaller } from "@/qso/caller";

/** `n` draws for `when`, from one seeded rand. */
function draws(when: NextCaller, n = 2000, seed = 7) {
  const rand = seeded(seed);
  return Array.from({ length: n }, () => whenNext(when, rand));
}

describe("whenNext", () => {
  it("Immediate: a station always calls, within the same few seconds", () => {
    const all = draws("immediate");
    expect(all.every((d) => d.calls)).toBe(true);
    expect(all.every((d) => d.sec >= IMMEDIATE_SEC[0] && d.sec <= IMMEDIATE_SEC[1])).toBe(true);
  });

  it("Varied: a station always calls, mostly quick, now and then after a pause", () => {
    const all = draws("varied");
    expect(all.every((d) => d.calls)).toBe(true);
    expect(all.every((d) => d.sec >= QUICK_SEC[0] && d.sec <= SLOW_SEC[1])).toBe(true);
    const slow = all.filter((d) => d.sec > QUICK_SEC[1]).length / all.length;
    expect(slow).toBeGreaterThan(SLOW_SHARE - 0.05);
    expect(slow).toBeLessThan(SLOW_SHARE + 0.05);
    // Some come almost at once, some long after.
    expect(Math.min(...all.map((d) => d.sec))).toBeLessThan(1);
    expect(Math.max(...all.map((d) => d.sec))).toBeGreaterThan(SLOW_SEC[1] - 0.5);
  });

  it("Uncertain: now and then nobody calls, and the rest are as Varied", () => {
    const all = draws("uncertain");
    const nobody = all.filter((d) => !d.calls);
    expect(nobody.length / all.length).toBeGreaterThan(NOBODY_SHARE - 0.05);
    expect(nobody.length / all.length).toBeLessThan(NOBODY_SHARE + 0.05);
    // With nobody to call, the wait is as long as the longest pause.
    expect(nobody.every((d) => d.sec === SLOW_SEC[1])).toBe(true);
    const calls = all.filter((d) => d.calls);
    expect(calls.every((d) => d.sec >= QUICK_SEC[0] && d.sec <= SLOW_SEC[1])).toBe(true);
  });

  it("draws the same from the same seed", () => {
    expect(draws("uncertain", 50, 3)).toEqual(draws("uncertain", 50, 3));
  });
});
