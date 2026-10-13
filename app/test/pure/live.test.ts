/* Following a take while it is sent.
 *
 * The recordings are fed in as the microphone delivers them, a block of 128
 * samples at a time, and the follower is asked how far the sender has got
 * four times a second. That is the schedule the Zen sheet runs it on.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";
import { keyingPlan, synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { Decimator, LiveFollower, keyedSymbols, reached } from "@/timing/live";

describe("how far the sender has got", () => {
  const CQ = keyedSymbols("CQ DE W7YFR");

  it("counts the characters that match", () => {
    expect(reached(CQ, [])).toBe(0);
    expect(reached(CQ, ["C", "Q", "D"])).toBe(3);
  });

  it("does not move for a click before the first character", () => {
    expect(reached(CQ, ["E"])).toBe(0);
    expect(reached(CQ, ["E", "E"])).toBe(0);
    expect(reached(CQ, ["E", "C", "Q"])).toBe(2);
  });

  it("passes a wrong character when the next one matches", () => {
    expect(reached(CQ, ["C", "Q", "X"])).toBe(2);
    expect(reached(CQ, ["C", "Q", "X", "E"])).toBe(4);
  });

  it("passes a dropped character when the next one matches", () => {
    expect(reached(CQ, ["C", "Q", "E"])).toBe(4);
  });

  it("matches a character by its Morse", () => {
    expect(reached(keyedSymbols("TU <BT> 73"), ["T", "U", "="])).toBe(3);
  });

  it("follows into the next pass", () => {
    const twice = [...CQ, ...CQ];
    expect(reached(twice, [...CQ, "C", "Q"])).toBe(CQ.length + 2);
  });
});

describe("the characters of a message", () => {
  it("keeps prosigns whole and leaves out what has no Morse", () => {
    expect(keyedSymbols("cq <SK> | 5nn~")).toEqual(["C", "Q", "<SK>", "5", "N", "N"]);
  });
});

describe("reducing the rate", () => {
  it("averages each run of samples into one", () => {
    const d = new Decimator(48000);
    expect(d.factor).toBe(6);
    expect(d.rate).toBe(8000);
    d.push(new Float32Array([1, 1, 1, 1]));
    expect(d.samples().length).toBe(0);
    d.push(new Float32Array([1, 1, 3, 3, 3, 3, 3]));
    expect(Array.from(d.samples())).toEqual([1]);
    d.push(new Float32Array([3]));
    expect(Array.from(d.samples())).toEqual([1, 3]);
  });

  it("leaves a rate at or below the live rate alone", () => {
    expect(new Decimator(8000).factor).toBe(1);
  });
});

/** The count after each quarter second of a recording, and one second of
 *  silence after it. */
function follow(file: string, message: string, wpm: number): number[] {
  const wav = readWav(join(DATA_DIR, file));
  const f = new LiveFollower(wav.rate, keyedSymbols(message), targetTiming(wpm, wpm));
  const step = Math.round(wav.rate / 4);
  const counts: number[] = [];
  for (let at = 0; at < wav.samples.length + wav.rate; at += step) {
    const piece =
      at < wav.samples.length ? wav.samples.subarray(at, at + step) : new Float32Array(step);
    for (let k = 0; k < piece.length; k += 128) f.push(piece.subarray(k, k + 128));
    counts.push(f.step());
  }
  return counts;
}

describe("following a recording", () => {
  const CASES: Array<[string, string, number]> = [
    ["cq-de-w7yfr-mic-1.wav", "CQ DE W7YFR", 25],
    ["cq-de-w7yfr-mic-2.wav", "CQ DE W7YFR", 25],
    ["cq-ab1cd-20wpm-k3ng.wav", "CQ CQ DE AB1CD K", 20],
    ["k3ng/cq-de-w7yfr/k3ng-webcam-cq-de-w7yfr-15wpm.wav", "CQ DE W7YFR", 15],
  ];

  for (const [file, message, wpm] of CASES) {
    it.skipIf(!existsSync(join(DATA_DIR, file)))(`reaches the end of ${file}`, () => {
      const counts = follow(file, message, wpm);
      const total = keyedSymbols(message).length;
      expect(counts[0], "nothing is sent in the first quarter second").toBe(0);
      expect(counts[counts.length - 1]).toBe(total);
      // One character at a time: no step jumps over a character.
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]! - counts[i - 1]!, `step ${i}`).toBeLessThanOrEqual(2);
      }
    });
  }

  /* The webcam picked up two clicks before the first character. They decode
     as E, and with the tone locked on them nothing after decoded at all. */
  /* The loopback capture of the same take puts the first dah of the C at
     1.12 s. The clicks come before it. */
  it("counts nothing for the clicks, and the C once it starts", () => {
    const file = "k3ng/cq-de-w7yfr/k3ng-webcam-cq-de-w7yfr-15wpm.wav";
    if (!existsSync(join(DATA_DIR, file))) return;
    const counts = follow(file, "CQ DE W7YFR", 15);
    expect(counts.slice(0, 4), "to 1.0 s").toEqual([0, 0, 0, 0]);
    expect(counts[5], "at 1.5 s").toBe(1);
  });
});

describe("the character being keyed", () => {
  /* Where the sender is, which is the character they have started. Measured
     on synthesized keying, where each character's first element is known to
     the sample, at the step the sheet runs at. */
  for (const wpm of [15, 20, 30]) {
    it(`counts from its first element at ${wpm} wpm`, () => {
      const message = "CQ DE W7YFR";
      const timing = targetTiming(wpm, wpm);
      const pad = 0.5;
      const { samples, rate } = synthesize(message, timing, { rate: 48000, padSec: pad });

      const starts: number[] = [];
      let t = pad;
      let after = true; // after a character or word gap
      for (const [on, sec] of keyingPlan(message, timing)) {
        if (on && after) starts.push(t);
        after = !on && sec > 1.5 * timing.unitSec;
        t += sec;
      }

      const f = new LiveFollower(rate, keyedSymbols(message), timing);
      const step = Math.round(rate * 0.05);
      const reachedAt: number[] = [];
      for (let at = 0; at < samples.length; at += step) {
        f.push(samples.subarray(at, at + step));
        const n = f.step();
        while (reachedAt.length < n) reachedAt.push(Math.min(at + step, samples.length) / rate);
      }

      expect(reachedAt.length).toBe(starts.length);
      starts.forEach((start, i) => {
        const lag = reachedAt[i]! - start;
        expect(lag, `character ${i} counted before it started`).toBeGreaterThan(0);
        // The first waits for a dah, since a lone dit could be a click.
        const allowed = (i === 0 ? 4 : 2) * timing.unitSec + 0.05;
        expect(lag, `character ${i}`).toBeLessThanOrEqual(allowed);
      });
    });
  }
});
