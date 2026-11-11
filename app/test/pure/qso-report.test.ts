/* The exchange at the end of a QSO, both ways. */

import { describe, expect, it } from "vitest";
import { answer, newQso, type Qso } from "@/qso/cq";
import { exchangeReport, itemLabels, theirItems, type Meant, type TheirLine } from "@/qso/report";
import { answerRun, callIn, newRun, type RunQso } from "@/qso/run";
import type { Station } from "@/qso/station";

const JIM: Station = { call: "K4ABC", name: "JIM", qth: "ATLANTA GA", rst: "579", toneHz: 600, nr: "2345", serial: 23 };
const ME: Meant = { call: "W7YFR", name: "ROB", qth: "PORTLAND OR", region: "OR", nr: "" };
const FIRST = { rand: () => 0, hour: 20 };

/** The rows as label: sent > copied, with ✗ for a wrong one. */
const shown = (rows: ReturnType<typeof exchangeReport>) =>
  rows.map((r) => `${r.from} ${r.label}: ${r.sent} > ${r.copied ?? "-"}${r.ok === false ? " ✗" : ""}`);

describe("a standard QSO's report", () => {
  const worked = (): Qso => {
    let q: Qso = { ...newQso(() => 0), them: JIM };
    for (const o of ["CQ CQ DE W7YFR K", "K4ABC DE W7YFR UR 599 NAME BOB QTH PORTLAND OR K"]) {
      q = answer(q, o, { ...FIRST, length: "short" }).qso;
    }
    return q;
  };

  it("shows your copy of each of its items, and its copy of each of yours", () => {
    const lines: TheirLine[] = [
      { text: "DE K4ABC K", typed: "de k4abc k" },
      { text: "W7YFR DE K4ABC R UR 579 NAME JIM QTH ATLANTA GA KN", typed: "w7yfr de k4abc r ur 579 name jin qth atlanta ga kn" },
    ];
    expect(shown(exchangeReport(worked(), lines, ME))).toEqual([
      "them Call: K4ABC > K4ABC",
      "them Report: 579 > 579",
      "them Name: JIM > JIN ✗",
      "them QTH: ATLANTA GA > ATLANTA GA",
      "you Call: W7YFR > W7YFR",
      "you Report:  > 599",
      "you Name: ROB > BOB ✗",
      "you QTH: PORTLAND OR > PORTLAND OR",
    ]);
  });

  it("has no copy of its items when its lines were not for copying", () => {
    const rows = exchangeReport(worked(), [{ text: "DE K4ABC K", typed: null }], ME);
    expect(rows.filter((r) => r.from === "them").every((r) => r.copied === null && r.ok === null)).toBe(true);
  });

  it("shows nothing to check for an item the station never sent", () => {
    const rows = exchangeReport(worked(), [{ text: "DE K4ABC K", typed: "de k4abc k" }], ME);
    expect(rows.find((r) => r.from === "them" && r.label === "Name")).toMatchObject({ sent: "", copied: null, ok: null });
  });

  it("takes a copy you typed over an empty one of the same item", () => {
    const rows = exchangeReport(
      worked(),
      [
        { text: "K4ABC K4ABC", typed: "k4abd" },
        { text: "K4ABC K4ABC", typed: "" },
      ],
      ME,
    );
    expect(rows.find((r) => r.from === "them" && r.label === "Call")).toMatchObject({ copied: "K4ABD", ok: false });
  });

  it("marks an item you left out as missed", () => {
    const rows = exchangeReport(worked(), [{ text: "UR 579 NAME JIM", typed: "ur 579" }], ME);
    expect(rows.find((r) => r.from === "them" && r.label === "Name")).toMatchObject({ copied: "", ok: false });
  });
});

describe("a QSO stopped early", () => {
  it("has nothing of yours to check before the station took any of it", () => {
    const q = callIn({ ...newRun("cwt", () => 0), them: JIM, you: "W7YFR" }, () => 0).qso as RunQso;
    const rows = exchangeReport(q, [{ text: "K4ABC", typed: "" }], ME).filter((r) => r.from === "you");
    expect(rows.filter((r) => r.label !== "Call").every((r) => r.copied === null && r.ok === null)).toBe(true);
  });
});

describe("a run's report", () => {
  it("shows the format's items both ways", () => {
    let q: RunQso = callIn({ ...newRun("cwt", () => 0), them: JIM, you: "W7YFR" }, () => 0).qso as RunQso;
    q = answerRun(q, "K4ABC ROB OR", { ...FIRST, region: "OR" }).qso as RunQso;
    const lines: TheirLine[] = [
      { text: "K4ABC", typed: "k4abc" },
      { text: "TU JIM 2345", typed: "tu jim 2354" },
    ];
    expect(shown(exchangeReport(q, lines, ME))).toEqual([
      "them Call: K4ABC > K4ABC",
      "them Name: JIM > JIM",
      "them Number: 2345 > 2354 ✗",
      "you Call: W7YFR > W7YFR",
      "you Name: ROB > ROB",
      "you State: OR > OR",
    ]);
  });
});

describe("items typed in boxes (Exchange)", () => {
  const cwt = (): RunQso => {
    let q: RunQso = callIn({ ...newRun("cwt", () => 0), them: JIM, you: "W7YFR" }, () => 0).qso as RunQso;
    return answerRun(q, "K4ABC ROB OR", { ...FIRST, region: "OR" }).qso as RunQso;
  };
  const lines: TheirLine[] = [
    { text: "K4ABC", typed: null },
    { text: "TU JIM 2345", typed: null },
  ];

  it("grades each item by what you typed in its box, in any case", () => {
    const typed = { Call: "k4abc", Name: "JIN", "Number or state": "2345" };
    expect(shown(exchangeReport(cwt(), lines, ME, typed)).slice(0, 3)).toEqual([
      "them Call: K4ABC > K4ABC",
      "them Name: JIM > JIN ✗",
      "them Number: 2345 > 2345",
    ]);
  });

  it("marks an empty box missed", () => {
    expect(exchangeReport(cwt(), lines, ME, {}).find((r) => r.label === "Name")).toMatchObject({ copied: "", ok: false });
  });

  it("takes 599 for 5NN, and 5NN for 599", () => {
    let q: RunQso = callIn({ ...newRun("pota", () => 0), them: JIM, you: "W7YFR" }, () => 0).qso as RunQso;
    q = answerRun(q, "K4ABC UR 5NN OR OR BK", { ...FIRST, region: "OR" }).qso as RunQso;
    const sent: TheirLine[] = [{ text: "K4ABC", typed: null }, { text: "BK TU UR 57N 57N GA GA BK", typed: null }];
    const report = (r: string) => exchangeReport(q, sent, ME, { Call: "K4ABC", Report: r, State: "GA" }).find((x) => x.label === "Report");
    expect(report("579")?.ok).toBe(true);
    expect(report("57N")?.ok).toBe(true);
    expect(report("589")?.ok).toBe(false);
  });

  it("labels a CWT's number or state as one box", () => {
    expect(theirItems(cwt()).map((i) => i.label)).toEqual(["Call", "Name", "Number"]);
    expect(itemLabels(cwt())).toEqual(["Call", "Name", "Number or state"]);
  });
});
