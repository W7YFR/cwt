/* A saved profile, end to end: measured from drills, applied to a recording it
 * has never seen, and named in the report it produces.
 *
 * The dsp tests prove the correction is right. What is new here is that the
 * path an actual recording travels — analyzeClip, with a profile chosen on the
 * landing screen — carries it, and that what comes out says which calibration
 * produced it.
 *
 * That last part is not bookkeeping. A directory of these reports is meant to
 * be one time series, and a recalibration in the middle of it moves every
 * number by the size of the correction. Without the profile written down, the
 * step looks like the operator's sending changed.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";
import { analyzeClip } from "@/io/take";
import { buildJsonReport } from "@/io/report";
import { measureCalibration, PROBE, segmentsFrom } from "@/dsp";
import { normalizePeak } from "../wav";
import { defaultSettings, reviewTake } from "@/timing";
import type { Profile } from "@/io/profiles";

const WPM = 15;
const SENT = "CQ DE W7YFR";

const drill = (kind: string) =>
  `${DATA_DIR}/k3ng/${kind}/k3ng-webcam-${kind}-15wpm.wav`;
const MESSAGE = `${DATA_DIR}/k3ng/cq-de-w7yfr/k3ng-webcam-cq-de-w7yfr-15wpm.wav`;

const HAVE = [drill("dits"), drill("dahs"), MESSAGE].every(existsSync);

/** The profile the wizard would have produced from this setup's drills. */
function profileFor(): Profile {
  const marks = (path: string) => {
    const wav = readWav(path);
    return segmentsFrom(normalizePeak(wav.samples), wav.rate, { calibration: PROBE })
      .segments.filter((s) => s[0] === 1)
      .map((s) => s[1]);
  };
  const c = measureCalibration(
    [
      { marks: marks(drill("dits")), units: 1 },
      { marks: marks(drill("dahs")), units: 3 },
    ],
    WPM,
  );
  return {
    id: "p-4ft",
    nickname: "four feet away",
    deviceId: "webcam",
    deviceLabel: "HD Pro Webcam",
    wpm: c.wpm,
    releaseOffsetSec: c.releaseOffsetSec,
    spreadSec: c.spreadSec,
    elements: c.elements,
    verdict: "marginal",
    decaySec: 0.082,
    maxWpm: 10,
    recordedAt: "2026-09-12T10:00:00+00:00",
  };
}

function open(profile: Profile | null) {
  const wav = readWav(MESSAGE);
  let peak = 0;
  for (const v of wav.samples) peak = Math.max(peak, Math.abs(v));
  return analyzeClip(
    { samples: wav.samples, rate: wav.rate, peak },
    { source: "k3ng-webcam", expected: SENT, profile, id: "t1", now: "2026-09-12T11:00:00+00:00" },
  );
}

describe.skipIf(!HAVE)("recording through a calibrated setup", () => {
  it("reads closer to the speed it was keyed at", () => {
    /* The profile was measured from held-paddle drills and this is an ordinary
       message — a recording it has never seen. If the offset only ever
       corrected the drills it came from, it would be a description of nothing. */
    const without = open(null).take.measured.charWpm;
    const withIt = open(profileFor()).take.measured.charWpm;
    const err = (v: number) => Math.abs(v - WPM);
    expect(err(withIt), `${withIt.toFixed(2)} wpm against ${without.toFixed(2)}`)
      .toBeLessThan(err(without));
    expect(err(withIt)).toBeLessThan(1);
  });

  it("still reads the message correctly", () => {
    // A correction that improved the timing while losing a character would be
    // no improvement at all.
    expect(open(profileFor()).take.decoded).toBe(SENT);
  });

  it("records which profile produced it", () => {
    const take = open(profileFor()).take;
    expect(take.profile?.nickname).toBe("four feet away");
    expect(take.profile?.releaseOffsetSec).toBeGreaterThan(0);
  });

  it("says so in the report, and says so when there was none", () => {
    for (const profile of [profileFor(), null]) {
      const { take } = open(profile);
      const settings = defaultSettings(take);
      const report = buildJsonReport(reviewTake(take, settings), settings);
      if (profile) {
        expect(report.review.calibration?.profile).toBe("four feet away");
        expect(report.review.calibration!.offset_ms).toBeGreaterThan(0);
      } else {
        // Written out as null rather than left off, so "not calibrated" can be
        // told from "a report too old to say".
        expect(report.review.calibration).toBeNull();
        expect("calibration" in report.review).toBe(true);
      }
    }
  });
});
