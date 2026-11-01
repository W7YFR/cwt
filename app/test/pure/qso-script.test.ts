/* A QSO from a script: the station sends its lines, and waits for each of
 * yours. */

import { describe, expect, it } from "vitest";
import { EMPTY_USER, type UserInfo } from "@/io/storage";
import { hint, type Me, type Them } from "@/qso/hint";
import { respond, type AnyQso, type RunContext } from "@/qso/run";
import { fromTop, isScript, newScript, openScript, stationFirst, youIn, yourLine, type ScriptQso } from "@/qso/script";

const SPEED = { charWpm: 20, farnsworthWpm: 20 };

/** The author's script. */
const AC4BT = `CQ CQ DE AC4BT AC4BT K

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

E E`;

const SET: UserInfo = { ...EMPTY_USER, callsign: "W7YFR", name: "Rob", qthCity: "Seattle", qthRegionShort: "WA" };
const UNSET: UserInfo = EMPTY_USER;

const STRICT_EAR: RunContext = { ear: { lenient: false, saved: "" }, rand: () => 0 };
const LENIENT_EAR: RunContext = { ear: { lenient: true, saved: "" }, rand: () => 0 };

function script(text: string, user: UserInfo, picks: (number | null)[] = []): ScriptQso {
  const qso = newScript(text, { picks, you: youIn(text, user.callsign), user, speed: SPEED });
  if (!qso) throw new Error("no script");
  return qso;
}

/** Send `overs` in turn, and return the station's replies and the QSO. */
function work(qso: AnyQso, overs: readonly string[], context: RunContext = STRICT_EAR) {
  const replies: (string | null)[] = [];
  let ended = false;
  for (const over of overs) {
    const turn = respond(qso, over, context);
    qso = turn.qso;
    replies.push(turn.reply);
    ended = turn.ended;
  }
  return { replies, qso: qso as ScriptQso, ended };
}

/** Each of your overs as the script has it, sent in turn to the end. */
function workThrough(qso: ScriptQso, context: RunContext, keyed: (line: string) => string = (l) => l) {
  const sent: string[] = [];
  const replies: (string | null)[] = [];
  let ended = false;
  for (let n = 0; n < 20 && !ended; n++) {
    const line = yourLine(qso);
    if (line === null) break;
    const turn = respond(qso, keyed(line), context);
    sent.push(keyed(line));
    replies.push(turn.reply);
    qso = turn.qso as ScriptQso;
    ended = turn.ended;
  }
  return { sent, replies, qso, ended };
}

describe("who sends each line", () => {
  it("makes you the station of (your call), and the other the station", () => {
    const qso = script(AC4BT, UNSET);
    expect(qso.lines.map((l) => l.you)).toEqual([
      false, true, false, false, true, true, true, false, false, true, true, false,
    ]);
    expect(qso.them.call).toBe("AC4BT");
    expect(qso.them.name).toBe("JERRY");
  });

  it("makes you the station of your call, filled in from User", () => {
    const qso = script(AC4BT, SET);
    expect(qso.you).toBe("W7YFR");
    expect(qso.lines[1]).toEqual({ you: true, text: "AC4BT DE W7YFR W7YFR K" });
  });

  it("makes you the station that does not send first, with no call of yours", () => {
    expect(youIn("CQ DE K6RB K\n\nK6RB DE N0CALL K", "")).toBe(1);
    expect(youIn("CQ DE K6RB K\n\nK6RB DE N0CALL K", "K6RB")).toBe(0);
  });

  it("takes a station set by hand", () => {
    const qso = script("CQ DE K6RB K\n\nTU 73", UNSET, [null, 0]);
    expect(qso.lines.map((l) => l.you)).toEqual([false, false]);
  });

  it("has nothing to send for text with no Morse", () => {
    expect(newScript("###", { picks: [], you: 1, user: UNSET, speed: SPEED })).toBeNull();
  });
});

describe("the station", () => {
  it("opens when its line comes first, lines in a row as one over", () => {
    const qso = script(AC4BT, SET);
    expect(stationFirst(qso)).toBe(true);
    const turn = openScript(qso);
    expect(turn.reply).toBe("CQ CQ DE AC4BT AC4BT K");
    expect(stationFirst(turn.qso)).toBe(false);
    expect(yourLine(turn.qso)).toBe("AC4BT DE W7YFR W7YFR K");
  });

  it("waits for your line when yours comes first", () => {
    const qso = script("CQ CQ DE W7YFR K\n\nW7YFR DE K6RB K", SET);
    expect(stationFirst(qso)).toBe(false);
    expect(work(qso, ["CQ CQ DE W7YFR K"]).replies).toEqual(["W7YFR DE K6RB K"]);
  });

  for (const [mode, context] of [["Strict", STRICT_EAR], ["Lenient", LENIENT_EAR]] as const) {
    it(`goes from the CQ to E E with each line right (${mode})`, () => {
      const { replies, ended } = workThrough(openScript(script(AC4BT, SET)).qso, context);
      expect(replies).toEqual([
        "W7YFR DE AC4BT TU FER CALL UR RST IS 559 559 IN VA VA NAME IS JERRY JERRY HW? W7YFR DE AC4BT K",
        "W7YFR DE AC4BT GUD CPY ROB MNI TKS FER QSO HPE CU AGN SN 73 SK W7YFR DE AC4BT K",
        "E E",
      ]);
      expect(ended).toBe(true);
    });
  }

  it("ends on your line when yours is last, with nothing more to send", () => {
    const qso = script("CQ DE K6RB K\n\nK6RB DE W7YFR TU 73 E E", SET);
    const { replies, ended, qso: after } = work(openScript(qso).qso, ["K6RB DE W7YFR TU 73 E E"]);
    expect(replies).toEqual([null]);
    expect(ended).toBe(true);
    expect(after.stage).toBe("done");
  });
});

describe("your line", () => {
  const opened = () => openScript(script(AC4BT, SET)).qso;

  it("needs every word in order with Strict, other words between let go", () => {
    expect(work(opened(), ["AC4BT DE W7YFR W7YFR"]).replies[0]).toBe("AGN?");
    expect(work(opened(), ["AC4BT DE W7YFR K"]).replies[0]).toBe("AGN?");
    expect(work(opened(), ["AC4BT DE W7YFR W7YFR K"]).replies[0]).toMatch(/^W7YFR DE AC4BT/);
    expect(work(opened(), ["AC4BT EEEEEEEE DE W7YFR W7YFR K"]).replies[0]).toMatch(/^W7YFR DE AC4BT/);
    expect(work(opened(), ["W7YFR DE AC4BT W7YFR K"]).replies[0]).toBe("AGN?");
  });

  it("needs both calls and most of the rest with Lenient, spaces or none", () => {
    expect(work(opened(), ["AC4BT DE W7YFR W7YFR"], LENIENT_EAR).replies[0]).toMatch(/^W7YFR DE AC4BT/);
    expect(work(opened(), ["AC4BTDEW7YFRW7YFRK"], LENIENT_EAR).replies[0]).toMatch(/^W7YFR DE AC4BT/);
    expect(work(opened(), ["AC4BT DE W7XYZ W7XYZ K"], LENIENT_EAR).replies[0]).toBe("AGN?");
    expect(work(opened(), ["AC4BT K"], LENIENT_EAR).replies[0]).toBe("AGN?");
  });

  it("reads a prosign and a ? keyed apart as written", () => {
    const qso = script("CQ DE K6RB K\n\nK6RB DE W7YFR HW? <SK>\n\nTU", SET);
    expect(work(openScript(qso).qso, ["K6RB DE W7YFR HW ? SK"]).replies[0]).toBe("TU");
  });

  it("asks again in a new way each time, never the same twice running", () => {
    const rands = [0, 0, 0, 0, 0, 0];
    const { replies } = work(opened(), ["E", "E", "E", "E", "E", "E"], { ...STRICT_EAR, rand: () => rands.pop()! });
    replies.forEach((r, i) => {
      expect(["AGN?", "PSE AGN", "?", "AGN AGN?"]).toContain(r);
      if (i > 0) expect(r).not.toBe(replies[i - 1]);
    });
  });

  it("gets its last over for AGN or ?, and moves on with your line after", () => {
    const { replies } = work(opened(), ["AGN", "?", "AC4BT DE W7YFR W7YFR K"]);
    expect(replies.slice(0, 2)).toEqual(["CQ CQ DE AC4BT AC4BT K", "CQ CQ DE AC4BT AC4BT K"]);
    expect(replies[2]).toMatch(/^W7YFR DE AC4BT/);
  });

  it("sends its last over slower for QRS", () => {
    const { replies, qso } = work(opened(), ["QRS"]);
    expect(replies[0]).toBe("CQ CQ DE AC4BT AC4BT K");
    expect(qso.speed.farnsworthWpm).toBeLessThan(SPEED.farnsworthWpm);
  });
});

describe("notes not filled in from User", () => {
  /** You key K7ABC, BOISE ID and AL for your call, QTH and name. */
  const keyed = (line: string) =>
    line.replace(/\(YOUR CALL\)/g, "K7ABC").replace(/\(YOUR QTH\)/g, "BOISE ID BOISE ID").replace(/\(YOUR NAME\)/g, "AL AL");

  it("stand for what you send, which the station then uses", () => {
    const opened = openScript(script(AC4BT, UNSET));
    expect(opened.reply).not.toMatch(/\(/);
    const { replies, qso } = workThrough(opened.qso, STRICT_EAR, keyed);
    expect(replies[0]).toMatch(/^K7ABC DE AC4BT TU FER CALL/);
    expect(replies[1]).toMatch(/^K7ABC DE AC4BT GUD CPY AL MNI TKS/);
    expect(qso.you).toBe("K7ABC");
    expect(qso.heard).toEqual({ "(YOUR CALL)": "K7ABC", "(YOUR QTH)": "BOISE ID", "(YOUR NAME)": "AL" });
  });

  it("hold you to what you sent first", () => {
    const after = work(openScript(script(AC4BT, UNSET)).qso, ["AC4BT DE K7ABC K7ABC K"]).qso;
    expect(yourLine(after)).toMatch(/^AC4BT DE K7ABC R GUD CPY/);
    const line = keyed(yourLine(after)!).replace(/K7ABC/g, "K7XYZ");
    expect(work(after, [line]).replies[0]).toBe("AGN?");
  });

  it("are left out of the station's line when you never sent them", () => {
    const qso = script("CQ DE K6RB K\n\nK6RB DE (your call) K\n\nTU (your name) 73", UNSET);
    expect(work(openScript(qso).qso, ["K6RB DE K7ABC K"]).replies[0]).toBe("TU 73");
  });
});

describe("from the top", () => {
  it("goes back to the first line, and forgets what you sent", () => {
    const after = work(openScript(script(AC4BT, UNSET)).qso, ["AC4BT DE K7ABC K7ABC K"]).qso;
    const top = fromTop(after);
    expect(top.at).toBe(0);
    expect(top.heard).toEqual({});
    expect(stationFirst(top)).toBe(true);
    expect(openScript(top).reply).toBe("CQ CQ DE AC4BT AC4BT K");
  });
});

describe("the suggested reply", () => {
  const me: Me = { call: "W7YFR", name: "ROB", qth: "SEATTLE WA", region: "WA", nr: "" };
  const HIDDEN: Them = { call: "(THEIR CALL)", name: "(THEIR NAME)" };

  it("is your next line, with their call and name as you have them", () => {
    const qso = openScript(script(AC4BT, SET)).qso;
    expect(isScript(qso)).toBe(true);
    expect(hint(qso, me)).toBe("AC4BT DE W7YFR W7YFR K");
    expect(hint(qso, me, null, undefined, HIDDEN)).toBe("(THEIR CALL) DE W7YFR W7YFR K");
    const later = work(qso, ["AC4BT DE W7YFR W7YFR K"]).qso;
    expect(hint(later, me, null, undefined, HIDDEN)).toMatch(/^\(THEIR CALL\) DE W7YFR R GUD CPY \(THEIR NAME\) ES/);
  });
});
