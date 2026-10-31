/* A QSO from text given to the Copy page: its lines, who sends each one, the
 * user's details filled in, and the script sent from it. */

import { describe, expect, it } from "vitest";
import { isScript, SAME_STATION_PAUSE_SEC, sendScript } from "@/copy/generate";
import { fillText, guessStations, linesOf, stationsOf, textScript, unkeyable } from "@/copy/text";
import { EMPTY_USER, type UserInfo } from "@/io/storage";

const USER: UserInfo = { ...EMPTY_USER, callsign: "W7YFR", name: "Rob", qthCity: "Seattle" };

const SPEED = { charWpm: 20, farnsworthWpm: 20 };

/** A CW Academy homework QSO, as pasted: a blank line after every line, and
 *  one station's turn often over two lines. */
const HOMEWORK = `CQ CQ DE AC4BT AC4BT K

AC4BT DE (your call) (your call) K

(your call) DE AC4BT TU FER CALL UR RST IS 559 559 IN VA VA NAME IS JERRY JERRY HW?

(your call) DE AC4BT K

AC4BT DE (your call) R GUD CPY JERRY ES TU FER RPT FM VA UR RST IS 569 IN (your QTH)

NAME IS (your name) HW?

AC4BT DE (your call) K

(your call) DE AC4BT GUD CPY (your name) MNI TKS FER QSO HPE CU AGN SN 73 SK

(your call) DE AC4BT K

DE (your call) OK JERRY NICE TO QSO WID U TOO I WILL LOOK FER U AGN JERRY 73

AC4BT DE (your call) SK E E

E E
`;

/** Who sends each line of the homework QSO: AC4BT is 0, you are 1. */
const HOMEWORK_STATIONS = [0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0];

describe("the lines of a text", () => {
  it("is each line with Morse in it, upper case with single spaces", () => {
    expect(linesOf("cq  cq de w1aw\r\n\r\n   \n\tw1aw de k7abc k  \n")).toEqual(["CQ CQ DE W1AW", "W1AW DE K7ABC K"]);
  });

  it("leaves out a line with no Morse in it", () => {
    expect(linesOf("CQ\n###\n\nK")).toEqual(["CQ", "K"]);
  });

  it("is nothing for a blank text", () => {
    expect(linesOf("\n  \n")).toEqual([]);
  });
});

describe("who sends each line", () => {
  it("reads the homework QSO right, with its notes not yet filled in", () => {
    const { stations, calls } = guessStations(linesOf(HOMEWORK));
    expect(stations).toEqual(HOMEWORK_STATIONS);
    expect(calls).toEqual(["AC4BT", "(YOUR CALL)"]);
  });

  it("reads the homework QSO right with your call filled in", () => {
    const { stations, calls } = guessStations(linesOf(fillText(HOMEWORK, USER)));
    expect(stations).toEqual(HOMEWORK_STATIONS);
    expect(calls).toEqual(["AC4BT", "W7YFR"]);
  });

  it("is the station a line names after DE", () => {
    const { stations } = guessStations(["W1AW DE K7ABC", "K7ABC DE W1AW", "K7ABC DE W1AW"]);
    expect(stations).toEqual([0, 1, 1]);
  });

  it("goes to the other station after a line that ends a turn", () => {
    for (const end of ["K", "KN", "BK", "SK", "AR", "<SK>", "<KN>", "<AR>", "<BK>", "HW?", "QRZ?", "E E"]) {
      expect(guessStations([`TU ${end}`, "R R"]).stations, end).toEqual([0, 1]);
    }
  });

  it("stays with the same station after a line that does not end a turn", () => {
    expect(guessStations(["UR RST 579", "NAME BOB", "QTH WA"]).stations).toEqual([0, 0, 0]);
  });

  it("takes a K at the end of a call as no end of a turn", () => {
    expect(guessStations(["CQ DE W1AK", "NAME BOB"]).stations).toEqual([0, 0]);
  });

  it("puts a third call on the station the turn goes to", () => {
    const { stations, calls } = guessStations(["CQ DE W1AW K", "W1AW DE K7ABC K", "DE N0XYZ K", "R R"]);
    expect(stations).toEqual([0, 1, 0, 1]);
    expect(calls).toEqual(["W1AW", "K7ABC"]);
  });

  it("is a station you set in place of the guess, line by line", () => {
    const lines = ["CQ DE W1AW K", "W1AW DE K7ABC K", "R R"];
    expect(stationsOf(lines)).toEqual([0, 1, 0]);
    expect(stationsOf(lines, [null, 0, 1])).toEqual([0, 0, 1]);
    // Too few picks: the rest as the text says.
    expect(stationsOf(lines, [1])).toEqual([1, 1, 0]);
  });
});

describe("filling in your details", () => {
  it("fills notes and slots, and keeps the line breaks", () => {
    expect(fillText("DE (your call) K\n\nNAME {name} QTH {CITY}", USER)).toBe("DE W7YFR K\n\nNAME Rob QTH Seattle");
  });

  it("leaves a note or slot with no value as it is", () => {
    expect(fillText("ANT (your antenna) {age} {nope} (hello)", USER)).toBe("ANT (your antenna) {age} {nope} (hello)");
  });

  it("names each symbol with no Morse once", () => {
    expect(unkeyable("CQ # DE {W1AW} #")).toEqual(["#", "{", "}"]);
    expect(unkeyable("CQ DE W1AW <SK> 5NN?")).toEqual([]);
  });
});

describe("a script of a text", () => {
  const script = (text: string, picks: (number | null)[] = []) =>
    textScript(text, { title: "Homework", picks, speed: SPEED, user: USER });

  it("is null when there is nothing to send", () => {
    expect(script("")).toBeNull();
    expect(script("###\n\n")).toBeNull();
  });

  it("sends the homework QSO line by line, filled in, by the right station", () => {
    const s = script(HOMEWORK)!;
    expect(s.kind).toBe("text");
    expect(s.title).toBe("Homework");
    expect(s.source, "the text as typed, to edit again").toBe(HOMEWORK);
    expect(s.lines.map((l) => l.station)).toEqual(HOMEWORK_STATIONS);
    expect(s.lines[1]!.text).toBe("AC4BT DE W7YFR W7YFR K");
    expect(s.lines[4]!.text).toMatch(/ IN Seattle$/);
    expect(s.stations.map((st) => st.call)).toEqual(["AC4BT", "W7YFR"]);
    expect(s.stations[0]!.toneHz).not.toBe(s.stations[1]!.toneHz);
    for (const st of s.stations) expect(st.speed).toEqual(SPEED);
    expect(isScript(s)).toBe(true);
  });

  it("is one station when every line is the same station's", () => {
    const s = script("QST QST\n\nTHE BULLETIN FOLLOWS\n\nAR")!;
    expect(s.stations).toHaveLength(1);
    expect(s.stations[0]!.call).toBe("");
  });

  it("takes the stations you set, and keeps them", () => {
    const s = script("CQ DE W1AW K\n\nW1AW DE K7ABC K", [null, 0])!;
    expect(s.lines.map((l) => l.station)).toEqual([0, 0]);
    expect(s.stations).toHaveLength(1);
    expect(s.picks).toEqual([null, 0]);
  });

  it("names no call a note gives when your details have no value for it", () => {
    const s = textScript("CQ DE (your call) K\n\n(your call) DE W1AW K", {
      title: "",
      picks: [],
      speed: SPEED,
      user: EMPTY_USER,
    })!;
    expect(s.stations.map((st) => st.call)).toEqual(["", "W1AW"]);
  });

  it("pauses briefly between two lines from one station, and for the gap between stations", () => {
    const s = script("UR RST 579\nNAME BOB K\nR R")!;
    expect(s.lines.map((l) => l.station)).toEqual([0, 0, 1]);
    const { overs } = sendScript(s, { gapSec: 2 }).rec;
    expect(overs[1]!.t0 - overs[0]!.t1).toBeCloseTo(SAME_STATION_PAUSE_SEC, 6);
    expect(overs[2]!.t0 - overs[1]!.t1).toBeCloseTo(2, 6);
  });

  it("is a script as kept in the browser, and not with picks that name no station", () => {
    const s = script("CQ DE W1AW K\n\nW1AW DE K7ABC K")!;
    expect(isScript(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(isScript({ ...s, picks: [2] })).toBe(false);
    expect(isScript({ ...s, source: 5 })).toBe(false);
  });
});
