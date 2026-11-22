/* The Live page's log: who sent each turn, which QSO it is in, and what each
 * station said. */

import { describe, expect, it } from "vitest";
import { buildLog, NO_FIXES, type LiveTurn } from "@/live/log";
import { readSaid } from "@/live/parse";
import { transcriptText } from "@/live/export";

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

describe("a station running on one pitch", () => {
  /** A run as heard when the callers are too weak to copy: every line is
   *  the runner's, at its strength and speed. */
  const run = (chan = "a", start = 0) =>
    turns(
      [
        ["CQ W1AW/5 W1AW/5", -30, 30],
        ["K9OM 5NN MS", -30, 30],
        ["CQ W1AW/5 W1AWB", -30, 30],
        ["N6MU 5NN MS", -30, 30],
        ["TU W1AW/5", -30, 30],
        ["CQ W1AWE", -30, 30],
        ["OM3C", -30, 30],
        ["TE", -30, 30],
        ["CQ W1AW", -30, 30],
      ],
      chan,
      start,
    );

  it("takes a misread call for the call read well", () => {
    const log = buildLog(run());
    expect(log.lines.map((l) => l.sender)).toEqual(Array(9).fill("W1AW/5"));
    expect(new Set(log.qsos.flatMap((q) => q.stations.map((s) => s.call)))).toEqual(
      new Set(["W1AW/5", "K9OM", "N6MU", "OM3C"]),
    );
  });

  it("keeps a call read as often as the other apart", () => {
    const log = buildLog(turns([["CQ K7ABC K7ABC", -10, 20], ["CQ K7ABD K7ABD", -10, 20]]));
    expect(log.lines.map((l) => l.sender)).toEqual(["K7ABC", "K7ABD"]);
  });

  it("keeps the runner when its signal moves to a new channel", () => {
    const first = run("a").slice(0, 3);
    const moved = turns([["N9BIR 5NN MS", -30, 30], ["?", -30, 30], ["R TU", -30, 30]], "b", 30_000).map((t) => ({
      ...t,
      hz: 608,
    }));
    const log = buildLog([...first, ...moved]);
    expect(log.lines.map((l) => l.sender)).toEqual(Array(6).fill("W1AW/5"));
  });

  it("takes a call read once at a station's pitch and speed as that station", () => {
    const lines = turns([
      ["CQ RG DE KB4T KB4T K", -20, 18],
      ["GL 73 DE KB4T E", -20, 18],
      ["CQ RG DE KB4T KN", -20, 18],
      ["CQ RG DE CB4TKDS", -20, 18],
      ["KB4T RG K", -20, 18],
    ]);
    const log = buildLog(lines);
    expect(log.lines.map((l) => l.sender)).toEqual(Array(5).fill("KB4T"));
    expect(log.qsos.flatMap((q) => q.stations.map((st) => st.call))).not.toContain("CB4TKDS");
  });

  it("leaves a line at another speed to someone else", () => {
    const log = buildLog([...run().slice(0, 2), ...turns([["7 Y", -30, 22]], "a", 25_000)]);
    expect(log.lines[2]!.sender).not.toBe("W1AW/5");
  });

  it("holds a confirmed call and its pitch, even before its CQ", () => {
    const lines = turns([["E I", -30, 30], ["CQ W1AWX", -30, 30], ["W1AL/5", -30, 30]]);
    const log = buildLog(lines, { ...NO_FIXES, confirmed: { "W1AW/5": 600 } });
    expect(log.lines.map((l) => l.sender)).toEqual(["W1AW/5", "W1AW/5", "W1AW/5"]);
    expect(log.qsos[0]!.stations[0]).toMatchObject({ call: "W1AW/5", confirmed: true });
  });

  it("reads the end of your call as your call", () => {
    const log = buildLog(turns([["CQ W1AW/5 W1AW/5", -30, 30], ["7YFR", -20, 25], ["7YFR 5NN MS", -30, 30]]), NO_FIXES, "W7YFR");
    expect(log.lines.map((l) => [l.sender, l.mine])).toEqual([
      ["W1AW/5", false],
      ["W7YFR", true],
      ["W1AW/5", false],
    ]);
  });
});

describe("the end of a QSO", () => {
  const chat = turns([
    ["CQ CQ DE W7YFR K", -6, 18],
    ["W7YFR DE K7ABC K", -17, 25],
    ["K7ABC DE W7YFR TU 73 SK", -6, 18],
  ]);

  it("ends on SK", () => {
    expect(buildLog(chat).qsos[0]!.ended).toBe(true);
  });

  it("waits for a line still being read", () => {
    expect(buildLog(chat, NO_FIXES, "", new Set([chat[2]!.id])).qsos[0]!.ended).toBe(false);
  });

  it("takes the end back when the QSO goes on", () => {
    const more = [...chat, ...turns([["R FB OM", -17, 25]], "a", 40_000).map((t) => ({ ...t, id: "late" }))];
    expect(buildLog(more).qsos[0]!.ended).toBe(false);
  });
});

describe("the radio's frequency", () => {
  /** Three QSOs, a few minutes apart. */
  const three = [
    ...turns([["CQ K7ABC K7ABC", -10, 20]], "a", 0),
    ...turns([["CQ N5XX N5XX", -10, 20]], "b", 240_000),
    ...turns([["CQ W1AW W1AW", -10, 20]], "c", 480_000),
  ];

  it("holds for the QSOs after, until you note the next", () => {
    const ids = buildLog(three).qsos.map((q) => q.id);
    const log = buildLog(three, { ...NO_FIXES, freq: { [ids[1]!]: "14.025" } });
    expect(log.qsos.map((q) => q.freq)).toEqual([null, "14.025", "14.025"]);
    const retuned = buildLog(three, { ...NO_FIXES, freq: { [ids[0]!]: "7.030", [ids[2]!]: "" } });
    expect(retuned.qsos.map((q) => q.freq)).toEqual(["7.030", "7.030", null]);
  });

  it("goes in the transcript", () => {
    const ids = buildLog(three).qsos.map((q) => q.id);
    const log = buildLog(three, { ...NO_FIXES, freq: { [ids[0]!]: "14.025" } });
    expect(transcriptText(log.lines, log.qsos)).toContain("Z  14.025  600 Hz  K7ABC");
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
});
