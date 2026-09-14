import { describe, expect, it } from "vitest";
import { CHAR_TO_MORSE } from "@/morse";
import { compareText, idealTimeline, pair, targetTiming } from "@/timing";

/* Two names for one pattern.
 *
 * `-...-` is both `=` and `<BT>`; `.-.-.` is both `+` and `<AR>`. A sender
 * keying either name of a pair sends exactly the same dits and dahs, so the
 * decode can only ever come back as whichever name the table picks — and
 * comparing the two names as text reported a substitution for sending
 * precisely what was asked for.
 */
describe("characters that share a pattern", () => {
  const pairs: Array<[string, string]> = [
    ["<BT>", "="],
    ["+", "<AR>"],
    ["&", "<AS>"],
  ];

  it("really are the same keying", () => {
    // The premise. If these ever stop sharing a pattern the rest is moot.
    for (const [a, b] of pairs) {
      expect(CHAR_TO_MORSE[a]).toBe(CHAR_TO_MORSE[b]);
    }
  });

  it("compare equal, in both directions", () => {
    for (const [a, b] of pairs) {
      expect(compareText(a, b).accuracy).toBe(1);
      expect(compareText(b, a).accuracy).toBe(1);
      expect(compareText(a, b).substitutions).toBe(0);
    }
  });

  it("do not turn a real error into a match", () => {
    /* The fix must not make everything equal. A character that shares no
       pattern is still a substitution. */
    const got = compareText("<BT>", "A");
    expect(got.substitutions).toBe(1);
    expect(got.accuracy).toBeLessThan(1);
  });

  it("keep their own spelling in the report", () => {
    /* Comparison is normalized; display is not. Somebody who typed <BT> is
       shown <BT>, because that is what they meant. */
    const got = compareText("CQ <BT> DE", "CQ = DE");
    expect(got.expected).toContain("<BT>");
    expect(got.decoded).toContain("=");
    expect(got.accuracy).toBe(1);
  });

  it("pair without reporting a substitution on the chart", () => {
    /* The other half: the per-character pairing runs through the same
       aligner, so the chart and the accuracy figure cannot disagree. */
    const ref = targetTiming(20, 20);
    const ideal = idealTimeline("<BT>", ref);
    const actual = idealTimeline("=", ref);
    const slots = pair(actual, ideal);
    expect(slots.map((s) => s.op)).toEqual(["equal"]);
  });
});
