/* The character speed, when every mark comes out a fixed amount short.
 *
 * The detector shortens every mark by a few milliseconds, on synthesized audio
 * as well as through a microphone, and the silence after it grows by the same
 * amount. A speed read off the mark lengths directly then comes out high: a
 * keyer set to 25 read 27. The difference between a dah and a dit is the same
 * two units at any offset, so the speed must not move with it.
 */

import { describe, expect, it } from "vitest";
import { estimateTiming } from "@/timing";
import { CHAR_TO_MORSE } from "@/morse";
import type { Segment } from "@/types";

/** `text` keyed perfectly at `wpm`, with every mark `offsetSec` short and every
 *  silence after one that much longer. */
function keyed(text: string, wpm: number, offsetSec: number): Segment[] {
  const u = 1.2 / wpm;
  const segs: Segment[] = [[0, 0.5]];
  text.split(" ").forEach((word, w) => {
    [...word].forEach((ch, c) => {
      CHAR_TO_MORSE[ch]!.split("").forEach((sym, e) => {
        const gap = e > 0 ? u : c > 0 ? 3 * u : w > 0 ? 7 * u : 0;
        if (gap > 0) segs.push([0, gap + offsetSec]);
        segs.push([1, (sym === "-" ? 3 : 1) * u - offsetSec]);
      });
    });
  });
  segs.push([0, 0.5]);
  return segs;
}

describe("a fixed offset on every mark", () => {
  it.each([0, 0.003, 0.006, -0.004])("does not move the character speed (%s s)", (offset) => {
    const t = estimateTiming(keyed("HI FROM ROB PARIS", 25, offset), "HI FROM ROB PARIS");
    expect(t.charWpm).toBeCloseTo(25, 6);
  });

  it("reads a recording of dits alone at the speed it was keyed", () => {
    /* No dah to measure against, so the marks are one class and a dit is the
       unit. Two k-means centers on one class sit close together, and their
       difference is nothing like two units. */
    const t = estimateTiming(keyed("IIIII SSSSS HHHHH", 20, 0), "IIIII SSSSS HHHHH");
    expect(t.charWpm).toBeCloseTo(20, 6);
  });
});
