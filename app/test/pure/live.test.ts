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
import {
  Decimator,
  END_QUIET_DITS,
  END_QUIET_SEC,
  LiveFollower,
  graded,
  keyedSymbols,
} from "@/timing/live";

describe("grading what has been sent", () => {
  const CQ = keyedSymbols("CQ DE W7YFR");
  /** The verdicts as one string: + right, x wrong. */
  const marks = (target: readonly string[], sent: readonly string[]) =>
    graded(target, sent)
      .map((ok) => (ok ? "+" : "x"))
      .join("");

  it("grades each character sent right", () => {
    expect(marks(CQ, [])).toBe("");
    expect(marks(CQ, ["C", "Q", "D"])).toBe("+++");
  });

  it("grades nothing for a click before the first character", () => {
    expect(marks(CQ, ["E"])).toBe("");
    expect(marks(CQ, ["E", "E"])).toBe("");
    expect(marks(CQ, ["E", "C", "Q"])).toBe("++");
  });

  it("marks a wrong character wrong at once", () => {
    expect(marks(CQ, ["C", "Q", "X"])).toBe("++x");
    expect(marks(CQ, ["C", "Q", "X", "E"])).toBe("++x+");
  });

  it("marks a dropped character wrong", () => {
    expect(marks(CQ, ["C", "Q", "E"])).toBe("++x+");
  });

  it("gives an extra character no place", () => {
    expect(marks(CQ, ["C", "Q", "D", "D", "E", "W"])).toBe("+++++");
  });

  it("matches a character by its Morse", () => {
    expect(marks(keyedSymbols("TU <BT> 73"), ["T", "U", "="])).toBe("+++");
  });

  it("follows into the next pass", () => {
    const twice = [...CQ, ...CQ];
    expect(graded(twice, [...CQ, "C", "Q"]).length).toBe(CQ.length + 2);
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
    counts.push(f.step().reached);
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
        const n = f.step().reached;
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

describe("grading a take as it is sent", () => {
  /** The last reading of a whole take, fed at the sheet's step. */
  function last(samples: Float32Array, rate: number, target: string, wpm: number) {
    const f = new LiveFollower(rate, keyedSymbols(target), targetTiming(wpm, wpm));
    const step = Math.round(rate * 0.15);
    let out = f.step();
    for (let at = 0; at < samples.length; at += step) {
      f.push(samples.subarray(at, at + step));
      out = f.step();
    }
    return out.graded.map((ok) => (ok ? "+" : "x")).join("");
  }

  it("marks the one character sent wrong", () => {
    const timing = targetTiming(20, 20);
    const { samples, rate } = synthesize("CQ DE W7YXR", timing, { rate: 48000, padSec: 0.5 });
    expect(last(samples, rate, "CQ DE W7YFR", 20)).toBe("+++++++x+");
  });

  it("marks a character left out", () => {
    const timing = targetTiming(20, 20);
    const { samples, rate } = synthesize("CQ DE W7FR", timing, { rate: 48000, padSec: 0.5 });
    expect(last(samples, rate, "CQ DE W7YFR", 20)).toBe("++++++x++");
  });

  it("grades a whole recording right, to its last character", () => {
    const file = "k3ng/cq-de-w7yfr/k3ng-webcam-cq-de-w7yfr-15wpm.wav";
    if (!existsSync(join(DATA_DIR, file))) return;
    const wav = readWav(join(DATA_DIR, file));
    expect(last(wav.samples, wav.rate, "CQ DE W7YFR", 15)).toBe("+++++++++");
  });

  it("grades nothing past what has been read back", () => {
    // Cut in the middle of the F: the characters before it are graded, the F
    // is reached but not yet read.
    const timing = targetTiming(20, 20);
    const { samples, rate } = synthesize("CQ DE W7YF", timing, { rate: 48000, padSec: 0 });
    const cut = samples.subarray(0, samples.length - Math.round(rate * timing.unitSec * 2));
    const f = new LiveFollower(rate, keyedSymbols("CQ DE W7YFR"), timing);
    f.push(cut);
    const at = f.step();
    expect(at.graded.length).toBe(7);
    expect(at.reached).toBe(8);
  });
});

describe("the end of the message", () => {
  /* The last character is read back after a character gap. The take is done
     only once the key has stayed up four dits and a second after it, so the
     sender still has a chance to send it again. */
  it("waits after the last character before it is done", () => {
    const timing = targetTiming(20, 20);
    const { samples, rate } = synthesize("CQ DE W7YFR", timing, { rate: 48000, padSec: 0 });
    const f = new LiveFollower(rate, keyedSymbols("CQ DE W7YFR"), timing);
    f.push(samples);

    const wait = END_QUIET_DITS * timing.unitSec + END_QUIET_SEC;
    const quiet = (sec: number) => f.push(new Float32Array(Math.round(sec * rate)));

    quiet(timing.unitSec * 3);
    const read = f.step();
    expect(read.graded.length, "the last character is read back").toBe(9);
    expect(read.done, "but the take is not done").toBe(false);

    quiet(wait - timing.unitSec * 3 - 0.1);
    expect(f.step().done, "just before the wait is over").toBe(false);
    quiet(0.2);
    expect(f.step().done, "once the wait is over").toBe(true);
  });

  it("starts the wait over when the sender keys again", () => {
    const timing = targetTiming(20, 20);
    const { samples, rate } = synthesize("CQ DE W7YFR", timing, { rate: 48000, padSec: 0 });
    const f = new LiveFollower(rate, keyedSymbols("CQ DE W7YFR"), timing);
    f.push(samples);
    f.push(new Float32Array(Math.round(0.8 * rate)));
    // Sends the R again, part way through the wait.
    const r = synthesize("R", timing, { rate: 48000, padSec: 0 }).samples;
    f.push(r);
    f.push(new Float32Array(Math.round(0.8 * rate)));
    expect(f.step().done, "less than the wait since the second R").toBe(false);
    f.push(new Float32Array(Math.round(0.6 * rate)));
    expect(f.step().done).toBe(true);
  });
});

describe("following a take through a calibration", () => {
  it("reads the take to its end, every character right", () => {
    const timing = targetTiming(25, 25);
    const message = "CQ DE W7YFR";
    const { samples } = synthesize(message, timing, { rate: 48000, padSec: 0.3 });
    const all = new Float32Array(samples.length + 48000 * 2);
    all.set(samples);
    const target = keyedSymbols(message);
    const follower = new LiveFollower(48000, target, timing, {
      wpm: 25,
      releaseOffsetSec: 0.006,
      spreadSec: 0.001,
      elements: 40,
    });
    for (let k = 0; k < all.length; k += 128) follower.push(all.subarray(k, k + 128));
    const p = follower.step();
    expect(p.done).toBe(true);
    expect(p.graded).toEqual(target.map(() => true));
  });
});
