/* A QSO as one piece of audio: clean, and as heard, with the station's
 * fading and the band made again under it. */

import { describe, expect, it } from "vitest";
import { NOISE_OFF_DB } from "@/audio/qsb";
import { QRM_OFF_DB } from "@/copy/band";
import { qrmLines } from "@/copy/generate";
import { anyAdded, tape, type Added, type TapeLine } from "@/qso/tape";

const RATE = 8000;

/** A tone burst, as your recording of a line. */
function yours(sec: number): TapeLine {
  const samples = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 650 * i) / RATE);
  return { you: true, clip: { samples, rate: RATE } };
}

const THEIRS: TapeLine = {
  you: false,
  text: "W7YFR DE K7ABC UR 599 K",
  speed: { charWpm: 25, farnsworthWpm: 25 },
  toneHz: 600,
  call: "K7ABC",
};

const LINES = [yours(1.5), THEIRS, yours(1)];

const NONE: Added = { qsbDb: 0, noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB, seed: 1, qrmLines };

/** The share of samples near silence. */
function quiet(samples: Float32Array): number {
  let n = 0;
  for (const v of samples) if (Math.abs(v) < 0.01) n++;
  return n / samples.length;
}

describe("a QSO as heard", () => {
  it("is the clean tape with nothing added", () => {
    expect(tape(LINES, RATE, NONE).samples).toEqual(tape(LINES, RATE).samples);
  });

  it("is as long as the clean tape, with the band under it", () => {
    const clean = tape(LINES, RATE);
    const heard = tape(LINES, RATE, { ...NONE, noiseDb: -12, qrn: 2, qrmDb: -14 });
    expect(heard.samples.length).toBe(clean.samples.length);
    expect(quiet(clean.samples), "the clean tape has its gaps").toBeGreaterThan(0.2);
    expect(quiet(heard.samples), "the band fills them").toBeLessThan(quiet(clean.samples) / 2);
    for (const v of heard.samples) expect(Math.abs(v)).toBeLessThan(1);
  });

  it("fades the station's lines with QSB, and not yours", () => {
    const clean = tape(LINES, RATE).samples;
    const heard = tape(LINES, RATE, { ...NONE, qsbDb: 20 }).samples;
    const first = Math.round(1.5 * RATE);
    // Your line, before the station's, is as recorded.
    expect(heard.subarray(0, first)).toEqual(clean.subarray(0, first));
    expect(heard).not.toEqual(clean);
  });
});

describe("whether anything is added", () => {
  it("is no with everything off, and yes with any one on", () => {
    expect(anyAdded(NONE)).toBe(false);
    expect(anyAdded({ ...NONE, qsbDb: 4 })).toBe(true);
    expect(anyAdded({ ...NONE, noiseDb: -20 })).toBe(true);
    expect(anyAdded({ ...NONE, qrn: 1 })).toBe(true);
    expect(anyAdded({ ...NONE, qrmDb: -20 })).toBe(true);
  });
});
