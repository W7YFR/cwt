/* A station on a bug: even dits, long dahs made by hand, its own swing.
 *
 * What you hear (`keyingPlan`) and what the page shows (`idealTimeline`) both
 * come from `keyed`, so they must agree mark for mark. A line sounds the
 * same each time, and keeps the station's speed.
 */

import { describe, expect, it } from "vitest";
import { keyingPlan, synthesize } from "@/audio/synth";
import { makeScript, qrmLines, sendScript } from "@/copy/generate";
import { qrmPart } from "@/copy/band";
import { overOfText } from "@/copy/lines";
import { newQso } from "@/qso/cq";
import { ACADEMY, FORMATS } from "@/qso/formats";
import { newRun } from "@/qso/run";
import { asFriend, onKey, randomStation, STANDARD_KEYS, withKeys, type FriendInfo, type Station } from "@/qso/station";
import { seeded } from "@/audio/qsb";
import { bugFist, fistFor, isFist, keyed, type Fist } from "@/timing/fist";
import { targetTiming } from "@/timing/model";
import { idealTimeline } from "@/timing/timeline";
import type { Timeline } from "@/types";

const LINE = "CQ CQ DE W7YFR W7YFR K = TNX FER CALL UR RST 579 579 NAME HR JIM QTH SALEM OR = HW CPY? KN";
const AT_20 = targetTiming(20, 20);

const durs = (tl: Timeline, kind: string) => tl.blocks.filter((b) => b.kind === kind).map((b) => b.t1 - b.t0);
const mean = (a: readonly number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const spread = (a: readonly number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))) / mean(a);

describe("a keyer", () => {
  it("keys exactly, as before", () => {
    const tl = idealTimeline(LINE, AT_20);
    for (const b of tl.blocks) expect(b.units).toBe(b.targetUnits);
    expect(keyingPlan(LINE, AT_20, undefined)).toEqual(keyingPlan(LINE, AT_20));
  });
});

describe("a bug", () => {
  const fists = [1, 7, 42, 99, 2024].map(bugFist);

  it("sounds as the page shows it, mark for mark", () => {
    for (const fist of fists) {
      const tl = idealTimeline(LINE, AT_20, {}, fist);
      const plan = keyingPlan(LINE, AT_20, fist);
      expect(plan.map(([on]) => on)).toEqual(tl.blocks.map((b) => b.kind === "dit" || b.kind === "dah"));
      plan.forEach(([, sec], i) => expect(sec).toBeCloseTo(tl.blocks[i]!.t1 - tl.blocks[i]!.t0, 9));
      // The Copy page's answer key too.
      const over = overOfText(LINE, 20, 20, fist);
      expect(over.t1).toBeCloseTo(tl.duration, 9);
      expect(over.words.flatMap((w) => w.chars.map((c) => c.t0))).toEqual(tl.chars.map((c) => c.t0));
    }
  });

  it("sends a line the same way each time, and another line another way", () => {
    const fist = fists[0]!;
    expect(keyingPlan(LINE, AT_20, fist)).toEqual(keyingPlan(LINE, AT_20, { ...fist }));
    const a = synthesize("TU 73", AT_20, { fist }).samples;
    expect(synthesize("TU 73", AT_20, { fist }).samples).toEqual(a);
    const tu = keyingPlan("TU", AT_20, fist);
    expect(keyingPlan("TU EE", AT_20, fist).slice(0, tu.length)).not.toEqual(tu);
  });

  it("keeps the station's speed, Farnsworth too", () => {
    for (const timing of [AT_20, targetTiming(28, 28), targetTiming(20, 14)]) {
      const keyer = idealTimeline(LINE, timing).duration;
      for (const fist of fists) {
        const ratio = idealTimeline(LINE, timing, {}, fist).duration / keyer;
        expect(ratio).toBeGreaterThan(0.92);
        expect(ratio).toBeLessThan(1.08);
      }
    }
  });

  it("makes even dits and long dahs that vary", () => {
    for (const fist of fists) {
      const tl = idealTimeline(LINE, AT_20, {}, fist);
      const dits = durs(tl, "dit");
      const dahs = durs(tl, "dah");
      expect(spread(dits)).toBeLessThan(0.03);
      expect(spread(dahs)).toBeGreaterThan(0.04);
      // Light, quick dits, and dahs of 4 to 5 of them, not 3.
      expect(mean(dits)).toBeLessThan(AT_20.unitSec);
      expect(mean(dahs) / mean(dits)).toBeGreaterThan(3.6);
      expect(mean(dahs) / mean(dits)).toBeLessThan(5.6);
      // Every dah still reads as a dah.
      expect(Math.min(...dahs)).toBeGreaterThan(2 * Math.max(...dits));
    }
  });

  it("spaces out two letters when the first ends as the next begins: its swing", () => {
    const steady: Fist = { ...bugFist(1), gapSpread: 0, dahSpread: 0, swing: 0 };
    const gapsOf = (fist: Fist) => keyed(["TMTE"], AT_20, fist)[0]!.chars.map((c) => c.gap);
    const [, tm0, mt0, te0] = gapsOf(steady);
    const [, tm, mt, te] = gapsOf({ ...steady, swing: 1.2 });
    // T to M and M to T meet dah to dah; T to E does not.
    expect(tm! / te!).toBeGreaterThan(tm0! / te0! + 0.2);
    expect(mt! / te!).toBeGreaterThan(mt0! / te0! + 0.2);
  });

  it("is made for a key worked by hand, and none for a keyer", () => {
    expect(fistFor("keyer", 3)).toBeUndefined();
    expect(fistFor("bug", 3)).toEqual(bugFist(3));
  });

  it("draws out the dah of an R on its own now and then: a proper roger", () => {
    const fist = bugFist(7);
    const dahOf = (f: Fist, text: string, word: number) => keyed(text.split(" "), AT_20, f)[word]!.chars[0]!.marks[1]!;
    // R R, and the R that starts RST: only an R on its own.
    const text = "R R RST";
    const always = { ...fist, roger: 1 };
    const never = { ...fist, roger: 0 };
    expect(dahOf(always, text, 0) / dahOf(never, text, 0)).toBeGreaterThan(1.8);
    expect(dahOf(always, text, 1) / dahOf(never, text, 1)).toBeGreaterThan(1.8);
    expect(dahOf(always, text, 2)).toBeLessThan(dahOf(always, text, 0) / 1.8);
    // Over ten of the operator's dits, and the page shows it as the sound has it.
    const dit = keyed(["R"], AT_20, always)[0]!.chars[0]!.marks[0]!;
    expect(dahOf(always, text, 0) / dit).toBeGreaterThan(10);
    const blocks = idealTimeline(text, AT_20, {}, always).blocks;
    keyingPlan(text, AT_20, always).forEach(([, sec], i) => expect(sec).toBeCloseTo(blocks[i]!.t1 - blocks[i]!.t0, 9));
  });

  it("reads back only a whole fist", () => {
    expect(isFist(bugFist(3))).toBe(true);
    expect(isFist(JSON.parse(JSON.stringify(bugFist(3))))).toBe(true);
    expect(isFist({ ...bugFist(3), dah: "long" })).toBe(false);
    expect(isFist({ ...bugFist(3), key: "keyer" })).toBe(false);
    expect(isFist(null)).toBe(false);
  });
});

/** A rand that counts its draws. */
function counted(seed: number): { rand: () => number; draws: () => number } {
  const r = seeded(seed);
  let n = 0;
  return { rand: () => (n++, r()), draws: () => n };
}

describe("who keys on a bug", () => {
  const stations = (n: number): Station[] => {
    const rand = seeded(5);
    return Array.from({ length: n }, () => randomStation(rand));
  };

  it("draws nothing from the QSO's random numbers", () => {
    const a = counted(11);
    const b = counted(11);
    newQso(a.rand);
    randomStation(b.rand);
    expect(a.draws()).toBe(b.draws());
    expect(newRun("sst", seeded(3)).them.call).toBe(newRun("sst", seeded(3)).them.call);
  });

  it("may change from one QSO to the next, with the same fist on a bug", () => {
    for (const s of stations(50)) expect(onKey(s, { bug: 0.5 })).toEqual(onKey({ ...s }, { bug: 0.5 }));
    // One call, made again: its habit is drawn new each time.
    const again = Array.from({ length: 40 }, (_, i) => onKey({ ...stations(1)[0]!, habit: 0.05 + i / 160 }, { bug: 0.5 }));
    const bugs = again.filter((s) => s.fist);
    expect(bugs.length).toBeGreaterThan(0);
    expect(bugs.length).toBeLessThan(again.length);
    for (const s of bugs) expect(s.fist).toEqual(bugs[0]!.fist);
  });

  it("is about as many stations as the chance says, and no CW Academy student", () => {
    const all = stations(2000);
    const share = (chances: typeof STANDARD_KEYS) => all.filter((s) => onKey(s, chances).fist?.key === "bug").length / all.length;
    const bug = STANDARD_KEYS.bug!;
    expect(share(STANDARD_KEYS)).toBeGreaterThan(bug - 0.03);
    expect(share(STANDARD_KEYS)).toBeLessThan(bug + 0.03);
    expect(share(FORMATS.cwt.keys)).toBeLessThan(share(FORMATS.sst.keys));
    expect(share({})).toBe(0);
    expect(all.every((s) => !onKey({ ...s, nr: ACADEMY }, { bug: 1 }).fist)).toBe(true);
  });

  it("is a friend set to Bug, never a friend set to Keyer, and now and then one set to Both", () => {
    const friend: FriendInfo = {
      callsign: "K7ABC", name: "BOB", cwopsNumber: "", qthCity: "", qthRegionShort: "", rigManufacturer: "",
      rigModel: "", rigPower: "", antenna: "", wpm: 22, farnsworthWpm: 22,
    };
    const onBug = onKey(stations(1)[0]!, { bug: 1 });
    expect(onBug.fist).toBeDefined();
    expect(asFriend(onBug, friend).fist).toBeUndefined();
    expect(asFriend(onBug, { ...friend, keys: ["keyer"] }).fist).toBeUndefined();
    const bug = asFriend(onBug, { ...friend, keys: ["bug"] });
    expect(isFist(bug.fist)).toBe(true);
    expect(asFriend(stations(2)[1]!, { ...friend, keys: ["bug"] }).fist).toEqual(bug.fist);
    // Both: each time they call, a new pick, and the same fist on the bug.
    const both = stations(200).map((s) => asFriend(s, { ...friend, keys: ["keyer", "bug"] }));
    const bugs = both.filter((s) => s.fist);
    expect(bugs.length / both.length).toBeGreaterThan(0.35);
    expect(bugs.length / both.length).toBeLessThan(0.65);
    for (const s of bugs) expect(s.fist).toEqual(bug.fist);
  });

  it("reaches the Copy page's generated QSOs, sound and answer key", () => {
    let found = false;
    for (let seed = 1; seed < 200 && !found; seed++) {
      const script = makeScript({ kind: "cq", rand: seeded(seed) });
      const at = script.stations.findIndex((s) => s.fist);
      if (at < 0) continue;
      found = true;
      const station = script.stations[at]!;
      const line = script.lines.find((l) => l.station === at)!;
      const { rec } = sendScript({ ...script, lines: [line] }, { gapSec: 1 });
      const timing = targetTiming(station.speed.charWpm, station.speed.farnsworthWpm);
      expect(rec.overs[0]!.t1 - rec.overs[0]!.t0).toBeCloseTo(idealTimeline(line.text, timing, {}, station.fist).duration, 9);
    }
    expect(found).toBe(true);
  });

  it("reaches the QRM station", () => {
    let found = false;
    for (let seed = 1; seed < 300 && !found; seed++) {
      const lines = qrmLines(seeded(seed));
      const line = lines.find((l) => l.fist);
      if (!line) continue;
      found = true;
      const part = (fist?: Fist) =>
        qrmPart({ n: 8000 * 120, rate: 8000, toneHz: 600, peak: 0.5, qrn: 0, qsbDb: 0, seed: 1, qrmLines: () => [{ ...line, fist }] });
      expect(isFist(line.fist)).toBe(true);
      expect(part(line.fist)).not.toEqual(part());
    }
    expect(found).toBe(true);
  });

  it("is what Style checks, when it sets the keys, and never a friend's", () => {
    const all = stations(200).map((s) => onKey(s, STANDARD_KEYS));
    expect(all.map((s) => withKeys(s, null))).toEqual(all);
    expect(all.every((s) => !withKeys(s, ["keyer"]).fist)).toBe(true);
    for (const s of all) expect(withKeys(s, ["bug"]).fist).toEqual(onKey(s, { bug: 1 }).fist);
    const both = all.filter((s) => withKeys(s, ["keyer", "bug"]).fist).length / all.length;
    expect(both).toBeGreaterThan(0.35);
    expect(both).toBeLessThan(0.65);
    const friend = { ...onKey(all[0]!, { bug: 1 }), friend: true };
    expect(withKeys(friend, ["keyer"])).toEqual(friend);
  });

  it("is what Style checks in the Copy page's generated QSOs", () => {
    for (let seed = 1; seed < 20; seed++) {
      expect(makeScript({ kind: "cq", rand: seeded(seed), keys: ["bug"] }).stations.every((s) => s.fist)).toBe(true);
      expect(makeScript({ kind: "cwt", rand: seeded(seed), keys: ["keyer"] }).stations.some((s) => s.fist)).toBe(false);
      // Style draws nothing: the same QSO, keyed another way.
      const a = makeScript({ kind: "sst", rand: seeded(seed) });
      const b = makeScript({ kind: "sst", rand: seeded(seed), keys: ["bug"] });
      expect(b.lines).toEqual(a.lines);
    }
  });
});
