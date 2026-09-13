/* "There is nothing here" — the one answer the decoder could not give.
 *
 * Everything downstream of this is built to find structure, and none of it is
 * allowed to decline. Handed a recording of an empty room it will report a
 * threshold, cross it a few hundred times, and hand back a decode, because
 * that is what each stage does with whatever it is given.
 *
 * The two populations this has to separate are wide apart, and these tests
 * pin both edges of the gap rather than only the side that happens to matter
 * today. A threshold with a factor of fifteen of headroom is worth having;
 * one that has quietly slid to the edge of a population is not, and only an
 * assertion on the margin can tell the difference.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import { gaussian, makeTake, rng } from "../impair";
import { KEYING_PROMINENCE, segmentsFrom, tonePresence } from "@/dsp";
import { NoKeyingError, analyzeClip } from "@/io/take";

const RATE = 8000;

function noise(seconds: number, rate = RATE, humHz = 0): Float32Array {
  const rand = rng(3);
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hum = humHz ? 0.3 * Math.sin((2 * Math.PI * humHz * i) / rate) : 0;
    x[i] = 0.1 * gaussian(rand) + hum;
  }
  return normalizePeak(x);
}

describe("is there any keying here", () => {
  describe("nothing", () => {
    it("says no to digital silence", () => {
      const p = tonePresence(new Float32Array(RATE * 5), RATE);
      expect(p.keyed).toBe(false);
      expect(p.prominence).toBe(0);
    });

    it("says no to an empty input", () => {
      expect(tonePresence(new Float32Array(0), RATE).keyed).toBe(false);
    });

    it("says no to broadband noise, however loud", () => {
      // Peak-normalized, so this is as loud as any recording ever gets. Level
      // is not the measure and this is the case that proves it.
      const p = tonePresence(noise(5), RATE);
      expect(p.keyed).toBe(false);
      expect(p.prominence, `${p.prominence.toFixed(1)}`).toBeLessThan(10);
    });

    it("says no to noise with mains hum under it", () => {
      // Hum is a tone, but not one in the CW band, and its harmonics are not
      // sharp enough to dominate the band's median.
      const p = tonePresence(noise(5, RATE, 60), RATE);
      expect(p.keyed).toBe(false);
    });
  });

  describe("something", () => {
    it("says yes to ordinary keying, with room to spare", () => {
      const take = makeTake("CQ DE W1AW", 20, null, RATE);
      const p = tonePresence(normalizePeak(take.samples), RATE);
      expect(p.keyed).toBe(true);
      expect(p.prominence).toBeGreaterThan(100 * KEYING_PROMINENCE);
    });

    it("says yes at 8 dB SNR, the worst the robustness grid asks for", () => {
      const take = makeTake("CQ DE W1AW", 20, null, RATE, { snrDb: 8, seed: 7 });
      expect(tonePresence(normalizePeak(take.samples), RATE).keyed).toBe(true);
    });

    it("says yes at 0 dB SNR, where noise is as loud as the signal", () => {
      // Past anything the decoder can read, and still on the right side of the
      // line — the guard must not become the reason a hard recording fails.
      const take = makeTake("CQ DE W1AW", 20, null, RATE, { snrDb: 0, seed: 7 });
      const p = tonePresence(normalizePeak(take.samples), RATE);
      expect(p.keyed, `${p.prominence.toFixed(1)}`).toBe(true);
    });

    it("says yes through a reverberant room", () => {
      const take = makeTake("CQ DE W1AW", 20, null, RATE, {
        room: { rt60Sec: 0.5, drDb: 0 },
        seed: 7,
      });
      expect(tonePresence(normalizePeak(take.samples), RATE).keyed).toBe(true);
    });

    it("works the same at 48 kHz", () => {
      // The band is surveyed on decimated audio, so a recording at the rate
      // the browser actually captures has to give the same answer.
      const take = makeTake("CQ DE W1AW", 20, null, 48000);
      expect(tonePresence(normalizePeak(take.samples), 48000).keyed).toBe(true);
      expect(tonePresence(noise(5, 48000), 48000).keyed).toBe(false);
    });
  });

  it("does not depend on how loud the recording is", () => {
    /* The app peak-normalizes everything before it gets here, so a measure
       that moved with level would be measuring the normalizer.

       Scaled by a power of two, and compared exactly. Every step between the
       samples and the ratio is homogeneous — the decimator is linear, the
       Goertzel power is quadratic, and taking a maximum and a median only
       reorders — so scaling by 2^-10 scales every intermediate by exactly that
       and cancels in the ratio, with no rounding anywhere to allow for. A
       tolerance here would hide a measure that had quietly become
       level-dependent. */
    const take = makeTake("CQ DE W1AW", 20, null, RATE);
    const loud = normalizePeak(take.samples);
    const quiet = loud.map((v) => v / 1024);
    expect(tonePresence(quiet, RATE).prominence).toBe(tonePresence(loud, RATE).prominence);
  });

  describe("real recordings", () => {
    const silent = [
      "k3ng/silence/webcam-silence.wav",
      "k3ng/silence/virtual-silence.wav",
      "ft710/silence/ft710-silence-webcam.wav",
      "ft710/silence/ft710-silence-virtual.wav",
    ];
    const keyed = [
      // The four hardest keyed recordings in the corpus: the quietest tone,
      // the most reverberant, and both unusable microphones.
      "k3ng/single-dits/k3ng-webcam-single-dits-15wpm.wav",
      "ft710/single-dits/ft710-single-dits-webcam-15wpm.wav",
      "cq-de-w7yfr-mic-1.wav",
      "cq-de-w7yfr-mic-2.wav",
    ];

    const load = (rel: string) => {
      const wav = readWav(`${DATA_DIR}/${rel}`);
      return { x: normalizePeak(wav.samples), rate: wav.rate };
    };
    const have = [...silent, ...keyed].every((f) => existsSync(`${DATA_DIR}/${f}`));

    it.skipIf(!have).each(silent)("finds nothing in %s", (rel) => {
      const { x, rate } = load(rel);
      const p = tonePresence(x, rate);
      expect(p.keyed, `prominence ${p.prominence.toFixed(1)}`).toBe(false);
      // The margin, not just the answer. Two of these are rooms with a
      // refrigerator and a fan in them, which is the realistic hard case.
      expect(p.prominence).toBeLessThan(KEYING_PROMINENCE / 2);
    });

    it.skipIf(!have).each(keyed)("finds keying in %s", (rel) => {
      const { x, rate } = load(rel);
      const p = tonePresence(x, rate);
      expect(p.keyed, `prominence ${p.prominence.toFixed(1)}`).toBe(true);
      expect(p.prominence).toBeGreaterThan(KEYING_PROMINENCE * 5);
    });

    it.skipIf(!have)("keeps a wide gap between the two populations", () => {
      // The reason one scalar is defensible here at all. If this margin ever
      // narrows, the threshold has stopped being a decision between two
      // populations and started being a cutoff inside one.
      const worstKeyed = Math.min(...keyed.map((f) => tonePresence(load(f).x, load(f).rate).prominence));
      const loudestSilence = Math.max(
        ...silent.map((f) => tonePresence(load(f).x, load(f).rate).prominence),
      );
      expect(worstKeyed / loudestSilence, `${loudestSilence.toFixed(1)} to ${worstKeyed.toFixed(1)}`)
        .toBeGreaterThan(10);
      expect(loudestSilence).toBeLessThan(KEYING_PROMINENCE);
      expect(worstKeyed).toBeGreaterThan(KEYING_PROMINENCE);
    });

    it.skipIf(!have).each(silent)("decodes %s as nothing at all", (rel) => {
      // The point of the whole exercise: not a measurement, a decode.
      const { x, rate } = load(rel);
      const got = segmentsFrom(x, rate);
      expect(got.segments).toEqual([]);
      expect(got.presence.keyed).toBe(false);
    });

    it.skipIf(!have).each(silent)("refuses to make a take out of %s", (rel) => {
      /* And the end of it: a review page built from nothing would be a page of
         zeros with a speed and a grade on it, which is worse than a plain
         refusal because it looks like an answer. */
      const wav = readWav(`${DATA_DIR}/${rel}`);
      const clip = { samples: wav.samples, rate: wav.rate, peak: 1 };
      expect(() => analyzeClip(clip, { source: rel })).toThrow(NoKeyingError);
    });

    it.skipIf(!have)("still makes a take out of a hard but real recording", () => {
      const wav = readWav(`${DATA_DIR}/cq-de-w7yfr-mic-2.wav`);
      const clip = { samples: wav.samples, rate: wav.rate, peak: 1 };
      const { take } = analyzeClip(clip, { source: "mic-2" });
      expect(take.segments.length).toBeGreaterThan(0);
    });
  });
});
