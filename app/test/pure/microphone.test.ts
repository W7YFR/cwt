/* The acceptance test: three recordings of the same sending, three capture
 * paths.
 *
 * All three were sent by the same keyer macro, so the keying is identical and
 * only the route into the computer differs — a loopback from the sidetone, a
 * webcam microphone, and a condenser across a room. They are the standard the
 * work is actually for, and they are deliberately held out: no constant in
 * dsp/ was chosen by looking at what these files needed. The synthetic corpus
 * in impair.ts is where parameters get sized, precisely so that passing here
 * means something.
 *
 * The room is still the real test. Two microphones in one room on one
 * afternoon is not a sample of anything, and the numbers below should be read
 * as "this much stopped being broken", not as coverage.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";
import { segmentsFrom } from "@/dsp";
import { estimateTiming, buildTimeline } from "@/timing";

const SENT = "CQ DE W7YFR";
/** Marks in `SENT`: C -.-. Q --.- D -.. E . W .-- 7 --... Y -.-- F ..-. R .-. */
const MARKS = 31;

function decode(file: string) {
  const wav = readWav(`${DATA_DIR}/${file}`);
  const got = segmentsFrom(normalizePeak(wav.samples), wav.rate);
  const all = got.segments.filter((s) => s[0] === 1).map((s) => s[1]).sort((a, b) => a - b);
  const marks = all.length;
  // "CQ DE W7YFR" is 16 dits and 15 dahs, so the split sits just past halfway.
  const cut = Math.round(marks * 0.52);
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const ditDah = avg(all.slice(cut)) / (avg(all.slice(0, cut)) || 1);
  let text = "";
  let unitMs = 0;
  let wpmOf = 0;
  try {
    const timing = estimateTiming(got.segments, SENT);
    unitMs = timing.unitSec * 1000;
    wpmOf = timing.charWpm;
    text = buildTimeline(got.segments, timing).text;
  } catch {
    text = "";
  }
  return { marks, text, unitMs, ditDah, wpm: wpmOf, toneHz: got.toneHz };
}

describe("the same sending down three different capture paths", () => {
  it.each(["cq-de-w7yfr-virtual.wav", "cq-de-w7yfr-mic-1.wav", "cq-de-w7yfr-mic-2.wav"])(
    "%s is present",
    (f) => {
      expect(existsSync(`${DATA_DIR}/${f}`)).toBe(true);
    },
  );

  it("finds the same sidetone on all three", () => {
    // Tone detection was never the problem — worth pinning, because it means a
    // failure further down cannot be blamed on it.
    for (const f of [
      "cq-de-w7yfr-virtual.wav",
      "cq-de-w7yfr-mic-1.wav",
      "cq-de-w7yfr-mic-2.wav",
    ]) {
      expect(Math.abs(decode(f).toneHz - 601), f).toBeLessThan(2);
    }
  });

  it("reads the loopback capture exactly, as it always has", () => {
    const got = decode("cq-de-w7yfr-virtual.wav");
    expect(got.marks).toBe(MARKS);
    expect(got.text).toBe(SENT);
  });

  it("reads the webcam microphone exactly", () => {
    // This one used to come back as 'MTCT CTNTTN CTT T TTNTS ...' from 65
    // marks — a dah broken into dits, over and over. Nothing about the file
    // changed; the decoder stopped mistaking ripple for keying.
    const got = decode("cq-de-w7yfr-mic-1.wav");
    expect(got.marks).toBe(MARKS);
    expect(got.text).toBe(SENT);
  });

  it("measures the webcam recording at the speed it was actually sent", () => {
    // The assertion that matters for a tool that grades keying, and the one
    // that reading the text correctly does not imply. The same performance
    // down both paths has to come back as the same performance — otherwise the
    // app tells someone they send at 31 wpm with clipped dits when they send
    // at 25 with good ones, and they would go and "fix" their keying.
    const clean = decode("cq-de-w7yfr-virtual.wav");
    const mic = decode("cq-de-w7yfr-mic-1.wav");
    expect(Math.abs(mic.wpm - clean.wpm), `${mic.wpm.toFixed(2)} vs ${clean.wpm.toFixed(2)} wpm`)
      .toBeLessThan(1.5);
    // And the shape of the elements, not just their rate. Three to one is the
    // standard; the threshold used to read this recording at 3.87.
    expect(mic.ditDah, `dit:dah ${mic.ditDah.toFixed(2)}`).toBeGreaterThan(2.7);
    expect(mic.ditDah, `dit:dah ${mic.ditDah.toFixed(2)}`).toBeLessThan(3.4);
  });

  it("no longer shatters the condenser recording, though it still misreads it", () => {
    // Honest about where this stands. The Yeti recording has a 91 ms envelope
    // decay — its tail is still ringing when the next element starts, so gaps
    // never reach silence and the depth test cannot separate them. That is the
    // release-time problem, not the threshold problem, and it is not fixed.
    //
    // What is asserted is a ratchet, not a target: it must not go back to
    // being shattered beyond recognition.
    const got = decode("cq-de-w7yfr-mic-2.wav");
    expect(got.marks, `${got.marks} marks, was 49`).toBeLessThanOrEqual(40);
    expect(got.marks).toBeGreaterThanOrEqual(MARKS - 4);
  });
});
