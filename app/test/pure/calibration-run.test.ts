/* One calibration recording in, one answer out — including the answers that
 * are refusals.
 *
 * The success path is covered in depth by the dsp tests; what is new here is
 * everything that happens when a recording is not what was asked for. Those
 * are the cases an operator actually meets, and each of them has to come back
 * with something to do rather than a failure.
 *
 * The refusal on the far microphone is the assertion worth protecting. A
 * number is always available from drills that disagree — one of them on its
 * own suggests 34 ms — and storing it would apply it confidently and wrongly
 * to every later recording from that setup. Declining is correct, and it is
 * the behavior most likely to regress quietly.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import { DRILLS, analyzeCalibration, playablesOf } from "@/io/calibration";
import { correctsNothing, drillsAgree } from "@/dsp";
import {
  PROBE,
  assessSetup,
  measureCalibration,
  setupAdvice,
  pairDrills,
  segmentsFrom,
  splitSections,
} from "@/dsp";

const WPM = 15;
const QUIET_SEC = 5;

const CLOSE = `${DATA_DIR}/ft710-close/ft710-sweep-close-webcam.wav`;
const FAR = (kind: string) =>
  kind === "silence"
    ? `${DATA_DIR}/ft710/silence/ft710-silence-webcam.wav`
    : `${DATA_DIR}/ft710/${kind}/ft710-${kind}-webcam-15wpm.wav`;
const FAR_ORDER = ["silence", "dits", "dahs", "iambic", "single-dits", "cq-de-w7yfr"];

const HAVE = existsSync(CLOSE) && FAR_ORDER.every((k) => existsSync(FAR(k)));

function load(path: string) {
  const wav = readWav(path);
  return { samples: normalizePeak(wav.samples), rate: wav.rate };
}

/** The separate drills stitched into the single take a wizard would record.
 *
 * With quiet between them, which is what the operator is asked to leave. The
 * splitter finds its own separator from the recording, so the exact amount is
 * not load-bearing — but the drills have to be in one file for this to be
 * testing the thing the wizard does. */
function oneTake(paths: readonly string[]) {
  const parts = paths.map((p) => readWav(p));
  const rate = parts[0]!.rate;
  const quiet = Math.round(QUIET_SEC * rate);
  const total = parts.reduce((a, p) => a + p.samples.length + quiet, quiet);
  const samples = new Float32Array(total);
  let at = quiet;
  for (const part of parts) {
    samples.set(part.samples, at);
    at += part.samples.length + quiet;
  }
  return { samples: normalizePeak(samples), rate };
}

describe("silence and noise", () => {
  it("says there was no keying, rather than measuring nothing", () => {
    const { samples } = { samples: new Float32Array(8000 * 12) };
    const run = analyzeCalibration(samples, 8000, WPM);
    expect(run.calibration).toBeNull();
    expect(run.usable).toBe(false);
    expect(run.reason).toBe("no-keying");
  });
});

describe.skipIf(!HAVE)("a calibration recording", () => {
  describe("a microphone a few inches from the speaker", () => {
    const run = () => {
      const { samples, rate } = load(CLOSE);
      return analyzeCalibration(samples, rate, WPM);
    };

    it("measures a profile and accepts it", () => {
      const got = run();
      expect(got.problem).toBeNull();
      expect(got.usable).toBe(true);
      expect(got.calibration).not.toBeNull();
      const ms = got.calibration!.releaseOffsetSec * 1000;
      expect(ms, `${ms.toFixed(2)} ms`).toBeLessThan(5);
    });

    it("judges the setup from the isolated-element drill, not the held ones", () => {
      /* The held drills cannot answer it — 80 ms between elements against a
         200 ms window — so a run that measured quality from them would come
         back "unknown" and the wizard would have nothing to show. */
      const got = run();
      expect(got.quality.releases).toBeGreaterThanOrEqual(3);
      expect(got.quality.verdict).toBe("good");
    });

    it("finds all five drills in the one recording", () => {
      expect(run().sections.filter((s) => s.kind !== "silence")).toHaveLength(5);
    });

    it("hands back every keyed stretch, named by what it was taken to be", () => {
      /* So a refusal can be listened to. "The two drills disagree by 31 ms"
         is a fact about numbers; hearing the dah drill play back somebody's
         dits is the same fact in a form anyone can act on.

         Named from the splitter's own view of the recording rather than from
         the schedule the wizard asked for, because when those two differ the
         splitter's view is the one that explains the answer. */
      const parts = playablesOf(run());
      expect(parts.map((p) => p.label)).toEqual([
        "Held dits",
        "Held dahs",
        "Other keying",
        "Single dits",
        "Your message",
      ]);
      // Real windows into the recording, in order, none of them empty.
      let last = -1;
      for (const p of parts) {
        expect(p.toSec).toBeGreaterThan(p.fromSec);
        expect(p.fromSec).toBeGreaterThan(last);
        last = p.fromSec;
      }
      // Silence is left out: there is nothing in it to check.
      expect(parts).toHaveLength(
        run().sections.filter((x) => x.kind !== "silence").length,
      );
    });

    it("reads the closing message back, through the profile it just measured", () => {
      /* The last drill asks the operator to send something. Asking for it and
         then saying nothing about it is worse than not asking — and it is the
         only part of a calibration anybody can check with their own eyes. */
      const got = run();
      expect(got.readback).not.toBeNull();
      expect(got.readback!.text).toBe("CQ DE W7YFR");
      expect(Math.abs(got.readback!.charWpm - WPM)).toBeLessThan(1);
    });
  });

  describe("a path with nothing in it", () => {
    /* The loopback capture of the same sweep. It is not a failure and it is
       not a small correction — it is the answer "there is nothing here", and
       it has to be told apart from a real measurement or the app stores a
       profile that corrects nothing while every report made under it claims a
       calibration was in force.

       The criterion is the measurement's own resolution: an offset smaller
       than the disagreement between the drills it came from is noise. The
       corpus separates on it cleanly in both directions. */
    it("measures the loopback as nothing to correct", () => {
      const wav = load(`${DATA_DIR}/ft710-close/ft710-sweep-close-virtual.wav`);
      const run = analyzeCalibration(wav.samples, wav.rate, WPM);
      // Measurable — this is not a refusal.
      expect(run.usable).toBe(true);
      expect(run.reason).toBeNull();
      expect(run.nothingToCorrect).toBe(true);
      // And the offset really is inside the drills' own disagreement.
      expect(run.calibration!.releaseOffsetSec).toBeLessThanOrEqual(
        run.calibration!.spreadSec,
      );
    });

    it("still finds something to correct through a microphone", () => {
      // The same sweep, same room, same afternoon — through a webcam a few
      // inches away, which is the closest a real microphone gets.
      const wav = load(CLOSE);
      const run = analyzeCalibration(wav.samples, wav.rate, WPM);
      expect(run.nothingToCorrect).toBe(false);
      expect(run.calibration!.releaseOffsetSec).toBeGreaterThan(
        run.calibration!.spreadSec,
      );
    });

    it("still says what the path does, having found nothing to take off it", () => {
      /* A path can add nothing to the length of an element and still have a
         tail long enough to put a ceiling on the speed it can carry — two
         halves of the same question. Answering only the first left somebody
         limited to 14 wpm with nothing on screen about it. */
      const wav = load(`${DATA_DIR}/ft710-close/ft710-sweep-close-virtual.wav`);
      const run = analyzeCalibration(wav.samples, wav.rate, WPM);
      expect(run.advice).toBe(setupAdvice(run.quality));
    });

    it("tells a path that adds nothing apart from a measurement that says nothing", () => {
      /* Both come back with no correction to store and they are opposite
         findings: one is the best result there is, the other is a reason to
         record it again. Told apart by whether the two drills landed in the
         same place. */
      const clean = load(`${DATA_DIR}/ft710-close/ft710-sweep-close-virtual.wav`);
      const cleanRun = analyzeCalibration(clean.samples, clean.rate, WPM);
      expect(cleanRun.nothingToCorrect).toBe(true);
      expect(cleanRun.drillsAgreed).toBe(true);

      const mic = load(CLOSE);
      expect(analyzeCalibration(mic.samples, mic.rate, WPM).drillsAgreed).toBe(true);

      /* Scattered: no offset to speak of, and drills a fifth of a dit apart.
         `correctsNothing` cannot tell this from the loopback above — that is
         the whole reason for the second question. */
      const scattered = { wpm: WPM, elements: 37, releaseOffsetSec: 0, spreadSec: 0.0154 };
      expect(correctsNothing(scattered)).toBe(true);
      expect(drillsAgree(scattered)).toBe(false);
    });

    it("scales what counts as agreement with the speed it was keyed at", () => {
      // A twentieth of a dit, so the same disagreement is fatal slowly and
      // worse quickly rather than being a fixed number of milliseconds.
      expect(drillsAgree({ wpm: 15, elements: 40, releaseOffsetSec: 0, spreadSec: 0.003 })).toBe(true);
      expect(drillsAgree({ wpm: 30, elements: 40, releaseOffsetSec: 0, spreadSec: 0.003 })).toBe(false);
    });

    it("treats an offset inside the noise as nothing, whatever its size", () => {
      /* The rule scales itself, which is the point of tying it to the spread
         rather than to a fixed number of milliseconds: a noisier measurement
         has to find a larger offset before that offset means anything. */
      const base = { wpm: 15, elements: 100 };
      expect(correctsNothing({ ...base, releaseOffsetSec: 0.004, spreadSec: 0.006 })).toBe(true);
      expect(correctsNothing({ ...base, releaseOffsetSec: 0.004, spreadSec: 0.002 })).toBe(false);
      expect(correctsNothing({ ...base, releaseOffsetSec: 0, spreadSec: 0 })).toBe(true);
    });
  });

  describe("a microphone across the room", () => {
    const run = () => {
      const { samples, rate } = oneTake(FAR_ORDER.map(FAR));
      return analyzeCalibration(samples, rate, WPM);
    };

    it("refuses to store a profile", () => {
      const got = run();
      expect(got.usable).toBe(false);
      expect(got.calibration).toBeNull();
    });

    it("blames the setup and not the operator", () => {
      /* This one shatters its own drills, so nothing in the recording looks
         like a held paddle any more. The tempting answer is "hold the paddle
         for a few seconds" — which would send somebody off to repeat a
         recording that cannot work, in a position that cannot work. */
      expect(run().reason).toBe("shattered");
    });
  });

  describe("a recording that is not what was asked for", () => {
    it("asks for the missing drill when the room is not the problem", () => {
      /* Built from the good recording's own sections, so the setup is known to
         be fine and the only thing wrong is that one drill was never sent. */
      const { samples, rate } = load(CLOSE);
      const sections = analyzeCalibration(samples, rate, WPM).sections;
      const dits = sections.filter((s) => s.kind === "uniform")[0]!;
      const isolated = sections.find((s) => s.kind === "isolated")!;
      const quiet = Math.round(QUIET_SEC * rate);
      const pieces = [dits, isolated].map((s) => samples.subarray(s.from, s.to));
      const partial = new Float32Array(
        pieces.reduce((a, p) => a + p.length + quiet, quiet),
      );
      let at = quiet;
      for (const p of pieces) {
        partial.set(p, at);
        at += p.length + quiet;
      }

      const got = analyzeCalibration(partial, rate, WPM);
      expect(got.usable).toBe(false);
      expect(got.reason).toBe("missing-drill");
    });
  });

  describe("the drills are long enough, and not longer", () => {
    /* Forty seconds of somebody's attention is the budget, and every second of
       it has to be earning something. These hold the durations in
       io/calibration.ts against the measurements they exist to feed: cut them
       and this fails, and lengthen them and nothing here improves — which is
       the evidence that the current numbers are not arbitrary.

       Run against a real recording truncated to the wizard's own timings,
       rather than against a synthetic one, because what is being tested is
       whether a real operator sends enough in four seconds. */
    const secondsFor = (key: string) => DRILLS.find((d) => d.key === key)!.seconds;

    function truncated() {
      const { samples, rate } = load(CLOSE);
      const sections = splitSections(samples, rate);
      const { dits, dahs } = pairDrills(sections);
      const isolated = sections.find((s) => s.kind === "isolated")!;
      const cut = (s: { from: number; to: number }, sec: number) =>
        Math.min(s.to, s.from + Math.round(sec * rate));
      const marks = (from: number, to: number) =>
        segmentsFrom(samples.subarray(from, to), rate, { calibration: PROBE })
          .segments.filter((g) => g[0] === 1)
          .map((g) => g[1]);

      return {
        calibration: measureCalibration(
          [
            { marks: marks(dits!.from, cut(dits!, secondsFor("dits"))), units: 1 },
            { marks: marks(dahs!.from, cut(dahs!, secondsFor("dahs"))), units: 3 },
          ],
          WPM,
        ),
        quality: assessSetup(
          samples.subarray(isolated.from, cut(isolated, secondsFor("isolated"))),
          rate,
          { wpm: WPM },
        ),
        full: analyzeCalibration(samples, rate, WPM),
      };
    }

    it("measures the same offset from the short drills as from the whole take", () => {
      const { calibration, full } = truncated();
      const short = calibration.releaseOffsetSec * 1000;
      const whole = full.calibration!.releaseOffsetSec * 1000;
      // A fifth of a millisecond against an 80 ms dit. The held drills
      // converge almost immediately; the extra seconds bought nothing.
      expect(Math.abs(short - whole), `${short.toFixed(2)} against ${whole.toFixed(2)} ms`)
        .toBeLessThan(0.5);
    });

    it("still has enough elements for the profile to be trusted", () => {
      expect(truncated().calibration.elements).toBeGreaterThanOrEqual(8);
    });

    it("leaves the isolated drill enough releases to be judged", () => {
      /* The tightest of the four. Three releases is the minimum the decay
         measurement will report anything from, and at two seconds apart that
         is five seconds of recording — so the margin here is one element. */
      const { quality, full } = truncated();
      expect(quality.releases).toBeGreaterThanOrEqual(3);
      expect(quality.verdict).toBe(full.quality.verdict);
    });
  });
});
