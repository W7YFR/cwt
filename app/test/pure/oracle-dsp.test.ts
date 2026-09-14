/* The DSP, held to a recorded reference within a stated tolerance.
 *
 * The reference numbers were derived independently, by a pipeline built along
 * different lines — a Butterworth bandpass and a Hilbert transform at a fixed
 * 8 kHz, where this one quadrature-demodulates through cascaded boxcars at the
 * recording's own rate. That is worth knowing here and nowhere else, because
 * it is the reason for every tolerance below: two filters with the same
 * passband put a mark boundary in almost, but not exactly, the same place, and
 * demanding identical numbers would be demanding the wrong thing.
 *
 * What must not change is anything a user would notice, so that is what this
 * asserts:
 *
 *   - the same number of segments (a lost or invented one is a decode change)
 *   - every boundary within 1.5 ms
 *   - the same decoded text
 *   - a measured speed close to what the recording was really sent at
 *
 * That last one is checked against ground truth rather than against the
 * reference on purpose — see NOMINAL_WPM_TOLERANCE.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { OracleCase } from "../oracle";
import { oracleCasesFromDisk, DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import { segmentsFrom, detectTone } from "@/dsp";
import { estimateTiming, buildTimeline, targetTiming } from "@/timing";
import { synthesize, peakNormalize } from "@/audio/synth";
import { targetTiming as ideal } from "@/timing/model";
import type { Segment } from "@/types";

/** How far a segment boundary may move from the reference.
 *
 * Measured worst case across the corpus is 1.18 ms. Set at 1.5 to leave a
 * little room without leaving enough for anything to matter: 1.5 ms is 3% of
 * a dit at 25 wpm, and well under the 0.4-unit floor for flagging a
 * deviation, so nothing inside this window can change a verdict. */
const BOUNDARY_TOLERANCE_SEC = 0.0015;

/** How far the detected tone may move. Measured worst case is 0.06 Hz. */
const TONE_TOLERANCE_HZ = 0.5;

/** How far the measured character speed may sit from what the recording was
 *  really sent at.
 *
 * This is the assertion that matters, and it is deliberately against ground
 * truth rather than against the reference. The two pipelines put the threshold
 * at slightly different heights on the keying edge, so they disagree by up to
 * 0.7 wpm on the real recordings — and on this corpus these are the more
 * consistent numbers of the two (worst error 1.1% against the reference's
 * 3.8%). Demanding agreement would be demanding the worse answer. */
const NOMINAL_WPM_TOLERANCE = 0.5;

/** How far this may sit from the reference's own speed reading.
 *  Loose, because the above is the real check; this one only catches a port
 *  that has wandered off somewhere new. */
const CROSS_WPM_TOLERANCE = 1.2;

const cases = oracleCasesFromDisk();

/** Cumulative boundary times, which is what actually has to line up — the
 *  individual durations are differences of these and would double any error. */
function boundaries(segs: readonly Segment[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const [, d] of segs) {
    t += d;
    out.push(t);
  }
  return out;
}

function compareSegments(
  got: readonly Segment[],
  want: readonly Segment[],
  tolerance: number,
) {
  expect(got.length, "segment count").toBe(want.length);
  expect(
    got.map((s) => s[0]),
    "key-down/key-up pattern",
  ).toEqual(want.map((s) => s[0]));

  const a = boundaries(got);
  const b = boundaries(want);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  expect(
    worst,
    `worst boundary drift ${(worst * 1000).toFixed(2)} ms at segment ${worstAt}`,
  ).toBeLessThan(tolerance);
}

describe("the synthesizer reproduces the reference waveform", () => {
  const synthCases = cases.filter((c) => c.synth);

  it.each(synthCases.map((c) => [c.name, c] as const))(
    "%s renders the same waveform",
    (_name, c: OracleCase) => {
      const s = c.synth!;
      const { samples } = synthesize(s.text, ideal(s.wpm, s.farnsworthWpm), {
        rate: s.rate,
        toneHz: 600,
        padSec: 0.1,
      });
      peakNormalize(samples);

      // Within one sample, not exactly. The reference carried its
      // own copy of the Farnsworth formula; this one drives off targetTiming,
      // the single model everything else uses. The two agree to the last bit
      // of a float, which over a few dozen gaps is occasionally enough to
      // land the total on the other side of an integer sample count.
      expect(Math.abs(samples.length - s.nSamples), "sample count").toBeLessThanOrEqual(1);
      let absSum = 0;
      for (let i = 0; i < samples.length; i++) absSum += Math.abs(samples[i]!);
      // Float32 accumulation over ~100k samples; relative, not absolute.
      expect(absSum / s.absSum).toBeCloseTo(1, 5);
      s.head.forEach((v: number, i: number) => {
        expect(samples[i]!, `sample ${i}`).toBeCloseTo(v, 5);
      });
    },
  );
});

describe("the DSP agrees with the recorded reference", () => {
  // Synthesized cases run at the SAME rate on both sides, so the only thing
  // that differs is the envelope algorithm. Any drift here is attributable to
  // that alone, which is what makes these the sharper test.
  describe("on synthesized signals, at the same rate", () => {
    const synthCases = cases.filter((c) => c.synth);

    it.each(synthCases.map((c) => [c.name, c] as const))(
      "%s finds the same keying",
      (_name, c: OracleCase) => {
        const s = c.synth!;
        const { samples } = synthesize(s.text, ideal(s.wpm, s.farnsworthWpm), {
          rate: s.rate,
          toneHz: 600,
          padSec: 0.1,
        });
        peakNormalize(samples);

        const got = segmentsFrom(samples, s.rate);
        expect(Math.abs(got.toneHz - c.toneHz)).toBeLessThan(TONE_TOLERANCE_HZ);
        compareSegments(
          got.segments,
          c.segments.map(([st, d]) => [st === 1 ? 1 : 0, d] as Segment),
          BOUNDARY_TOLERANCE_SEC,
        );
      },
    );
  });

  // Real recordings run at their NATIVE rate here and at 8 kHz in the
  // reference, so
  // these additionally cross a resampler that only one side has. That is the
  // configuration the app actually ships, so the user-visible properties are
  // what get asserted.
  describe("on real recordings, at their native rate", () => {
    const wavCases = cases.filter((c) => c.sourceWav);

    it.each(wavCases.map((c) => [c.name, c] as const))(
      "%s decodes to the same text and speed",
      (_name, c: OracleCase) => {
        const path = `${DATA_DIR}/${c.sourceWav}`;
        if (!existsSync(path)) return;

        const wav = readWav(path);
        const samples = normalizePeak(wav.samples);
        const got = segmentsFrom(samples, wav.rate);

        expect(
          Math.abs(got.toneHz - c.toneHz),
          `tone ${got.toneHz.toFixed(1)} vs ${c.toneHz.toFixed(1)}`,
        ).toBeLessThan(TONE_TOLERANCE_HZ);

        // The headline property: the same message comes out.
        const ref = targetTiming(c.charWpm, c.farnsworthWpm);
        const text = buildTimeline(got.segments, ref).text;
        const wantText = c.grading.rests.timeline.text;
        expect(text).toBe(wantText);

        // And a speed close to what was actually sent. Checked against the
        // recording's true speed first, and only loosely against the reference.
        const measured = estimateTiming(got.segments, c.expected);
        expect(
          Math.abs(measured.charWpm - c.nominalWpm!),
          `measured ${measured.charWpm.toFixed(2)} wpm for a ` +
            `${c.nominalWpm} wpm recording`,
        ).toBeLessThan(NOMINAL_WPM_TOLERANCE);
        expect(
          Math.abs(measured.charWpm - c.grading.measured.charWpm),
          `char wpm ${measured.charWpm.toFixed(2)} vs the reference's ` +
            `${c.grading.measured.charWpm.toFixed(2)}`,
        ).toBeLessThan(CROSS_WPM_TOLERANCE);
      },
    );

    it.each(wavCases.map((c) => [c.name, c] as const))(
      "%s finds every mark and gap in the same place",
      (_name, c: OracleCase) => {
        const path = `${DATA_DIR}/${c.sourceWav}`;
        if (!existsSync(path)) return;
        const wav = readWav(path);
        const got = segmentsFrom(normalizePeak(wav.samples), wav.rate);
        compareSegments(
          got.segments,
          c.segments.map(([st, d]) => [st === 1 ? 1 : 0, d] as Segment),
          BOUNDARY_TOLERANCE_SEC,
        );
      },
    );
  });

  it("detects the tone without being told the rate is 8 kHz", () => {
    // Guards the decimation inside detectTone: a survey that assumed a fixed
    // input rate would come back with a frequency scaled by the ratio.
    for (const c of cases.filter((x) => x.synth)) {
      const s = c.synth!;
      for (const rate of [8000, 16000, 48000]) {
        const { samples } = synthesize(s.text, ideal(s.wpm, s.farnsworthWpm), {
          rate,
          toneHz: 600,
        });
        expect(
          Math.abs(detectTone(samples, rate) - 600),
          `${c.name} at ${rate} Hz`,
        ).toBeLessThan(TONE_TOLERANCE_HZ);
      }
    }
  });

  it("measures the same speed whatever rate the recording was made at", () => {
    // The reason there is no resampler: the answer must not depend on the
    // capture device. Same keying rendered at three rates, one speed.
    //
    // Note what is NOT asserted here. A synthesized 25 wpm signal measures
    // about 27 — the 5 ms raised-cosine ramp is 10% of a dit at that speed, so
    // the threshold crossings sit inside the nominal mark and every mark reads
    // short. The reference reads it the same way (26.92 for this drill), and
    // real recordings do not show it: the k3ng fixture reads 20.16 against a
    // true 20. So absolute accuracy belongs in the real-recording tests above,
    // and what belongs here is that the rate cannot change the answer.
    const timing = ideal(25, 18);
    const speeds = [8000, 22050, 48000].map((rate) => {
      const { samples } = synthesize("CQ CQ DE W1AW K", timing, {
        rate,
        toneHz: 700,
      });
      peakNormalize(samples);
      const { segments } = segmentsFrom(samples, rate);
      return estimateTiming(segments, "CQ CQ DE W1AW K");
    });

    for (const s of speeds) {
      expect(s.charWpm, "character speed across rates").toBeCloseTo(
        speeds[0]!.charWpm,
        1,
      );
      expect(s.farnsworthWpm, "overall speed across rates").toBeCloseTo(
        speeds[0]!.farnsworthWpm,
        1,
      );
    }

    // The Farnsworth ratio is measured from gaps, which the ramps barely
    // touch, so this one IS accurate in absolute terms and is worth pinning.
    expect(Math.abs(speeds[0]!.farnsworthWpm - 18)).toBeLessThan(
      NOMINAL_WPM_TOLERANCE,
    );
  });
});
