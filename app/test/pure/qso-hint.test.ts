/* Suggested replies: a whole QSO worked from the hints alone ends, in every
 * format and every length. */

import { describe, expect, it } from "vitest";
import { newQso } from "@/qso/cq";
import { FORMATS, FORMAT_IDS, type FormatId } from "@/qso/formats";
import { hint, meOf, type Me, type Voice } from "@/qso/hint";
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

/** A station's reply that asks for something again: it did not take the
 *  over before it as sent. */
const ASKS_AGAIN = /(^|\s)(\?|AGN\??|CALL\?|UR CALL\?|NAME\?|NR\?|QTH\?|RST\?|MY CALL|CALL IS)(\s|$)/;

/** Work a QSO from the hints in `voice`'s wordings, and fail on any reply
 *  that asks again. Returns the QSO at its end. */
function workWorded(first: AnyQso, context: RunContext, me: Me, voice: Voice, start: FormatId | null): AnyQso {
  let qso = first;
  for (let n = 1; n <= 12; n++) {
    const sent = hint(qso, me, start, voice);
    const turn = respond(qso, sent, context);
    if (turn.reply !== null) expect(turn.reply, `the answer to "${sent}"`).not.toMatch(ASKS_AGAIN);
    if (turn.ended) return turn.qso;
    expect(turn.reply, `an answer to "${sent}"`).not.toBeNull();
    // In a run, its call sent back to an exchange puts a wrong call right.
    if (isRun(qso) && qso.stage === "called") {
      expect(turn.reply, `the answer to "${sent}"`).not.toBe(`${qso.them.call} ${qso.them.call}`);
    }
    qso = turn.qso;
  }
  throw new Error("no end after 12 overs");
}

describe("every wording of the hints", () => {
  const names = ["ROB", "AL", "TOM"];
  // GA is Georgia, and good afternoon.
  const places = [
    { qth: "PORTLAND OR", region: "OR" },
    { qth: "ATLANTA GA", region: "GA" },
  ];

  it("works a rag chew of each length, and the station copies all of you", () => {
    for (const length of ["full", "short", "pieces"] as const) {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = seeded(seed);
        const me: Me = { ...ME, ...places[seed % 2]!, name: names[seed % 3]!, rst: ["599", "579", "559"][seed % 3]! };
        const voice = { rand, hour: seed % 24 };
        const qso = workWorded(newQso(rand), { rand, hour: 10, length, region: me.region }, me, voice, null);
        if (isRun(qso)) throw new Error("a run");
        expect(qso.you).toBe(me.call);
        expect(qso.yourName).toBe(me.name);
        expect(qso.yourReport).toMatch(me.rst === "599" ? /^(599|5NN)$/ : new RegExp(`^${me.rst}$`));
        expect(qso.yourQth).toBe(me.qth);
      }
    }
  });

  it("works a run of each format, and the station copies all of you", () => {
    for (const format of FORMAT_IDS) {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = seeded(seed);
        const me: Me = { ...ME, ...places[seed % 2]!, name: names[seed % 3]!, nr: ["", "3001", "291"][seed % 3]! };
        const voice = { rand, hour: seed % 24 };
        const qso = workWorded(newQso(rand), { rand, hour: 10, region: me.region }, me, voice, format);
        if (!isRun(qso)) throw new Error("a rag chew");
        expect(qso.format).toBe(format);
        const got = qso.got!;
        const yours = FORMATS[format].yours;
        if (yours.includes("name")) expect(got.name).toBe(me.name);
        if (yours.includes("report")) expect(got.report).toBe("5NN");
        if (format === "sst" || format === "pota" || (format === "cwt" && !me.nr)) expect(got.region).toBe(me.region);
        if (format === "cwt" && me.nr) expect(got.number).toBe(me.nr);
        if (format === "mst") expect(got.number).toBe("1");
      }
    }
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
