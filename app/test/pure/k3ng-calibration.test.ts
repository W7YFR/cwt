/* A calibration set recorded down two paths at once.
 *
 * Twelve files: silence, held dits, held dahs, iambic, isolated dits and a
 * message, each captured simultaneously through a loopback from the keyer and
 * through a webcam microphone four feet from the speaker. The keying is one
 * performance, so the loopback file is not a reference decode — it is the
 * answer, and the microphone file is the same answer seen through a room.
 *
 * These are held out from tuning like the other real recordings. What they are
 * for is the claim calibration rests on: that a room's effect on keying is a
 * single number, that a few seconds of held paddle measures it, and that the
 * number then applies to recordings it was not measured from.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import {
  PROBE,
  calibrationIsUsable,
  measureCalibration,
  pairDrills,
  segmentsFrom,
  splitSections,
  type Calibration,
} from "@/dsp";
import { buildTimeline, estimateTiming } from "@/timing";

const ROOT = `${DATA_DIR}/k3ng`;
const WPM = 15;
/** 1.2/15 — the keyer was set to 15 wpm, and 1200/15 divides exactly, so the
 *  firmware's integer division of the element length costs nothing here. */
const DIT_MS = 80;
const SENT = "CQ DE W7YFR";

const FILE: Record<string, (tag: string) => string> = {
  silence: (t) => `${ROOT}/silence/${t}-silence.wav`,
  dits: (t) => `${ROOT}/dits/k3ng-${t}-dits-15wpm.wav`,
  dahs: (t) => `${ROOT}/dahs/k3ng-${t}-dahs-15wpm.wav`,
  iambic: (t) => `${ROOT}/iambic/k3ng-${t}-iambic-15wpm.wav`,
  singleDits: (t) => `${ROOT}/single-dits/k3ng-${t}-single-dits-15wpm.wav`,
  cq: (t) => `${ROOT}/cq-de-w7yfr/k3ng-${t}-cq-de-w7yfr-15wpm.wav`,
};

/* Large and not committed — see tests/data/README. Skip when absent so a
   fresh clone does not look broken. */
const HAVE = existsSync(FILE.dits!("virtual")) && existsSync(FILE.dahs!("webcam"));

function marksOf(path: string, calibration?: Calibration): number[] {
  const wav = readWav(path);
  const got = segmentsFrom(
    normalizePeak(wav.samples),
    wav.rate,
    calibration ? { calibration } : {},
  );
  return got.segments.filter((s) => s[0] === 1).map((s) => s[1]);
}

function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : NaN;
}

/** Median of the shorter class — the dits, in a recording that has both. */
function ditMs(marks: readonly number[]): number {
  const s = [...marks].sort((a, b) => a - b);
  return median(s.slice(0, Math.max(1, Math.round(s.length * 0.45)))) * 1000;
}

function calibrate(tag: string): Calibration {
  // From the held-paddle drills only: their element lengths are not a matter
  // of opinion, because the keyer supplies them.
  return measureCalibration(
    [
      { marks: marksOf(FILE.dits!(tag), PROBE), units: 1 },
      { marks: marksOf(FILE.dahs!(tag), PROBE), units: 3 },
    ],
    WPM,
  );
}

describe.skipIf(!HAVE)("the calibration set", () => {
  it.each(Object.keys(FILE).flatMap((k) => ["virtual", "webcam"].map((t) => [k, t] as const)))(
    "%s/%s is present",
    (kind, tag) => {
      expect(existsSync(FILE[kind]!(tag))).toBe(true);
    },
  );

  describe("the loopback capture reads the keyer exactly", () => {
    /* These are the ground truth, so if any of them is wrong nothing measured
       against them means anything. */

    it("finds 57 dits, each one unit long", () => {
      const m = marksOf(FILE.dits!("virtual"));
      expect(m.length).toBe(57);
      // Within a millisecond and a half. Not closer, and for a known reason:
      // the keying threshold sits a little above half the mark's height, so a
      // clean recording reads about three quarters of a millisecond short. It
      // is the same on every element, so it costs nothing downstream.
      const err = median(m) * 1000 - DIT_MS;
      expect(Math.abs(err), `${(median(m) * 1000).toFixed(2)} ms against ${DIT_MS}`).toBeLessThan(1.5);
    });

    it("finds 30 dahs, each three units long", () => {
      // The regression guard for a real bug: the glitch floor used to be sized
      // from the shortest MARK, so a drill with no dits in it put the floor at
      // 0.35 of a dah — longer than the one-unit gaps between them. Every gap
      // was condemned and the whole recording came back as a single mark.
      const m = marksOf(FILE.dahs!("virtual"));
      expect(m.length, "an all-dah drill must not merge into one mark").toBe(30);
      const err = median(m) * 1000 - 3 * DIT_MS;
      expect(Math.abs(err), `${(median(m) * 1000).toFixed(2)} ms against ${3 * DIT_MS}`).toBeLessThan(1.5);
    });

    it("finds 43 alternating elements in the iambic drill", () => {
      expect(marksOf(FILE.iambic!("virtual")).length).toBe(43);
    });

    it("finds the six isolated dits", () => {
      expect(marksOf(FILE.singleDits!("virtual")).length).toBe(6);
    });

    it("reads the message", () => {
      const wav = readWav(FILE.cq!("virtual"));
      const got = segmentsFrom(normalizePeak(wav.samples), wav.rate);
      const timing = estimateTiming(got.segments, SENT);
      expect(buildTimeline(got.segments, timing).text).toBe(SENT);
      expect(timing.charWpm).toBeCloseTo(WPM, 0);
    });
  });

  describe("measuring the room", () => {
    it("finds essentially nothing to correct on the loopback path", () => {
      // No microphone, no room, so an honest measurement has to come back at
      // about zero — otherwise the method is measuring itself.
      const c = calibrate("virtual");
      expect(c.releaseOffsetSec * 1000, `${(c.releaseOffsetSec * 1000).toFixed(2)} ms`).toBeLessThan(2);
      expect(calibrationIsUsable(c)).toBe(true);
    });

    it("finds a consistent delay on the microphone path", () => {
      const c = calibrate("webcam");
      const ms = c.releaseOffsetSec * 1000;
      expect(ms, `offset ${ms.toFixed(2)} ms`).toBeGreaterThan(8);
      expect(ms, `offset ${ms.toFixed(2)} ms`).toBeLessThan(18);
      // The two drills have to agree, or it is not one number.
      expect(c.spreadSec * 1000, `spread ${(c.spreadSec * 1000).toFixed(2)} ms`).toBeLessThan(2);
      expect(calibrationIsUsable(c)).toBe(true);
    });
  });

  describe("the profile applies to recordings it was not measured from", () => {
    /* The whole point. Measured from held paddles, applied to iambic sending,
       isolated elements and a message — none of which the profile has seen. */

    it.each(["iambic", "singleDits", "cq"] as const)("corrects the %s recording", (kind) => {
      const c = calibrate("webcam");
      const before = ditMs(marksOf(FILE[kind]!("webcam")));
      const after = ditMs(marksOf(FILE[kind]!("webcam"), c));
      expect(Math.abs(after - DIT_MS), `${before.toFixed(1)} -> ${after.toFixed(1)} ms`)
        .toBeLessThan(Math.abs(before - DIT_MS));
      expect(Math.abs(after - DIT_MS), `${after.toFixed(1)} ms against ${DIT_MS}`).toBeLessThan(4);
    });

    it("reads the microphone recording at the speed it was really keyed", () => {
      const c = calibrate("webcam");
      const wav = readWav(FILE.cq!("webcam"));
      const x = normalizePeak(wav.samples);

      const raw = estimateTiming(segmentsFrom(x, wav.rate).segments, SENT);
      const got = segmentsFrom(x, wav.rate, { calibration: c });
      const timing = estimateTiming(got.segments, SENT);

      expect(buildTimeline(got.segments, timing).text).toBe(SENT);
      expect(
        Math.abs(timing.charWpm - WPM),
        `${raw.charWpm.toFixed(2)} -> ${timing.charWpm.toFixed(2)} wpm`,
      ).toBeLessThan(0.5);

      // And the shape of the elements, which is what a keying grade is about.
      const m = got.segments.filter((s) => s[0] === 1).map((s) => s[1]).sort((a, b) => a - b);
      const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const ratio = avg(m.slice(16)) / avg(m.slice(0, 16));
      expect(ratio, `dit:dah ${ratio.toFixed(2)}`).toBeGreaterThan(2.8);
      expect(ratio, `dit:dah ${ratio.toFixed(2)}`).toBeLessThan(3.2);
    });
  });
});

describe.skipIf(!HAVE)("the same drills recorded as one continuous take", () => {
  /* Starting and stopping a recorder six times is a poor thing to ask of
     anyone, so the wizard records once and takes the result apart afterwards.
     These recordings were made separately, so they get stitched back together
     with quiet between them — which is exactly the file a single take would
     produce — and the profile that comes out has to be the same one. */

  const ORDER = ["silence", "dits", "dahs", "iambic", "singleDits", "cq"] as const;
  const QUIET_SEC = 5;

  function oneTake(tag: string): { samples: Float32Array; rate: number } {
    const parts = ORDER.map((k) => readWav(FILE[k]!(tag)));
    const rate = parts[0]!.rate;
    const quiet = Math.round(QUIET_SEC * rate);
    const total = parts.reduce((a, p) => a + p.samples.length + quiet, quiet);
    const samples = new Float32Array(total);
    let at = quiet;
    for (const p of parts) {
      samples.set(p.samples, at);
      at += p.samples.length + quiet;
    }
    return { samples, rate };
  }

  it("finds every drill, in the right shape", () => {
    const { samples, rate } = oneTake("webcam");
    const kinds = splitSections(normalizePeak(samples), rate)
      .filter((s) => s.kind !== "silence")
      .map((s) => s.kind);
    // Held dits, held dahs, iambic, single dits, a message.
    expect(kinds).toEqual(["uniform", "uniform", "mixed", "isolated", "mixed"]);
  });

  it.each(["virtual", "webcam"])("measures %s the same as the separate files do", (tag) => {
    const { samples, rate } = oneTake(tag);
    const x = normalizePeak(samples);
    const { dits, dahs } = pairDrills(splitSections(x, rate));
    expect(dits, "no dit drill found").not.toBeNull();
    expect(dahs, "no dah drill found").not.toBeNull();

    const fromSection = (s: { from: number; to: number }, units: number) => ({
      marks: segmentsFrom(x.subarray(s.from, s.to), rate, { calibration: PROBE })
        .segments.filter((g) => g[0] === 1).map((g) => g[1]),
      units,
    });

    const stitched = measureCalibration(
      [fromSection(dits!, 1), fromSection(dahs!, 3)],
      WPM,
    );
    const separate = calibrate(tag);

    expect(calibrationIsUsable(stitched)).toBe(true);
    expect(
      Math.abs(stitched.releaseOffsetSec - separate.releaseOffsetSec) * 1000,
      `one take ${(stitched.releaseOffsetSec * 1000).toFixed(2)} ms vs ` +
        `separate files ${(separate.releaseOffsetSec * 1000).toFixed(2)} ms`,
    ).toBeLessThan(1);
  });
});
