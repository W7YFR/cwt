/* A made-up QSO for the Copy page: its script, and the sound and answer key
 * sent from it. */

import { describe, expect, it } from "vitest";
import { PITCH_APART_HZ, makeScript, sendScript, type Kind } from "@/copy/generate";
import { GUIDE_IDS } from "@/qso/examples";

/** A fixed sequence, so each QSO is the same every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe("a made-up QSO", () => {
  it("runs to its end, for every kind", () => {
    for (const kind of GUIDE_IDS) {
      for (let seed = 1; seed <= 40; seed++) {
        const script = makeScript({ kind, rand: seeded(seed), qsos: 3 });
        expect(script.lines[0]!.station).toBe(0);
        expect(script.lines[0]!.text).toMatch(kind === "cq" ? /^CQ / : new RegExp(kind.toUpperCase()));
        // The station that runs, and one station per QSO.
        expect(script.stations).toHaveLength(kind === "cq" ? 2 : 4);
        const calls = script.stations.map((s) => s.call);
        expect(new Set(calls).size).toBe(calls.length);
        // Each caller apart in pitch from the station it works.
        const [runs, ...callers] = script.stations.map((s) => s.toneHz);
        for (const hz of callers) expect(Math.abs(hz - runs!)).toBeGreaterThanOrEqual(PITCH_APART_HZ);
      }
    }
  });

  it("is a run of as many QSOs as asked", () => {
    for (const qsos of [1, 5]) {
      const script = makeScript({ kind: "cwt", rand: seeded(7), qsos });
      expect(script.stations).toHaveLength(qsos + 1);
    }
  });

  it("is a rag chew of each length", () => {
    const lines = (length: "full" | "short" | "pieces") =>
      makeScript({ kind: "cq", rand: seeded(3), length }).lines.length;
    expect(lines("pieces")).toBeGreaterThan(lines("full"));
  });

  it("sends a run at the format's speeds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const script = makeScript({ kind: "sst", rand: seeded(seed) });
      for (const s of script.stations) {
        expect(s.speed.farnsworthWpm).toBeGreaterThanOrEqual(14);
        expect(s.speed.farnsworthWpm).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe("a made-up QSO, sent", () => {
  const script = makeScript({ kind: "pota" as Kind, rand: seeded(11), qsos: 2 });
  const sent = sendScript(script, { gapSec: 1 });

  it("has one line of the key per line of the script, in order, apart", () => {
    const { overs } = sent.rec;
    expect(overs.map((o) => o.text)).toEqual(script.lines.map((l) => l.text));
    expect(overs.map((o) => o.sender)).toEqual(script.lines.map((l) => l.station));
    for (let i = 1; i < overs.length; i++) expect(overs[i]!.t0 - overs[i - 1]!.t1).toBeCloseTo(1, 6);
    for (const o of overs) {
      for (const w of o.words) for (const c of w.chars) expect(c.t0 >= o.t0 && c.t1 <= o.t1 + 1e-9).toBe(true);
    }
    expect(sent.rec.senders.map((s) => s.call)).toEqual(script.stations.map((s) => s.call));
  });

  it("sounds where the key has a character, and is silent between lines", () => {
    const { samples, rate, rec } = sent;
    expect(samples.length).toBe(Math.ceil(rec.durationSec * rate));
    const peak = (t0: number, t1: number) => {
      let p = 0;
      for (let i = Math.floor(t0 * rate); i < Math.ceil(t1 * rate); i++) p = Math.max(p, Math.abs(samples[i]!));
      return p;
    };
    for (const o of rec.overs) {
      const c = o.words[0]!.chars[0]!;
      expect(peak(c.t0, c.t1)).toBeGreaterThan(0.5);
    }
    for (let i = 1; i < rec.overs.length; i++) expect(peak(rec.overs[i - 1]!.t1 + 0.01, rec.overs[i]!.t0 - 0.01)).toBe(0);
  });

  it("sends every station at one speed when given", () => {
    const slow = sendScript(script, { gapSec: 1, speed: { charWpm: 10, farnsworthWpm: 10 } });
    expect(slow.rec.durationSec).toBeGreaterThan(sent.rec.durationSec);
    const longer = sendScript(script, { gapSec: 2 });
    expect(longer.rec.durationSec - sent.rec.durationSec).toBeCloseTo(script.lines.length - 1, 6);
  });
});
