/* Who calls: stations from every state and province, with calls from their
 * call area, and the words they send. */

import { describe, expect, it } from "vitest";
import { isCall } from "@/qso/cq";
import { makeScript } from "@/copy/generate";
import { ACADEMY_WPM, FORMATS, REGIONS } from "@/qso/formats";
import { hint, type Me } from "@/qso/hint";
import { theirItems } from "@/qso/report";
import { answerRun, following, newRun, RECENT_NAMES, respond, type RunQso } from "@/qso/run";
import { digitOf, NAMES, randomCaller, randomStation, regionOf, STATION_NAMES, type Station } from "@/qso/station";
import { vocabulary } from "@/qso/vocabulary";
import { exchange, type Say } from "@/qso/wording";

/** A fixed sequence, so each station is the same every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const canadian = (s: Station) => PROVINCES.includes(regionOf(s));

/** The digit of a call: the first digit after its prefix letters. */
const digitIn = (call: string) => /\d/.exec(call.slice(1))![0];

describe("the stations that call", () => {
  const rand = seeded(11);
  const many = Array.from({ length: 20000 }, () => randomStation(rand, "", 0.08));

  it("come from every state and province", () => {
    const seen = new Set(many.map(regionOf));
    for (const region of REGIONS) expect(seen.has(region), region).toBe(true);
  });

  it("come from busy states more often", () => {
    const from = (r: string) => many.filter((s) => regionOf(s) === r).length;
    expect(from("CA")).toBeGreaterThan(from("WY") * 10);
    expect(from("TX")).toBeGreaterThan(from("VT") * 5);
  });

  it("are in Canada as often as asked", () => {
    const share = many.filter(canadian).length / many.length;
    expect(share).toBeGreaterThan(0.06);
    expect(share).toBeLessThan(0.1);
    const none = Array.from({ length: 2000 }, () => randomStation(rand, "", 0));
    expect(none.some(canadian)).toBe(false);
  });

  it("have calls from their call area, most of the time in the US and always in Canada", () => {
    for (const s of many) expect(isCall(s.call), s.call).toBe(true);
    const us = many.filter((s) => !canadian(s));
    const home = us.filter((s) => digitIn(s.call) === digitOf(regionOf(s))).length / us.length;
    expect(home).toBeGreaterThan(0.85);
    expect(home).toBeLessThan(0.97);
    for (const s of many.filter(canadian)) {
      expect(s.call[0]).toBe("V");
      expect(digitIn(s.call), s.call).toBe(digitOf(regionOf(s)));
    }
  });

  it("send their state the way the exchange does: one word at the end of the QTH", () => {
    for (const s of many) expect(REGIONS.has(regionOf(s)), s.qth).toBe(true);
  });
});

describe("the names stations send", () => {
  const rand = seeded(23);
  const many = Array.from({ length: 20000 }, () => randomStation(rand));
  const count = (name: string) => many.filter((s) => s.name === name).length;

  it("come from the whole pool, the common ones most often", () => {
    expect(new Set(many.map((s) => s.name))).toEqual(new Set(STATION_NAMES));
    expect(count("BOB")).toBeGreaterThan(count("OTTO") * 3);
    expect(count("JIM")).toBeGreaterThan(count("ELMER") * 3);
  });

  it("never repeat within the last stations of a run", () => {
    for (const format of ["cwt", "sst", "mst", "pota"] as const) {
      let qso: RunQso = newRun(format, rand);
      const names = [qso.them.name];
      for (let i = 0; i < 300; i++) {
        qso = following(qso, rand) as RunQso;
        names.push(qso.them.name);
      }
      for (let i = 1; i < names.length; i++) {
        expect(names.slice(Math.max(0, i - RECENT_NAMES), i), format).not.toContain(names[i]);
      }
      // Common names still come back later in the run.
      expect(names.filter((n) => n === "BOB").length, format).toBeGreaterThan(1);
    }
  });

  it("keep the names after a CQ of another format", () => {
    let qso: RunQso = newRun("cwt", rand);
    for (let i = 0; i < 5; i++) qso = following(qso, rand) as RunQso;
    const next = respond(qso, "CQ SST W7YFR", { rand }).qso as RunQso;
    expect(next.format).toBe("sst");
    expect(next.recent).toEqual(qso.recent);
  });

  it("leave Lenient copy's words as they were", () => {
    const words = new Set(vocabulary([]));
    for (const name of NAMES) expect(words.has(name), name).toBe(true);
    expect(STATION_NAMES.filter((n) => words.has(n)).sort()).toEqual([...NAMES].sort());
  });
});

describe("CW Academy students in a CWT", () => {
  const rand = seeded(31);
  const runs = Array.from({ length: 5000 }, () => newRun("cwt", rand));
  const students = runs.filter((q) => q.them.nr === "CWA");

  it("call now and then, and send CWA in place of a number", () => {
    expect(students.length / runs.length).toBeGreaterThan(0.03);
    expect(students.length / runs.length).toBeLessThan(0.09);
    const qso: RunQso = { ...students[0]!, stage: "called", you: "KE7G" };
    const turn = answerRun(qso, `${qso.them.call} BOB 1234`, { rand });
    expect(turn.reply!.split(" ")).toContain("CWA");
    expect(theirItems(turn.qso, [{ text: turn.reply! }])).toContainEqual({ label: "Number", value: "CWA" });
  });

  it("send slower than the rest", () => {
    const [lo, hi] = ACADEMY_WPM;
    for (const q of students) {
      expect(q.speed.charWpm).toBeGreaterThanOrEqual(lo);
      expect(q.speed.charWpm).toBeLessThanOrEqual(hi);
    }
    const [min] = FORMATS.cwt.wpm;
    for (const q of runs.filter((r) => r.them.nr !== "CWA")) expect(q.speed.charWpm).toBeGreaterThanOrEqual(min);
    expect(Math.max(...students.map((q) => q.speed.charWpm))).toBeLessThan(min);
  });

  it("call and run in the Copy page's generated CWTs", () => {
    let heard = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const script = makeScript({ kind: "cwt", rand: seeded(seed), qsos: 5 });
      heard += script.lines.filter((l) => l.text.split(" ").includes("CWA")).length;
    }
    expect(heard).toBeGreaterThan(0);
  });
});

describe("a POTA hunter", () => {
  const plain: Station = { call: "W7YFR", name: "ROB", qth: "SPOKANE WA", rst: "599", toneHz: 600 };

  it("sends 599 or 5NN line by line, and its report is graded as its lines hold it", () => {
    const qso: RunQso = { ...newRun("pota", seeded(1)), them: plain, stage: "called", you: "KE7G" };
    const replies = Array.from({ length: 100 }, (_, i) =>
      answerRun(qso, "W7YFR TNX UR 599 OR BK", { rand: seeded((i + 1) * 104729), region: "OR" }),
    );
    const forms = new Set(replies.map((t) => (t.reply!.split(" ").includes("599") ? "599" : "5NN")));
    expect(forms).toEqual(new Set(["599", "5NN"]));
    for (const t of replies) {
      const value = theirItems(t.qso, [{ text: t.reply! }]).find((i) => i.label === "Report")!.value;
      expect(t.reply!.split(" "), t.reply!).toContain(value);
    }
  });

  it("hears its state said back in your sign-off only once you have it", () => {
    const me: Me = { call: "KE7G", name: "BOB", qth: "SALEM OR", region: "OR", nr: "" };
    const done: RunQso = { ...newRun("pota", seeded(1)), them: plain, stage: "exchanged", you: "KE7G" };
    let back = 0;
    for (let seed = 1; seed <= 200; seed++) {
      // Seeds spread out: a small seed's first draw is near 0.
      const voice = { rand: seeded(seed * 104729), hour: 12 };
      const known = hint(done, me, null, voice, { call: plain.call, name: "", region: "WA" });
      if (known.split(" ").includes("WA")) back++;
      // Every sign-off ends the QSO.
      expect(answerRun(done, known, { rand: seeded(seed) }).ended, known).toBe(true);
      const unknown = hint(done, me, null, { rand: seeded(seed * 104729), hour: 12 }, { call: plain.call, name: "" });
      expect(unknown.split(" "), unknown).not.toContain("WA");
    }
    expect(back).toBeGreaterThan(0);
  });
});

describe("a standard QSO's exchange", () => {
  const them: Station = { call: "K4ABC", name: "JIM", qth: "ATLANTA GA", rst: "559", toneHz: 600 };
  const say = (rand: () => number, length: Say["length"]): Say => ({
    them,
    you: "W7YFR",
    name: "ROB",
    rand,
    hour: 12,
    length,
    mirror: false,
  });

  it("now and then ends with a word on its rig or weather, never when short or plainest", () => {
    const full = Array.from({ length: 200 }, (_, i) => exchange(say(seeded(i + 1), "full"), true));
    expect(full.some((t) => /\b(RIG|WX)\b/.test(t))).toBe(true);
    expect(full.some((t) => !/\b(RIG|WX|HR [A-Z0-9]+ AT)\b/.test(t))).toBe(true);
    const short = Array.from({ length: 200 }, (_, i) => exchange(say(seeded(i + 1), "short"), true));
    expect(short.some((t) => /\b(RIG|WX)\b/.test(t))).toBe(false);
    expect(exchange(say(() => 0, "full"), true)).not.toMatch(/\b(RIG|WX)\b/);
  });

  it("now and then says why a weak report is weak", () => {
    const full = Array.from({ length: 200 }, (_, i) => exchange(say(seeded(i + 1), "full"), true));
    expect(full.some((t) => /\b(QSB|QRM|QRN)\b/.test(t))).toBe(true);
  });
});

describe("a caller in a run", () => {
  it("is in Canada less often in POTA than in a contest", () => {
    const rand = seeded(5);
    const share = (format: "pota" | "cwt") =>
      Array.from({ length: 5000 }, () => newRun(format, rand).them).filter(canadian).length / 5000;
    expect(share("pota")).toBeLessThan(share("cwt"));
    expect(randomCaller(seeded(3)).nr).toBeDefined();
  });
});
