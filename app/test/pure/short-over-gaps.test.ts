/* A short over has few gaps between characters. Its character gaps can
 * split into two small clusters, neither one common enough to be the
 * character gap. They are one class, and the word gaps stay word gaps. */

import { describe, expect, it } from "vitest";
import { estimateTiming } from "@/timing";
import { CHAR_TO_MORSE } from "@/morse";
import type { Segment } from "@/types";

/** Characters keyed at 25 wpm, each with the gap before it in seconds. */
function keyed(chars: readonly (readonly [string, number])[]): Segment[] {
  const segs: Segment[] = [[0, 0.5]];
  for (const [ch, gap] of chars) {
    if (segs.length > 1) segs.push([0, gap]);
    CHAR_TO_MORSE[ch]!.split("").forEach((sym, i) => {
      if (i > 0) segs.push([0, 0.051]);
      segs.push([1, sym === "-" ? 0.143 : 0.046]);
    });
  }
  segs.push([0, 0.5]);
  return segs;
}

describe("a short over", () => {
  it("reads BK TU 73 EE with its word gaps as word gaps", () => {
    // The gaps of an over keyed as BK TU 73 EE, as measured.
    const segs = keyed([
      ["B", 0], ["K", 0.266], ["T", 0.621], ["U", 0.326], ["7", 0.658], ["3", 0.546], ["E", 0.559], ["E", 0.342],
    ]);
    const t = estimateTiming(segs);
    expect(t.charWordSplit).toBeGreaterThan(0.342);
    expect(t.charWordSplit).toBeLessThan(0.621);
    expect(t.farnsworthWpm).toBeGreaterThan(15);
  });
});
