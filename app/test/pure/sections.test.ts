/* Taking one continuous recording apart into the drills it contains.
 *
 * The point of this is that somebody can press record once, key the whole
 * sequence with a few seconds of quiet between the parts, and stop — rather
 * than starting and stopping six times. So the classification has to stand on
 * its own: no order is assumed, and a section is identified by what is in it.
 */

import { describe, expect, it } from "vitest";
import { pairDrills, splitSections, separatorSec, MIN_SEPARATOR_SEC } from "@/dsp/sections";

const RATE = 8000;
const TONE = 600;

/** Render a pattern of (keyed, seconds) runs as a tone.
 *
 * The keying ramps are centered on the boundaries rather than laid inside the
 * mark, which is how a symmetric filter really blurs an edge — half the
 * transition each side of the instant the key moved. Putting the whole ramp
 * inside would make every mark measure short by construction, and the test
 * would then be asserting its own arithmetic. */
function render(plan: ReadonlyArray<readonly [boolean, number]>, rate = RATE): Float32Array {
  const n = plan.reduce((a, [, d]) => a + Math.round(d * rate), 0);
  const env = new Float32Array(n);
  const ramp = Math.max(2, Math.round(0.005 * rate));
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  let at = 0;
  for (const [on, dur] of plan) {
    const span = Math.round(dur * rate);
    if (on) {
      for (let i = -ramp; i < span + ramp; i++) {
        const idx = at + i;
        if (idx < 0 || idx >= n) continue;
        const up = clamp(0.5 + i / ramp);
        const down = clamp(0.5 + (span - i) / ramp);
        env[idx] = Math.max(env[idx]!, Math.min(up, down));
      }
    }
    at += span;
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = env[i]! * Math.sin((2 * Math.PI * TONE * i) / rate);
  return out;
}

/** `count` elements of `markSec`, each followed by `gapSec`. */
function drill(markSec: number, gapSec: number, count: number) {
  const plan: Array<readonly [boolean, number]> = [];
  for (let i = 0; i < count; i++) {
    plan.push([true, markSec]);
    plan.push([false, gapSec]);
  }
  return plan;
}

const quiet = (sec: number): ReadonlyArray<readonly [boolean, number]> => [[false, sec]];

describe("finding the sections", () => {
  it("splits a recording wherever the quiet runs long", () => {
    const samples = render([
      ...quiet(4),
      ...drill(0.08, 0.08, 12),
      ...quiet(5),
      ...drill(0.24, 0.08, 8),
      ...quiet(4),
    ]);
    const secs = splitSections(samples, RATE, { toneHz: TONE });
    expect(secs.map((s) => s.kind)).toEqual(["silence", "uniform", "silence", "uniform", "silence"]);
  });

  it("does not split on the gaps inside a drill", () => {
    // The failure that would matter most: every element becoming its own
    // section. The separator has to be longer than anything a drill contains.
    const secs = splitSections(render(drill(0.08, 0.08, 30)), RATE, { toneHz: TONE });
    expect(secs.filter((s) => s.kind !== "silence").length).toBe(1);
  });

  it("does not split isolated elements two seconds apart", () => {
    // The widest gap any drill is asked for, and still one section.
    const secs = splitSections(render(drill(0.08, 2, 6)), RATE, { toneHz: TONE });
    const keyed = secs.filter((s) => s.kind !== "silence");
    expect(keyed.length).toBe(1);
    expect(keyed[0]!.marks.length).toBe(6);
  });

  it("reports where each section sits in the recording", () => {
    const samples = render([...quiet(4), ...drill(0.08, 0.08, 12), ...quiet(5)]);
    const drillSec = splitSections(samples, RATE, { toneHz: TONE }).find((s) => s.kind === "uniform")!;
    expect(drillSec.startSec).toBeGreaterThan(3.5);
    expect(drillSec.startSec).toBeLessThan(4.5);
    expect(drillSec.from).toBeLessThan(drillSec.to);
    expect(drillSec.to).toBeLessThanOrEqual(samples.length);
  });
});

describe("saying what is in each section", () => {
  it("calls a held paddle uniform", () => {
    for (const mark of [0.08, 0.24]) {
      const secs = splitSections(render(drill(mark, 0.08, 15)), RATE, { toneHz: TONE });
      expect(secs.find((s) => s.kind !== "silence")!.kind, `${mark}s elements`).toBe("uniform");
    }
  });

  it("calls elements of two different lengths mixed", () => {
    // Iambic: dit, dah, dit, dah.
    const plan: Array<readonly [boolean, number]> = [];
    for (let i = 0; i < 10; i++) {
      plan.push([true, 0.08], [false, 0.08], [true, 0.24], [false, 0.08]);
    }
    const secs = splitSections(render(plan), RATE, { toneHz: TONE });
    expect(secs.find((s) => s.kind !== "silence")!.kind).toBe("mixed");
  });

  it("tells single elements apart from a held paddle", () => {
    // Same element, same length; only the spacing differs.
    const held = splitSections(render(drill(0.08, 0.08, 15)), RATE, { toneHz: TONE });
    const single = splitSections(render(drill(0.08, 2, 6)), RATE, { toneHz: TONE });
    expect(held.find((s) => s.kind !== "silence")!.kind).toBe("uniform");
    expect(single.find((s) => s.kind !== "silence")!.kind).toBe("isolated");
  });

  it("calls quiet quiet", () => {
    const secs = splitSections(render(quiet(8)), RATE, { toneHz: TONE });
    expect(secs.every((s) => s.kind === "silence")).toBe(true);
  });

  it("measures the elements it found", () => {
    const secs = splitSections(render(drill(0.24, 0.08, 12)), RATE, { toneHz: TONE });
    const d = secs.find((s) => s.kind === "uniform")!;
    expect(d.marks.length).toBe(12);
    expect(d.medianMarkSec).toBeCloseTo(0.24, 2);
    expect(d.medianGapSec).toBeCloseTo(0.08, 2);
  });
});

describe("picking the two drills out", () => {
  const both = () =>
    splitSections(
      render([
        ...quiet(4),
        ...drill(0.08, 0.08, 15),
        ...quiet(5),
        ...drill(0.24, 0.08, 10),
        ...quiet(4),
      ]),
      RATE,
      { toneHz: TONE },
    );

  it("takes the shorter as dits and the longer as dahs", () => {
    const { dits, dahs } = pairDrills(both());
    expect(dits!.medianMarkSec).toBeCloseTo(0.08, 2);
    expect(dahs!.medianMarkSec).toBeCloseTo(0.24, 2);
  });

  it("does not care which order they were recorded in", () => {
    const reversed = splitSections(
      render([
        ...quiet(4),
        ...drill(0.24, 0.08, 10),
        ...quiet(5),
        ...drill(0.08, 0.08, 15),
        ...quiet(4),
      ]),
      RATE,
      { toneHz: TONE },
    );
    const { dits, dahs } = pairDrills(reversed);
    expect(dits!.medianMarkSec).toBeCloseTo(0.08, 2);
    expect(dahs!.medianMarkSec).toBeCloseTo(0.24, 2);
  });

  it("refuses to call two similar drills a dit drill and a dah drill", () => {
    // Somebody who held the dit paddle twice has not given a dah drill, and
    // pretending otherwise would produce a calibration from nonsense.
    const twice = splitSections(
      render([...quiet(4), ...drill(0.08, 0.08, 15), ...quiet(5), ...drill(0.09, 0.08, 15), ...quiet(4)]),
      RATE,
      { toneHz: TONE },
    );
    expect(pairDrills(twice).dahs).toBeNull();
  });

  it("has nothing to offer when there are no drills at all", () => {
    const { dits, dahs } = pairDrills(splitSections(render(quiet(8)), RATE, { toneHz: TONE }));
    expect(dits).toBeNull();
    expect(dahs).toBeNull();
  });

  it("ignores the mixed sections when choosing", () => {
    // A message in the same recording must not be mistaken for a drill.
    const plan: Array<readonly [boolean, number]> = [...quiet(4), ...drill(0.08, 0.08, 15), ...quiet(5)];
    for (let i = 0; i < 8; i++) plan.push([true, 0.08], [false, 0.08], [true, 0.24], [false, 0.08]);
    plan.push(...quiet(5), ...drill(0.24, 0.08, 10), ...quiet(4));
    const { dits, dahs } = pairDrills(splitSections(render(plan), RATE, { toneHz: TONE }));
    expect(dits!.medianMarkSec).toBeCloseTo(0.08, 2);
    expect(dahs!.medianMarkSec).toBeCloseTo(0.24, 2);
  });
});

describe("the separator", () => {
  it("is measured from the recording rather than fixed", () => {
    // The gaps a real calibration take actually contained: separators of 2.8,
    // 2.1 and 1.9 seconds, and ordinary spacing of half a second. The break is
    // between those two populations, wherever they happen to fall.
    expect(separatorSec([0.08, 0.08, 0.24, 0.55, 0.56, 1.86, 1.99, 2.12, 2.78]))
      .toBeGreaterThan(0.56);
    expect(separatorSec([0.08, 0.08, 0.24, 0.55, 0.56, 1.86, 1.99, 2.12, 2.78]))
      .toBeLessThan(1.86);
  });

  it("adapts to a recording whose separators are much wider", () => {
    const sep = separatorSec([0.08, 0.08, 0.5, 5.0, 5.2, 6.1]);
    expect(sep).toBeGreaterThan(0.5);
    expect(sep).toBeLessThan(5.0);
  });

  it("finds no separator in a recording that is all one piece", () => {
    // Ordinary sending with no pauses must not be chopped up.
    expect(separatorSec([0.08, 0.08, 0.09, 0.24, 0.25, 0.56])).toBe(Infinity);
  });

  it("never treats ordinary word spacing as a separator", () => {
    expect(MIN_SEPARATOR_SEC).toBeGreaterThan(0.6);
  });

  it("handles an empty recording", () => {
    expect(splitSections(new Float32Array(0), RATE, { toneHz: TONE })).toEqual([]);
  });
});
