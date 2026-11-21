/* A station on a bug: even dits, long dahs made by hand, its own swing. A
 * station on a straight key: every mark by hand, often heavy, wide gaps.
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
import { newRun, wpmOf } from "@/qso/run";
import { asFriend, onKey, randomStation, STANDARD_KEYS, withKeys, type FriendInfo, type Station } from "@/qso/station";
import { seeded, seedOf } from "@/audio/qsb";
import { bugFist, fistFor, isFist, keyed, STRAIGHT_MOST_WPM, straightFist, type Fist } from "@/timing/fist";
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

  it("draws out a dah that ends a letter, the same in every letter", () => {
    const steady: Fist = { ...bugFist(1), dahSpread: 0, shapeSpread: 0, tempoSpread: 0, drag: 0, lastDah: 0 };
    const marks = (fist: Fist) => {
      const [q, t, n] = keyed(["Q", "TN"], AT_20, fist).flatMap((w) => w.chars.map((c) => c.marks));
      return { first: q![0]!, last: q![3]!, t: t![0]!, n: n![0]! };
    };
    const before = marks(steady);
    const after = marks({ ...steady, lastDah: 0.2 });
    expect(after.last / after.first / (before.last / before.first)).toBeCloseTo(1.2, 9);
    expect(after.t / before.t / (after.n / before.n)).toBeCloseTo(1.2, 9);
  });

  it("keeps a fist saved before the end dah, and takes that habit from its seed", () => {
    const { lastDah: _, ...saved } = bugFist(3);
    expect(isFist(JSON.parse(JSON.stringify(saved)))).toBe(true);
    expect(keyingPlan(LINE, AT_20, saved)).toEqual(keyingPlan(LINE, AT_20, bugFist(3)));
  });

  it("reads back only a whole fist", () => {
    expect(isFist(bugFist(3))).toBe(true);
    expect(isFist(JSON.parse(JSON.stringify(bugFist(3))))).toBe(true);
    expect(isFist({ ...bugFist(3), dah: "long" })).toBe(false);
    expect(isFist({ ...bugFist(3), key: "keyer" })).toBe(false);
    expect(isFist(null)).toBe(false);
  });
});

describe("a straight key", () => {
  const fists = [1, 7, 42, 99, 2024].map(straightFist);

  it("sounds as the page shows it, mark for mark", () => {
    for (const fist of fists) {
      const tl = idealTimeline(LINE, AT_20, {}, fist);
      const plan = keyingPlan(LINE, AT_20, fist);
      expect(plan.map(([on]) => on)).toEqual(tl.blocks.map((b) => b.kind === "dit" || b.kind === "dah"));
      plan.forEach(([, sec], i) => expect(sec).toBeCloseTo(tl.blocks[i]!.t1 - tl.blocks[i]!.t0, 9));
      const over = overOfText(LINE, 20, 20, fist);
      expect(over.t1).toBeCloseTo(tl.duration, 9);
    }
  });

  it("sends a line the same way each time", () => {
    const fist = fists[0]!;
    expect(keyingPlan(LINE, AT_20, fist)).toEqual(keyingPlan(LINE, AT_20, { ...fist }));
    expect(keyingPlan(LINE, AT_20, fist)).not.toEqual(keyingPlan(LINE, AT_20, fists[1]));
  });

  it("keeps the station's speed, Farnsworth too, up to a straight key's top speed", () => {
    const top = STRAIGHT_MOST_WPM;
    for (const timing of [AT_20, targetTiming(top, top), targetTiming(20, 14)]) {
      const keyer = idealTimeline(LINE, timing).duration;
      for (const fist of fists) {
        const ratio = idealTimeline(LINE, timing, {}, fist).duration / keyer;
        expect(ratio).toBeGreaterThan(0.92);
        expect(ratio).toBeLessThan(1.08);
      }
    }
    // Faster than that, it sends at that speed, Farnsworth gaps slowed alike.
    for (const [asked, sent] of [
      [targetTiming(35, 35), targetTiming(top, top)],
      [targetTiming(35, 21), targetTiming(top, (21 * top) / 35)],
    ] as const) {
      for (const fist of fists) {
        expect(keyingPlan(LINE, asked, fist)).toEqual(keyingPlan(LINE, sent, fist));
        expect(idealTimeline(LINE, asked, {}, fist).duration).toBeCloseTo(idealTimeline(LINE, sent, {}, fist).duration, 9);
      }
    }
    // A bug is not held back.
    expect(keyingPlan(LINE, targetTiming(35, 35), bugFist(1))).not.toEqual(keyingPlan(LINE, targetTiming(top, top), bugFist(1)));
  });

  it("makes dits that vary as dahs do, dahs near 3 dits, and wider gaps between letters", () => {
    for (const fist of fists) {
      const tl = idealTimeline(LINE, AT_20, {}, fist);
      const dits = durs(tl, "dit");
      const dahs = durs(tl, "dah");
      expect(spread(dits)).toBeGreaterThan(0.06);
      expect(spread(dahs)).toBeGreaterThan(0.06);
      expect(mean(dahs) / mean(dits)).toBeGreaterThan(2.6);
      expect(mean(dahs) / mean(dits)).toBeLessThan(3.8);
      // Every dah still reads as a dah.
      expect(Math.min(...dahs)).toBeGreaterThan(1.6 * Math.max(...dits));
      const chars = keyed(LINE.split(" "), AT_20, fist).flatMap((w) => w.chars);
      const gaps = chars.map((c) => c.gap).filter((g) => g > 0);
      const spaces = chars.flatMap((c) => c.spaces);
      expect(mean(gaps) / mean(spaces)).toBeGreaterThan(3);
    }
  });

  it("keys heavy with a heavy fist: marks long, spaces short", () => {
    const usual = { ...straightFist(1), markSpread: 0, gapSpread: 0, shapeSpread: 0 };
    const markToSpace = (fist: Fist) => {
      const c = keyed(["S"], AT_20, fist)[0]!.chars[0]!;
      return c.marks[0]! / c.spaces[0]!;
    };
    expect(markToSpace({ ...usual, weight: 0.5 })).toBeCloseTo(1, 1);
    expect(markToSpace({ ...usual, weight: 0.6 })).toBeGreaterThan(1.4);
  });

  it("draws out a dah that ends a letter with that habit, as in Q and T", () => {
    const steady: Fist = { ...straightFist(1), markSpread: 0, shapeSpread: 0, tempoSpread: 0, drag: 0, lastDah: 0 };
    const marks = (fist: Fist) => {
      const [q, t, n] = keyed(["Q", "TN"], AT_20, fist).flatMap((w) => w.chars.map((c) => c.marks));
      return { first: q![0]!, last: q![3]!, t: t![0]!, n: n![0]! };
    };
    const { first: first0, last: last0, t: t0, n: n0 } = marks(steady);
    const { first, last, t, n } = marks({ ...steady, lastDah: 0.2 });
    expect(last0 / first0).toBeCloseTo(1, 9);
    expect(last / first).toBeCloseTo(1.2, 9);
    // T ends on its dah; N does not.
    expect(t / t0 / (n / n0)).toBeCloseTo(1.2, 9);
  });

  it("is steady for most operators, and varies more for a newcomer", () => {
    const all = Array.from({ length: 400 }, (_, i) => straightFist(i));
    const newcomers = all.filter((f) => f.markSpread > 0.06);
    expect(newcomers.length / all.length).toBeGreaterThan(0.08);
    expect(newcomers.length / all.length).toBeLessThan(0.25);
    const ditSpread = (fist: Fist) => spread(durs(idealTimeline(LINE, AT_20, {}, fist), "dit"));
    const steady = all.filter((f) => f.markSpread <= 0.06).slice(0, 5);
    expect(Math.min(...newcomers.slice(0, 5).map(ditSpread))).toBeGreaterThan(Math.max(...steady.map(ditSpread)));
  });

  it("is made for a straight key, and reads back only whole", () => {
    expect(fistFor("straight", 3)).toEqual(straightFist(3));
    expect(isFist(JSON.parse(JSON.stringify(straightFist(3))))).toBe(true);
    expect(isFist({ ...straightFist(3), markSpread: undefined })).toBe(false);
    // A bug's numbers are not a straight key's.
    expect(isFist({ ...bugFist(3), key: "straight" })).toBe(false);
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

  it("is a straight key now and then, rarely in a CWT, and never past its top speed in a run", () => {
    const all = stations(4000);
    const share = (chances: typeof STANDARD_KEYS) =>
      all.filter((s) => onKey(s, chances).fist?.key === "straight").length / all.length;
    const straight = STANDARD_KEYS.straight!;
    expect(share(STANDARD_KEYS)).toBeGreaterThan(straight - 0.02);
    expect(share(STANDARD_KEYS)).toBeLessThan(straight + 0.02);
    expect(share(FORMATS.cwt.keys)).toBeLessThan(0.02);
    expect(share(FORMATS.cwt.keys)).toBeLessThan(share(FORMATS.sst.keys));
    // The bug stations stay on a bug.
    for (const s of all.slice(0, 500)) {
      if (onKey(s, { bug: STANDARD_KEYS.bug! }).fist) expect(onKey(s, STANDARD_KEYS).fist?.key).toBe("bug");
    }
    const onStraight = onKey(all[0]!, { straight: 1 });
    for (const format of ["cwt", "sst", "mst", "pota"] as const) {
      const [lo, hi] = wpmOf(format, onStraight);
      expect(hi).toBeLessThanOrEqual(STRAIGHT_MOST_WPM);
      expect(lo).toBeLessThanOrEqual(hi);
      if (FORMATS[format].wpm[1] <= STRAIGHT_MOST_WPM) expect([lo, hi]).toEqual(FORMATS[format].wpm);
    }
    expect(wpmOf("cwt", onKey(all[0]!, { bug: 1 }))).toEqual(FORMATS.cwt.wpm);
  });

  it("is a friend set to Straight key, with any mix of the keys", () => {
    const friend: FriendInfo = {
      callsign: "K7ABC", name: "BOB", cwopsNumber: "", qthCity: "", qthRegionShort: "", rigManufacturer: "",
      rigModel: "", rigPower: "", antenna: "", wpm: 22, farnsworthWpm: 22,
    };
    expect(asFriend(stations(1)[0]!, { ...friend, keys: ["straight"] }).fist).toEqual(straightFist(seedOf("K7ABC")));
    const all = stations(300).map((s) => asFriend(s, { ...friend, keys: ["keyer", "bug", "straight"] }));
    for (const kind of [undefined, "bug", "straight"]) {
      const n = all.filter((s) => s.fist?.key === kind).length / all.length;
      expect(n).toBeGreaterThan(0.2);
      expect(n).toBeLessThan(0.47);
    }
  });

  it("is what Style checks in the Copy page's generated QSOs", () => {
    for (let seed = 1; seed < 20; seed++) {
      expect(makeScript({ kind: "cq", rand: seeded(seed), keys: ["bug"] }).stations.every((s) => s.fist)).toBe(true);
      expect(makeScript({ kind: "cwt", rand: seeded(seed), keys: ["straight"] }).stations.every((s) => s.fist?.key === "straight")).toBe(true);
      expect(makeScript({ kind: "cwt", rand: seeded(seed), keys: ["keyer"] }).stations.some((s) => s.fist)).toBe(false);
      // Style draws nothing: the same QSO, keyed another way.
      const a = makeScript({ kind: "sst", rand: seeded(seed) });
      const b = makeScript({ kind: "sst", rand: seeded(seed), keys: ["bug"] });
      expect(b.lines).toEqual(a.lines);
    }
  });
});
