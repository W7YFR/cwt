/* Readouts that have to hold still.
 *
 * Every one of these sits in a row of other things, and a field that changes
 * width when its number gains a digit drags everything beside it sideways. On
 * a slider that reads as a twitch; on a clock that ticks ten times a second it
 * is constant. Padding is what stops it, so these check the padding rather
 * than the formatting.
 */

import { describe, expect, it } from "vitest";
import { fmtElapsed, fmtGain, fmtPpu, fmtTolerance, fmtWpm } from "@/ui/format";

describe("the recording clock", () => {
  it("is the same width from the first tenth to the last", () => {
    // Crossing ten seconds adds a character, which would shift the level meter
    // and the stop button along with it, mid-recording.
    const widths = new Set(
      [0, 0.1, 9.9, 10, 59.9, 99.9, 100, 299.9].map((t) => fmtElapsed(t).length),
    );
    expect(widths.size).toBe(1);
  });

  it("covers the recorder's whole range without overflowing the field", () => {
    // DEFAULT_MAX_SECONDS is 300, so five characters is exactly enough; a
    // sixth would mean the field grows at the one moment it must not.
    expect(fmtElapsed(300).trim()).toBe("300.0s");
    expect(fmtElapsed(0)).toBe("  0.0s");
    expect(fmtElapsed(7.25)).toBe("  7.3s");
  });
});

describe("the control readouts", () => {
  it("each keep a constant width across their own range", () => {
    const constant = (f: (v: number) => string, values: number[]) =>
      new Set(values.map((v) => f(v).length)).size;

    expect(constant(fmtWpm, [5, 9, 10, 45])).toBe(1);
    expect(constant(fmtTolerance, [0.05, 0.09, 0.1, 0.6])).toBe(1);
    // A gain reading is signed, which is the character that catches people out.
    expect(constant(fmtGain, [-6, -1, 0, 9, 42])).toBe(1);
    expect(constant(fmtPpu, [4, 9.5, 12, 18.9])).toBe(1);
  });
});
