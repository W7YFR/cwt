/* The whole calibration sequence in one take, with the microphone right in
 * front of the speaker.
 *
 * Two files, recorded simultaneously: the radio's sidetone into a webcam a few
 * inches away, and the keyer's own sidetone through the loopback as the timing
 * reference. Everything is in one continuous recording — silence, held dits,
 * held dahs, iambic, isolated dits, a message — separated by whatever pause
 * the operator happened to leave, which turned out to be between 1.5 and 2.8
 * seconds and not the five they were asked for.
 *
 * Two things are worth having a fixture for.
 *
 * The separators here overlap with the gaps inside the isolated-dit drill —
 * 2.8, 2.1 and 1.9 seconds of pause against 2.0 seconds between elements — so
 * this is the recording that proves the split cannot be done with a fixed
 * threshold. It is the case a tidier recording would not have caught.
 *
 * And it is the best microphone capture in the corpus by a wide margin. The
 * room contributes 2.5 ms where four feet away contributed 13, and the message
 * reads at the speed it was keyed without any correction at all. That is worth
 * pinning, because it is the answer the calibration wizard should be steering
 * people toward: move the microphone, and most of this stops being a problem.
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
  type Section,
} from "@/dsp";
import { buildTimeline, estimateTiming } from "@/timing";

const ROOT = `${DATA_DIR}/ft710-close`;
const WPM = 15;
const SENT = "CQ DE W7YFR";
const MARKS = 31;

const file = (tag: string) => `${ROOT}/ft710-sweep-close-${tag}.wav`;

/* The calibration corpora are large and not committed — see tests/data/README.
   Skip rather than fail when they are not on this machine, so a fresh clone
   does not look broken. */
const HAVE = existsSync(file("virtual")) && existsSync(file("webcam"));

function load(tag: string) {
  const wav = readWav(file(tag));
  return { x: normalizePeak(wav.samples), rate: wav.rate };
}

function drillsOf(tag: string) {
  const { x, rate } = load(tag);
  const sections = splitSections(x, rate);
  const { dits, dahs } = pairDrills(sections);
  return { x, rate, sections, dits, dahs };
}

function marksIn(x: Float32Array, rate: number, s: Section, cal?: Calibration) {
  return segmentsFrom(x.subarray(s.from, s.to), rate, cal ? { calibration: cal } : {})
    .segments.filter((g) => g[0] === 1)
    .map((g) => g[1]);
}

function calibrate(tag: string): Calibration {
  const { x, rate, dits, dahs } = drillsOf(tag);
  return measureCalibration(
    [
      { marks: marksIn(x, rate, dits!, PROBE), units: 1 },
      { marks: marksIn(x, rate, dahs!, PROBE), units: 3 },
    ],
    WPM,
  );
}

describe.skipIf(!HAVE)("one continuous calibration take", () => {
  it.each(["virtual", "webcam"])("%s is present", (tag) => {
    expect(existsSync(file(tag))).toBe(true);
  });

  describe("taking it apart", () => {
    it.each(["virtual", "webcam"])("finds every drill in the %s recording", (tag) => {
      const kinds = drillsOf(tag).sections
        .filter((s) => s.kind !== "silence")
        .map((s) => s.kind);
      // Held dits, held dahs, iambic, isolated dits, the message.
      expect(kinds).toEqual(["uniform", "uniform", "mixed", "isolated", "mixed"]);
    });

    it("keeps the isolated drill whole, though its gaps look like separators", () => {
      // The reason this recording is a fixture. Elements two seconds apart,
      // and pauses between sections of 1.9 to 2.8 — overlapping populations,
      // so the drill is split and then put back together.
      const isolated = drillsOf("webcam").sections.find((s) => s.kind === "isolated")!;
      expect(isolated.marks.length).toBe(6);
      expect(isolated.medianGapSec).toBeGreaterThan(1.5);
    });

    it("picks the two held-paddle drills out of five sections", () => {
      const { dits, dahs } = drillsOf("webcam");
      expect(dits!.marks.length).toBeGreaterThan(20);
      expect(dahs!.medianMarkSec / dits!.medianMarkSec).toBeCloseTo(3, 0);
    });
  });

  describe("what the room costs at a few inches", () => {
    it("measures almost nothing to correct", () => {
      // Thirteen milliseconds at four feet; here it is under five, which is
      // the whole argument for moving the microphone.
      const c = calibrate("webcam");
      const ms = c.releaseOffsetSec * 1000;
      expect(ms, `${ms.toFixed(2)} ms`).toBeLessThan(5);
      expect(c.spreadSec * 1000, `spread ${(c.spreadSec * 1000).toFixed(2)} ms`).toBeLessThan(2);
      expect(calibrationIsUsable(c)).toBe(true);
    });

    it("reads held dits at the length they were keyed", () => {
      const { x, rate, dits } = drillsOf("webcam");
      const marks = marksIn(x, rate, dits!).sort((a, b) => a - b);
      const median = marks[marks.length >> 1]! * 1000;
      expect(Math.abs(median - 80), `${median.toFixed(1)} ms against 80`).toBeLessThan(3);
    });

    it("reads the message correctly with no calibration at all", () => {
      // The bar this recording clears that no other microphone capture does.
      const { x, rate, sections } = drillsOf("webcam");
      const msg = sections.filter((s) => s.kind === "mixed").pop()!;
      const got = segmentsFrom(x.subarray(msg.from, msg.to), rate);
      const timing = estimateTiming(got.segments, SENT);
      expect(got.segments.filter((s) => s[0] === 1).length).toBe(MARKS);
      expect(buildTimeline(got.segments, timing).text).toBe(SENT);
      expect(
        Math.abs(timing.charWpm - WPM),
        `${timing.charWpm.toFixed(2)} wpm against ${WPM}`,
      ).toBeLessThan(0.5);
    });

    it("is barely distinguishable from having no room in the path", () => {
      const room = calibrate("webcam").releaseOffsetSec * 1000;
      const none = calibrate("virtual").releaseOffsetSec * 1000;
      expect(room - none, `${room.toFixed(2)} ms against ${none.toFixed(2)} ms`).toBeLessThan(5);
    });
  });
});
