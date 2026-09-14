/* The same drills through a radio's sidetone, from a worse spot in the room.
 *
 * A second calibration set: the K3NG keying an FT-710, its sidetone reaching a
 * webcam microphone from about 56 inches away and well off to one side, with
 * the keyer's own sidetone captured simultaneously through the loopback as the
 * timing reference. Different tone, different speaker, different position.
 *
 * It does not work, and that is what this file is for. The room at that spot
 * is about twice as reverberant as the one four feet away — the isolated-dit
 * decay reaches -20 dB at 104 ms against 52 ms — which is longer than a dit at
 * 15 wpm. Marks shatter before timing is ever reached: the message comes back
 * as 70 elements where 31 were sent.
 *
 * So the assertion is that calibration REFUSES. A profile built from drills
 * that disagree by thirty milliseconds would be applied to every later
 * recording from that setup and would be confidently wrong. Declining to
 * produce one, and saying so, is the correct behavior and the thing most
 * likely to regress quietly.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import {
  PROBE,
  calibrationIsUsable,
  measureCalibration,
  segmentsFrom,
  type Calibration,
} from "@/dsp";
import { buildTimeline, estimateTiming } from "@/timing";

const ROOT = `${DATA_DIR}/ft710`;
const WPM = 15;
const SENT = "CQ DE W7YFR";
/** Marks in `SENT`. */
const MARKS = 31;

const file = (kind: string, tag: string) =>
  kind === "silence"
    ? `${ROOT}/silence/ft710-silence-${tag}.wav`
    : `${ROOT}/${kind}/ft710-${kind}-${tag}-15wpm.wav`;

/* Large and not committed — see app/test/data/README. */
const HAVE = existsSync(file("dits", "virtual")) && existsSync(file("dahs", "webcam"));

function marksOf(path: string, calibration?: Calibration): number[] {
  const wav = readWav(path);
  return segmentsFrom(
    normalizePeak(wav.samples),
    wav.rate,
    calibration ? { calibration } : {},
  ).segments
    .filter((s) => s[0] === 1)
    .map((s) => s[1]);
}

function calibrate(tag: string): Calibration {
  return measureCalibration(
    [
      { marks: marksOf(file("dits", tag), PROBE), units: 1 },
      { marks: marksOf(file("dahs", tag), PROBE), units: 3 },
    ],
    WPM,
  );
}

const KINDS = ["silence", "dits", "dahs", "iambic", "single-dits", "cq-de-w7yfr"];

describe.skipIf(!HAVE)("the FT-710 calibration set", () => {
  it.each(KINDS.flatMap((k) => ["virtual", "webcam"].map((t) => [k, t] as const)))(
    "%s/%s is present",
    (kind, tag) => {
      expect(existsSync(file(kind, tag))).toBe(true);
    },
  );

  describe("the loopback reference is intact", () => {
    /* The keyer drove the radio, so the keyer's own sidetone is still the
       ground truth even though the microphone was listening to something else.
       If these fail, the set says nothing about the room. */

    it("reads the message at the speed it was keyed", () => {
      const wav = readWav(file("cq-de-w7yfr", "virtual"));
      const got = segmentsFrom(normalizePeak(wav.samples), wav.rate);
      const timing = estimateTiming(got.segments, SENT);
      expect(got.segments.filter((s) => s[0] === 1).length).toBe(MARKS);
      expect(buildTimeline(got.segments, timing).text).toBe(SENT);
      expect(Math.abs(timing.charWpm - WPM)).toBeLessThan(0.5);
    });

    it("has nothing to correct, because there is no room in the path", () => {
      const c = calibrate("virtual");
      expect(c.releaseOffsetSec * 1000).toBeLessThan(2);
      expect(calibrationIsUsable(c)).toBe(true);
    });
  });

  describe("the microphone path is past what this can recover", () => {
    it("shatters the message rather than mistiming it", () => {
      // Worth pinning the failure mode, not just the failure. This is not a
      // boundary landing in the wrong place — the elements themselves are
      // wrong, so no release offset could help, because an offset only moves
      // the edges of marks that were correctly found.
      const n = marksOf(file("cq-de-w7yfr", "webcam")).length;
      expect(n, `${n} elements where ${MARKS} were sent`).toBeGreaterThan(MARKS * 1.5);
    });

    it("refuses to produce a profile from drills that disagree", () => {
      // The assertion that matters. A number is available — the dah drill
      // alone suggests about 34 ms — and using it would be worse than having
      // none, because it would be applied to everything afterwards.
      const c = calibrate("webcam");
      expect(c.spreadSec * 1000, `spread ${(c.spreadSec * 1000).toFixed(2)} ms`).toBeGreaterThan(10);
      expect(calibrationIsUsable(c), "a disagreeing calibration must be refused").toBe(false);
    });

    it("is refused for the right reason — the drills, not the element count", () => {
      // Guards against the refusal happening by accident. There are plenty of
      // elements; what is wrong is that they do not agree.
      const c = calibrate("webcam");
      expect(c.elements).toBeGreaterThan(20);
      expect(c.wpm).toBe(WPM);
    });
  });
});
