/* The Live page's log: who sent each turn, which QSO it is in, and what each
 * station said. */

import { describe, expect, it } from "vitest";
import { buildLog, type LiveTurn } from "@/live/log";
import { readSaid } from "@/live/parse";
import { logAdif, logCsv, transcriptText } from "@/live/export";

/** Turns on one signal, a few seconds apart, with each station's own
 *  strength and speed: [text, db, wpm]. */
function turns(lines: readonly (readonly [string, number, number])[], chan = "a", start = 0): LiveTurn[] {
  return lines.map(([text, db, wpm], i) => ({
    id: `${chan}${i}`,
    chan,
    hz: 600,
    at: start + i * 10_000,
    end: start + i * 10_000 + 8_000,
    text,
    wpm,
    db,
  }));
}

describe("reading a turn", () => {
  it("takes a rag chew's details", () => {
    const said = readSaid("K7ABC DE W7YFR GM UR RST 579 579 NAME BOB BOB QTH SEATTLE WA RIG IC7300 PWR 100W ANT DIPOLE BK");
    expect(said.de).toBe("W7YFR");
    expect(said.to).toBe("K7ABC");
    expect(said.fields).toEqual({ rst: "579", name: "BOB", qth: "SEATTLE WA", state: "WA", rig: "IC7300", power: "100W", ant: "DIPOLE" });
  });

  it("reads 5NN as 599", () => {
    expect(readSaid("UR 5NN").fields.rst).toBe("599");
  });

  it("names the kind a CQ calls for", () => {
    expect(readSaid("CQ CWT N5XX N5XX").cq).toBe("cwt");
    expect(readSaid("CQ POTA K7ABC").cq).toBe("pota");
    expect(readSaid("CQ CQ DE W7YFR K").cq).toBe("");
    expect(readSaid("W7YFR DE K7ABC K").cq).toBe(null);
  });

  it("takes an exchange by its shape once the kind is known", () => {
    expect(readSaid("K1ZZ TOM 1234", "cwt").fields).toEqual({ name: "TOM", number: "1234" });
    expect(readSaid("R SUE CWA", "cwt").fields).toEqual({ name: "SUE", number: "CWA" });
    expect(readSaid("TU BOB OR", "sst").fields).toEqual({ name: "BOB", state: "OR" });
    expect(readSaid("K7ABC 5NN WA", "pota").fields).toEqual({ rst: "599", state: "WA" });
  });

  it("takes a park", () => {
    expect(readSaid("CQ POTA DE K7ABC US-1234 K").fields.park).toBe("US-1234");
  });
});

describe("the log", () => {
  it("names each sender of a rag chew and fills its card", () => {
    const log = buildLog(
      turns([
        ["CQ CQ DE W7YFR W7YFR K", -6, 18],
        ["W7YFR DE K7ABC K7ABC K", -17, 25],
        ["K7ABC DE W7YFR UR RST 579 NAME BOB QTH SEATTLE WA BK", -6, 18],
        ["BK R TNX BOB UR 599 NAME JIM QTH BOISE ID BK", -17, 25],
        ["BK FB JIM 73 SK", -6, 18],
        ["73 E E", -17, 25],
      ]),
      undefined,
      "W7YFR",
    );
    expect(log.lines.map((l) => l.sender)).toEqual(["W7YFR", "K7ABC", "W7YFR", "K7ABC", "W7YFR", "K7ABC"]);
    expect(log.lines.map((l) => l.mine)).toEqual([true, false, true, false, true, false]);
    expect(log.qsos).toHaveLength(1);
    const [qso] = log.qsos;
    expect(qso!.kind).toBe("ragchew");
    expect(qso!.ended).toBe(true);
    expect(qso!.stations.map((s) => [s.call, s.mine, s.fields])).toEqual([
      ["W7YFR", true, { rst: "579", name: "BOB", qth: "SEATTLE WA", state: "WA" }],
      ["K7ABC", false, { rst: "599", name: "JIM", qth: "BOISE ID", state: "ID" }],
    ]);
  });

  it("starts a new QSO for each caller in a run", () => {
    const log = buildLog(
      turns([
        ["CQ CWT N5XX N5XX", -8, 28],
        ["K1ZZ", -18, 30],
        ["K1ZZ TOM 1234", -8, 28],
        ["TU MIKE 2345", -18, 30],
        ["TU N5XX", -8, 28],
        ["AA4B", -14, 24],
        ["AA4B TOM 1234", -8, 28],
        ["R SUE CWA", -14, 24],
        ["TU N5XX CWT", -8, 28],
      ]),
    );
    expect(log.lines.map((l) => l.sender)).toEqual(["N5XX", "K1ZZ", "N5XX", "K1ZZ", "N5XX", "AA4B", "N5XX", "AA4B", "N5XX"]);
    expect(log.qsos.map((q) => [q.kind, q.ended, q.stations.map((s) => [s.call, s.fields])])).toEqual([
      ["cwt", true, [["N5XX", { name: "TOM", number: "1234" }], ["K1ZZ", { name: "MIKE", number: "2345" }]]],
      ["cwt", true, [["N5XX", { name: "TOM", number: "1234" }], ["AA4B", { name: "SUE", number: "CWA" }]]],
    ]);
  });

  it("keeps QSOs on different signals apart", () => {
    const log = buildLog([
      ...turns([["CQ CQ DE W7YFR K", -6, 18], ["W7YFR DE K7ABC K", -17, 25]], "a"),
      ...turns([["CQ POTA DE KD7XYZ K", -9, 20], ["KD7XYZ DE N0CALL K", -12, 22]], "b", 5_000),
    ]);
    expect(log.qsos.map((q) => q.stations.map((s) => s.call))).toEqual([
      ["W7YFR", "K7ABC"],
      ["KD7XYZ", "N0CALL"],
    ]);
    expect(log.qsos.map((q) => q.kind)).toEqual([null, "pota"]);
  });

  it("starts a new QSO after a long silence", () => {
    const log = buildLog([
      ...turns([["CQ CQ DE W7YFR K", -6, 18]], "a"),
      ...turns([["CQ CQ DE W7YFR K", -6, 18]], "a", 5 * 60_000).map((t) => ({ ...t, id: "later" })),
    ]);
    expect(log.qsos).toHaveLength(2);
  });

  it("takes your fixes to a sender and a detail", () => {
    const t = turns([
      ["CQ CQ DE W7YFR K", -6, 18],
      ["W7YFR DE K7ABC K", -17, 25],
      ["NAME JIM", -11, 21],
    ]);
    const before = buildLog(t);
    expect(before.lines[2]!.sender).not.toBe("K7ABC");
    const after = buildLog(t, { sender: { a2: "K7ABC" }, fields: { a0: { K7ABC: { qth: "BOISE" } } } });
    expect(after.lines[2]!.sender).toBe("K7ABC");
    expect(after.qsos[0]!.stations.find((s) => s.call === "K7ABC")!.fields).toEqual({ name: "JIM", qth: "BOISE" });
  });
});

describe("downloads", () => {
  const log = buildLog(
    turns([
      ["CQ CQ DE W7YFR K", -6, 18],
      ["W7YFR DE K7ABC K", -17, 25],
      ["K7ABC DE W7YFR UR 579 NAME BOB BK", -6, 18],
      ["R UR 599 NAME JIM, QTH BOISE ID BK", -17, 25],
    ]),
    undefined,
    "W7YFR",
  );

  it("writes a line of text for each turn", () => {
    const text = transcriptText(log.lines);
    expect(text.trim().split("\n")).toHaveLength(4);
    expect(text).toContain("K7ABC 25 WPM  W7YFR DE K7ABC K");
  });

  it("writes an ADIF record for each station you worked", () => {
    const adif = logAdif(log.qsos, "W7YFR", "1.0.0");
    expect(adif).toContain("<EOH>");
    expect(adif.match(/<EOR>/g)).toHaveLength(1);
    expect(adif).toContain("<CALL:5>K7ABC");
    expect(adif).toContain("<RST_SENT:3>579");
    expect(adif).toContain("<STATION_CALLSIGN:5>W7YFR");
  });

  it("writes a CSV row for each station of each QSO", () => {
    const rows = logCsv(log.qsos).trim().split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("W7YFR");
    expect(rows[2]).toContain("K7ABC");
  });
});
