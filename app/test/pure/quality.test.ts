/* How good is this setup — and what the measurement is allowed to claim.
 *
 * Two halves. The first pins the way the decay is measured, using envelopes
 * built by hand so the right answer is known exactly: a tail with a notch in
 * it, and a tail with a noise blip late in the gap. Those two shapes are the
 * whole reason the measurement is "total time above -20 dB" rather than either
 * of the obvious alternatives, and each of them would be read badly wrong by
 * one of those alternatives. If this file passes with a simpler implementation
 * underneath it, it is not doing its job.
 *
 * The second half is the corpus, where the interesting assertions are the
 * relational ones. Individual numbers from six setups are not a law and are
 * not treated as one. That the same webcam measures three times less room from
 * a few inches away than it does from across the room is a fact about
 * microphones, and it is the fact the whole calibration wizard is built to act
 * on.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import { makeTake } from "../impair";
import type { Segment } from "@/types";
import { assessSetup, releaseDecaySec, setupAdvice } from "@/dsp";

/* ------------------------------------------------------- measuring the decay */

const RATE = 1000; // one sample per millisecond, so the arithmetic is readable
const MARK_MS = 100;
const GAP_MS = 400;

/** A mark followed by a gap whose tail is `tailAt(ms)`, the whole thing scaled
 *  to `level` against a local steady level of 1. */
function release(
  tailAt: (ms: number) => number,
  level = 1,
): {
  env: Float32Array;
  peak: Float32Array;
  segments: Segment[];
} {
  const n = MARK_MS + GAP_MS;
  const env = new Float32Array(n);
  const peak = new Float32Array(n).fill(1);
  for (let i = 0; i < MARK_MS; i++) env[i] = level;
  for (let i = 0; i < GAP_MS; i++) env[MARK_MS + i] = level * tailAt(i);
  return {
    env,
    peak,
    segments: [
      [1, MARK_MS / RATE],
      [0, GAP_MS / RATE],
    ],
  };
}

/** Decays to exactly 0.1 after `ms` milliseconds. */
const exponential = (ms: number) => (t: number) => Math.pow(0.1, t / ms);

describe("measuring what the room adds", () => {
  const window = 0.3;
  const measure = (tailAt: (ms: number) => number, level = 1) => {
    const { env, peak, segments } = release(tailAt, level);
    const got = releaseDecaySec(env, peak, RATE, segments, window);
    return { ms: got.decaySec * 1000, releases: got.releases };
  };

  const smooth = exponential(50);

  it("measures a plain exponential tail at the point it reaches -20 dB", () => {
    const got = measure(smooth);
    expect(got.releases).toBe(1);
    expect(got.ms, `${got.ms.toFixed(1)} ms`).toBeGreaterThan(48);
    expect(got.ms).toBeLessThan(53);
  });

  it("is not fooled short by a notch in the tail", () => {
    /* Interference between the direct sound and its reflections puts holes in
       the decay. The envelope dives through the line at the bottom of one and
       comes straight back out — so "the first time it crosses -20 dB" reports
       a tail that has barely started as one that has finished. Here that would
       say 25 ms for a tail that is still ringing at 45. */
    const notched = (t: number) => (t >= 25 && t < 30 ? 0.001 : smooth(t));
    const got = measure(notched);
    expect(got.ms, `${got.ms.toFixed(1)} ms`).toBeGreaterThan(40);
    // Five milliseconds of genuine quiet, and worth exactly that much — stated
    // against the un-notched tail so a boundary sample cannot make it a guess.
    expect(measure(smooth).ms - got.ms).toBeCloseTo(5, 6);
  });

  it("is not fooled long by a blip late in the gap", () => {
    /* And the mirror image: taking the LAST crossing instead makes one noise
       spike anywhere in a long silence stand for the whole gap, which turns a
       50 ms tail into a 200 ms one. */
    const blipped = (t: number) => (t >= 200 && t < 202 ? 0.5 : smooth(t));
    const got = measure(blipped);
    expect(got.ms, `${got.ms.toFixed(1)} ms`).toBeLessThan(60);
    // The blip is worth its own two milliseconds and nothing more.
    expect(got.ms - measure(smooth).ms).toBeCloseTo(2, 6);
  });

  it("ignores a release with no room after it to be measured in", () => {
    // A decay cut short by the next element measures the spacing, not the room.
    const { env, peak } = release(exponential(50));
    const tight: Segment[] = [
      [1, MARK_MS / RATE],
      [0, 0.05],
    ];
    expect(releaseDecaySec(env, peak, RATE, tight, window).releases).toBe(0);
  });

  it("ignores a mark that never reached full level", () => {
    // A shard of a shattered element has a "release" in the middle of what was
    // really one mark, and its decay is meaningless.
    expect(measure(smooth, 0.4).releases).toBe(0);
  });
});

/* --------------------------------------------------------------- the verdict */

describe("judging a setup", () => {
  it("calls a synthetic clean take clean", () => {
    const take = makeTake("CQ DE W1AW", 20, null, 8000);
    const q = assessSetup(normalizePeak(take.samples), 8000, { wpm: 20 });
    expect(q.verdict).toBe("clean");
    expect(q.ratio).toBeLessThan(0.25);
  });

  it("measures more room as the room gets worse", () => {
    // Monotone in the direct-to-reverberant ratio, which is the parameter
    // distance actually controls.
    const decays = [20, 12, 6, 0].map((drDb) => {
      const take = makeTake("CQ DE W1AW", 20, null, 8000, {
        room: { rt60Sec: 0.3, drDb },
        seed: 7,
      });
      return assessSetup(normalizePeak(take.samples), 8000, { wpm: 20 }).decaySec;
    });
    for (let i = 1; i < decays.length; i++) {
      expect(decays[i], `dr step ${i}: ${decays.map((d) => (d * 1000).toFixed(1)).join(" ")}`)
        .toBeGreaterThan(decays[i - 1]!);
    }
  });

  it("says it cannot tell when there is nothing to measure", () => {
    const q = assessSetup(new Float32Array(8000 * 3), 8000, { wpm: 20 });
    expect(q.verdict).toBe("unknown");
    expect(q.releases).toBe(0);
    expect(setupAdvice(q)).toMatch(/single elements/);
  });

  it("has advice for every verdict, and leads with placement where it matters", () => {
    const advice = (verdict: string) =>
      setupAdvice({
        decaySec: 0.05,
        ditSec: 0.08,
        ratio: 0.6,
        releases: 6,
        maxWpm: 18,
        verdict: verdict as never,
      });
    for (const v of ["clean", "good", "room-limited", "too-far", "unknown"]) {
      expect(advice(v).length).toBeGreaterThan(20);
    }
    // The single biggest lever found in this whole effort is where the
    // microphone is, so both bands that have a room in them say so first.
    expect(advice("room-limited")).toMatch(/^Move your microphone closer/);
    expect(advice("too-far")).toMatch(/^Your microphone is too far/);
  });
});

/* ---------------------------------------------------------------- the corpus */

const file = (rel: string) => `${DATA_DIR}/${rel}`;

const SETUPS = [
  // path, speed keyed at, what it is
  ["cq-de-w7yfr-virtual.wav", 25, "loopback"],
  ["ft710-close/ft710-sweep-close-virtual.wav", 15, "loopback"],
  ["k3ng/single-dits/k3ng-virtual-single-dits-15wpm.wav", 15, "loopback"],
  ["ft710-close/ft710-sweep-close-webcam.wav", 15, "webcam, inches away"],
  ["cq-de-w7yfr-mic-1.wav", 25, "webcam, across a room"],
  ["k3ng/single-dits/k3ng-webcam-single-dits-15wpm.wav", 15, "webcam, four feet"],
  ["ft710/single-dits/ft710-single-dits-webcam-15wpm.wav", 15, "webcam, 56 inches"],
  ["cq-de-w7yfr-mic-2.wav", 25, "condenser, unrecoverable"],
] as const;

const HAVE = SETUPS.every(([rel]) => existsSync(file(rel)));

function quality(rel: string, wpm: number) {
  const wav = readWav(file(rel));
  return assessSetup(normalizePeak(wav.samples), wav.rate, { wpm });
}

describe.skipIf(!HAVE)("the corpus, measured", () => {
  it.each(SETUPS.filter(([, , what]) => what === "loopback"))(
    "finds nothing to correct in %s",
    (rel, wpm) => {
      // The floor of the measurement: with no room in the path what is left is
      // the envelope detector's own response, and it is the same on every
      // recording ever made through the loopback.
      const q = quality(rel, wpm);
      expect(q.verdict).toBe("clean");
      expect(q.decaySec * 1000, `${(q.decaySec * 1000).toFixed(1)} ms`).toBeLessThan(10);
    },
  );

  it("puts the setups in the order they were actually good", () => {
    const measured = SETUPS.map(([rel, wpm, what]) => ({
      what,
      ms: quality(rel, wpm).decaySec * 1000,
    }));
    const show = measured.map((m) => `${m.what} ${m.ms.toFixed(1)}`).join(", ");
    const of = (what: string) => measured.find((m) => m.what === what)!.ms;

    expect(of("loopback"), show).toBeLessThan(of("webcam, inches away"));
    expect(of("webcam, inches away"), show).toBeLessThan(of("webcam, across a room"));
    expect(of("webcam, across a room"), show).toBeLessThan(of("webcam, four feet"));
    expect(of("webcam, four feet"), show).toBeLessThan(of("condenser, unrecoverable"));
  });

  it("measures three times less room when the microphone moves closer", () => {
    /* The finding this whole effort turns on, stated as a number. One webcam,
       one room, one afternoon: a few inches from the speaker against 56, with
       the radio's own sidetone both times. No processing anywhere achieved a
       change of this size. */
    const close = quality("ft710-close/ft710-sweep-close-webcam.wav", 15);
    const far = quality("ft710/single-dits/ft710-single-dits-webcam-15wpm.wav", 15);
    expect(far.decaySec / close.decaySec).toBeGreaterThan(2);
    expect(close.verdict).toBe("good");
    expect(far.verdict).toBe("room-limited");
  });

  it("tells the one unrecoverable setup from the merely difficult ones", () => {
    /* The only claim the decay is allowed to make on its own. Everything in
       the middle of the range is "calibrate, and that will tell you", because
       two setups in this corpus measure within a few milliseconds of each
       other and one of them works. The recording below is not near them: its
       tail is twice as long as the dit it was sent with. */
    const worst = quality("cq-de-w7yfr-mic-2.wav", 25);
    expect(worst.verdict).toBe("too-far");
    expect(worst.ratio).toBeGreaterThan(1.5);

    for (const [rel, wpm] of SETUPS.filter(([, , w]) => w !== "condenser, unrecoverable")) {
      const q = quality(rel, wpm);
      expect(q.verdict, `${rel} is not the unrecoverable one`).not.toBe("too-far");
    }
  });

  it("reports a speed ceiling that tracks the room", () => {
    const close = quality("ft710-close/ft710-sweep-close-webcam.wav", 15);
    const far = quality("ft710/single-dits/ft710-single-dits-webcam-15wpm.wav", 15);
    const worst = quality("cq-de-w7yfr-mic-2.wav", 25);
    // Each one is keyed at 15 or 25 wpm, and only the close microphone has
    // room to spare above the speed it was used at.
    expect(close.maxWpm).toBeGreaterThan(15);
    expect(far.maxWpm).toBeLessThan(15);
    expect(worst.maxWpm).toBeLessThan(far.maxWpm);
  });

  it("declines to judge a held-paddle drill", () => {
    /* Eighty milliseconds between elements and a window of two hundred: the
       only release with room to be measured is the one at the end of the
       recording, and one release is not a measurement. The wizard has to ask
       for isolated elements to get this, which is worth knowing. */
    const q = quality("k3ng/dits/k3ng-webcam-dits-15wpm.wav", 15);
    expect(q.releases).toBeLessThan(3);
    expect(q.verdict).toBe("unknown");
  });

  it("declines to judge silence", () => {
    const q = quality("k3ng/silence/webcam-silence.wav", 15);
    expect(q.verdict).toBe("unknown");
  });
});
