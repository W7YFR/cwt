/* The speed a recording is sent at, measured from what the decoder read. */

import { describe, expect, it } from "vitest";
import { synthesize } from "@/audio/synth";
import { decodeRecording } from "@/copy/decode";
import { sendScript, type Script } from "@/copy/generate";
import { speedOf, speedsOf } from "@/copy/measure";
import { targetTiming } from "@/timing/model";

const RATE = 8000;

/** Two stations, each at its own speed, sent from text: every character's
 *  time is exact. */
function script(a: { charWpm: number; farnsworthWpm: number }, b: { charWpm: number; farnsworthWpm: number }): Script {
  return {
    kind: "text",
    stations: [
      { call: "W7YFR", toneHz: 600, speed: a },
      { call: "N1AK", toneHz: 700, speed: b },
    ],
    lines: [
      { station: 0, text: "CQ CQ DE W7YFR W7YFR K" },
      { station: 1, text: "W7YFR DE N1AK UR 599 NAME BOB KN" },
      { station: 0, text: "N1AK DE W7YFR TU UR 579 NAME ROB QTH WA BK" },
      { station: 1, text: "R TU 73 DE N1AK <SK>" },
    ],
  };
}

describe("a station's speed", () => {
  it("is the speed each station sent at, from exact times", () => {
    const rec = sendScript(script({ charWpm: 25, farnsworthWpm: 25 }, { charWpm: 18, farnsworthWpm: 18 }), { gapSec: 1 }).rec;
    expect(speedsOf(rec)).toEqual([
      { charWpm: 25, farnsworthWpm: 25 },
      { charWpm: 18, farnsworthWpm: 18 },
    ]);
  });

  it("reads a station that spaces its characters out as Farnsworth", () => {
    const rec = sendScript(script({ charWpm: 20, farnsworthWpm: 12 }, { charWpm: 22, farnsworthWpm: 22 }), { gapSec: 1 }).rec;
    const [a, b] = speedsOf(rec);
    expect(a!.charWpm).toBe(20);
    expect(Math.abs(a!.farnsworthWpm - 12)).toBeLessThanOrEqual(1);
    expect(b).toEqual({ charWpm: 22, farnsworthWpm: 22 });
  });

  it("is close to the speed sent, from a recording the decoder read", () => {
    for (const wpm of [15, 20, 28]) {
      const timing = targetTiming(wpm, wpm);
      const samples = synthesize("CQ CQ DE W7YFR W7YFR K", timing, { toneHz: 600, rate: RATE, padSec: 0.5, amplitude: 0.5 }).samples;
      const rec = decodeRecording(samples, RATE)!;
      const speed = speedOf(rec.overs)!;
      expect(Math.abs(speed.charWpm - wpm), `${wpm} wpm`).toBeLessThanOrEqual(1);
      expect(speed.farnsworthWpm, `${wpm} wpm overall`).toBe(speed.charWpm);
    }
  });

  it("reads Farnsworth spacing in a recording the decoder read", () => {
    for (const [c, f] of [[20, 12], [25, 15]] as const) {
      const timing = targetTiming(c, f);
      const samples = synthesize("CQ CQ DE W7YFR W7YFR K", timing, { toneHz: 600, rate: RATE, padSec: 0.5, amplitude: 0.5 }).samples;
      const speed = speedOf(decodeRecording(samples, RATE)!.overs)!;
      expect(Math.abs(speed.charWpm - c), `${c}/${f} character`).toBeLessThanOrEqual(1);
      expect(Math.abs(speed.farnsworthWpm - f), `${c}/${f} overall`).toBeLessThanOrEqual(1);
    }
  });

  it("is nothing for no lines", () => {
    expect(speedOf([])).toBeNull();
  });
});
