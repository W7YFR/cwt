/* Suggested replies: a whole QSO worked from the hints alone ends, in every
 * format and every length. */

import { describe, expect, it } from "vitest";
import { newQso } from "@/qso/cq";
import { FORMAT_IDS } from "@/qso/formats";
import { hint, meOf, type Me } from "@/qso/hint";
import { isRun, respond, type AnyQso, type RunContext } from "@/qso/run";

const ME: Me = { call: "W7YFR", name: "ROB", qth: "PORTLAND OR", region: "OR", nr: "" };

/** A fixed sequence, so each station is the same every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Send each hint until the QSO ends. Returns how many overs it took, or
 *  fails after `most`. */
function workFromHints(first: AnyQso, context: RunContext, me: Me, most = 12): { overs: number; qso: AnyQso } {
  let qso = first;
  for (let n = 1; n <= most; n++) {
    const turn = respond(qso, hint(qso, me), context);
    if (turn.ended) return { overs: n, qso: turn.qso };
    expect(turn.reply, `an answer to "${hint(qso, me)}"`).not.toBeNull();
    qso = turn.qso;
  }
  throw new Error(`no end after ${most} overs`);
}

describe("a QSO worked from the hints", () => {
  it("ends, for a rag chew of each length", () => {
    for (const length of ["full", "short", "pieces"] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const rand = seeded(seed);
        const { qso } = workFromHints(newQso(rand), { rand, hour: 10, length, region: "OR" }, ME);
        expect(isRun(qso)).toBe(false);
      }
    }
  });

  it("ends, for each format, with a CWops number and without", () => {
    for (const format of FORMAT_IDS) {
      for (const me of [ME, { ...ME, nr: "3001" }]) {
        for (let seed = 1; seed <= 20; seed++) {
          const rand = seeded(seed);
          // The hint for a fresh page is a plain CQ; a run's CQ names it.
          const start = respond(newQso(rand), `CQ ${format.toUpperCase()} ${me.call}`, { rand, region: "OR" }).qso;
          const { qso } = workFromHints(start, { rand, hour: 10, region: "OR" }, me);
          expect(isRun(qso) && qso.format).toBe(format);
        }
      }
    }
  });

  it("starts with the CQ of the kind asked for", () => {
    const fresh = newQso(seeded(1));
    expect(hint(fresh, ME)).toBe("CQ CQ DE W7YFR W7YFR K");
    expect(hint(fresh, ME, "pota")).toBe("CQ POTA DE W7YFR");
    expect(hint(fresh, ME, "cwt")).toBe("CQ CWT W7YFR");
  });

  it("answers what the station asked for", () => {
    const rand = seeded(3);
    let qso = respond(newQso(rand), "CQ MST W7YFR", { rand }).qso;
    qso = respond(qso, `${qso.them.call} 12`, { rand }).qso;
    expect(qso.last).toBe("NAME?");
    expect(hint(qso, ME)).toBe("ROB ROB");
  });
});

describe("you, as the hints send you", () => {
  it("fills what User leaves empty with a note", () => {
    expect(meOf({ callsign: "", name: "", qthCity: "", qthRegionShort: "", cwopsNumber: "" })).toEqual({
      call: "(YOUR CALL)",
      name: "(YOUR NAME)",
      qth: "(YOUR QTH)",
      region: "(YOUR STATE)",
      nr: "",
    });
    expect(meOf({ callsign: "W7YFR", name: "ROB", qthCity: "PORTLAND", qthRegionShort: "OR", cwopsNumber: "3001" })).toEqual({
      ...ME,
      nr: "3001",
    });
  });
});
