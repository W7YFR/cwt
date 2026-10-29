/* Reading word breaks by meaning: a gap near the cut between letters and
 * words goes whichever way makes words. */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readWords, type Spaced } from "@/timing/segment";
import { LiveCopy, sentSymbols } from "@/timing/live";
import { targetTiming } from "@/timing/model";
import { vocabulary } from "@/qso/vocabulary";
import { readWav } from "../wav";

const WORDS = new Set(vocabulary(["W7YFR", "ROB", "WA", "AK3SD"]));

/** Characters with gaps: `|` before a character is a gap of `share` of the
 *  cut, a space a sure word break, nothing a sure letter gap. */
function spaced(text: string, share: number): Spaced[] {
  const out: Spaced[] = [];
  let gap: number | null = null;
  for (const ch of text) {
    if (ch === "|") gap = share;
    else if (ch === " ") gap = 3;
    else {
      out.push({ char: ch, gap: out.length === 0 ? null : (gap ?? 0.4) });
      gap = null;
    }
  }
  return out;
}

describe("a gap near the cut", () => {
  it("breaks where the words say", () => {
    // A short word gap: TU W7YFR, not TUW7YFR.
    expect(readWords(spaced("TU|W7YFR", 0.8), WORDS)).toBe("TU W7YFR");
  });

  it("joins where the words say", () => {
    // Pauses inside a word.
    expect(readWords(spaced("AK|3SD", 1.2), WORDS)).toBe("AK3SD");
    expect(readWords(spaced("R|OB", 1.1), WORDS)).toBe("ROB");
    expect(readWords(spaced("W|A", 1.1), WORDS)).toBe("WA");
  });

  it("keeps a textbook word gap a break, even into the shape of a call", () => {
    const none = new Set(vocabulary([]));
    expect(readWords(spaced("W7YFR|K", 1.4), none)).toBe("W7YFR K");
  });

  it("follows the timing where it knows none of the words", () => {
    expect(readWords(spaced("XQ|ZJ", 1.2), WORDS)).toBe("XQ ZJ");
    expect(readWords(spaced("XQ|ZJ", 0.8), WORDS)).toBe("XQZJ");
  });

  it("never moves a gap well clear of the cut", () => {
    expect(readWords(spaced("W A", 0), WORDS)).toBe("W A");
    expect(readWords(spaced("TUW7YFR", 0), WORDS)).toBe("TUW7YFR");
  });

  it("does not make a call of a turn word and a report", () => {
    expect(readWords(spaced("K|5NN", 1.0), WORDS)).toBe("K 5NN");
  });
});

describe("the author's keying, wide letter gaps and a short word gap", () => {
  it("reads TU W7YFR apart once it knows the words", () => {
    const wav = readWav(join(__dirname, "../data/tu-w7yfr-wide-letters.wav"));
    const timing = targetTiming(25, 20);
    expect(sentSymbols(wav.samples, wav.rate, timing, undefined, true).text).toBe("TA EEETUW7YFR");
    expect(sentSymbols(wav.samples, wav.rate, timing, undefined, true, undefined, WORDS).text).toBe("TA EEETU W7YFR");
  });
});

describe("the live copy, given the words of the QSO", () => {
  it("reads by them with lenient copy, and leaves strict alone", () => {
    const wav = readWav(join(__dirname, "../data/tu-w7yfr-wide-letters.wav"));
    const timing = targetTiming(25, 20);
    const read = (measure: boolean, words?: ReadonlySet<string>) => {
      const copy = new LiveCopy(wav.rate, timing, measure, undefined, words);
      copy.push(wav.samples);
      return copy.step().text;
    };
    expect(read(true, WORDS)).toBe("TA EEETU W7YFR");
    expect(read(true)).toBe("TA EEETUW7YFR");
    // Strict reads at your set speed, and the words change nothing.
    expect(read(false, WORDS)).toBe(read(false));
  });
});
