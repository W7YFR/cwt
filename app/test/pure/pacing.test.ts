/* The schedule a paced recording runs on.
 *
 * One target timeline read three ways — where the count-in aims, when each
 * character is due, and when the whole thing is over — and the reason they
 * live together is that three slightly different ideas of "now" is exactly the
 * failure this would have. The cursor, the flash card and the auto-stop all
 * read these, so a disagreement between them would show up as the cue firing
 * on one beat while the cursor arrived on another.
 */

import { describe, expect, it } from "vitest";
import { beatsFor, pacedEnd, pacedStart, wordAt, wordsFor } from "@/ui/pacing";
import { buildTimeline, idealTimeline, targetTiming } from "@/timing";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

const TIMING = targetTiming(15, 15);
/** A real target timeline, built the way the review builds one. */
const IDEAL = reviewFrom(caseNamed(SLOPPY)).review.ideal;
const LEAD = 3;

describe("the paced schedule", () => {
  it("aims the count-in at the first character", () => {
    const first = IDEAL.chars[0]!;
    expect(pacedStart(IDEAL)).toBe(first.leadGap ? first.leadGap.t0 : first.t0);
  });

  it("puts the first character exactly where the count-in ends", () => {
    /* The whole contract between the two: the cursor arrives, the card
       flashes, and the operator keys, all at the same instant. */
    expect(beatsFor(IDEAL, LEAD)[0]!.at).toBeCloseTo(LEAD, 9);
  });

  it("keeps every later character at its own distance into the message", () => {
    const beats = beatsFor(IDEAL, LEAD);
    const from = pacedStart(IDEAL);
    expect(beats).toHaveLength(IDEAL.chars.length);
    beats.forEach((b, i) => {
      const c = IDEAL.chars[i]!;
      expect(b.char).toBe(c.char);
      expect(b.at).toBeCloseTo(LEAD + (c.t0 - from), 9);
    });
    // Strictly increasing, or the card would show characters out of order.
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]!.at).toBeGreaterThan(beats[i - 1]!.at);
    }
  });

  it("moves the whole schedule with the count-in, and nothing else", () => {
    const a = beatsFor(IDEAL, 1);
    const b = beatsFor(IDEAL, 4);
    a.forEach((beat, i) => expect(b[i]!.at - beat.at).toBeCloseTo(3, 9));
  });

  it("ends after the last element, not after the last character's start", () => {
    /* A take cut off halfway through its final dah would be missing the one
       thing it was recorded to measure. */
    const last = IDEAL.chars[IDEAL.chars.length - 1]!;
    const end = pacedEnd(IDEAL, LEAD, 1)!;
    const beats = beatsFor(IDEAL, LEAD);

    expect(end).toBeCloseTo(LEAD + (last.t1 - pacedStart(IDEAL)) + 1, 9);
    // Comfortably past the moment the last character was due to begin.
    expect(end).toBeGreaterThan(beats[beats.length - 1]!.at + 1);
  });

  it("has no schedule at all for a message with nothing in it", () => {
    // Nothing to pace, nothing to stop — the aids simply do not arm.
    const empty = buildTimeline([], TIMING);
    expect(pacedStart(empty)).toBe(0);
    expect(beatsFor(empty, LEAD)).toEqual([]);
    expect(pacedEnd(empty, LEAD, 1)).toBeNull();
  });
});

describe("the target split into words", () => {
  /* Built from text so the words under test are the ones written down, rather
     than whatever a sloppy recording's gaps happened to come out as. */
  const words = (text: string) =>
    wordsFor(idealTimeline(text, TIMING)).map((w) => w.chars.join(""));

  it("breaks where the message has spaces", () => {
    expect(words("CQ DE W7YFR")).toEqual(["CQ", "DE", "W7YFR"]);
  });

  it("makes one word of a message with no spaces in it", () => {
    expect(words("PARIS")).toEqual(["PARIS"]);
  });

  it("has nothing to split when there is no message", () => {
    const empty = buildTimeline([], TIMING);
    expect(wordsFor(empty)).toEqual([]);
    // And nothing to point at either, rather than a word index of zero that
    // the card would then try to spell.
    expect(wordAt([], 0)).toBe(-1);
  });

  it("covers every character exactly once, in order", () => {
    /* The card indexes beats by position, so a gap or an overlap here would
       green the wrong letters rather than fail visibly. */
    const ideal = idealTimeline("CQ DE W7YFR", TIMING);
    const got = wordsFor(ideal);
    let next = 0;
    for (const w of got) {
      expect(w.from).toBe(next);
      expect(w.to - w.from).toBe(w.chars.length);
      next = w.to;
    }
    expect(next).toBe(ideal.chars.length);
  });

  it("finds the word a character falls in", () => {
    const got = wordsFor(idealTimeline("CQ DE", TIMING));
    expect(wordAt(got, 0)).toBe(0);
    expect(wordAt(got, 1)).toBe(0);
    expect(wordAt(got, 2)).toBe(1);
  });

  it("stays on the last word once every character has been sent", () => {
    /* Past the end is not "no word": the word you just finished is still the
       one you were on, and blanking it at the final letter would take the
       preview away exactly as it completes. */
    const got = wordsFor(idealTimeline("CQ DE", TIMING));
    expect(wordAt(got, 4)).toBe(1);
    expect(wordAt(got, 99)).toBe(1);
  });
});
