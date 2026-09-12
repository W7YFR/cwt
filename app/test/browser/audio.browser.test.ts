/* Audio, in a real browser.
 *
 * jsdom has no Web Audio at all, and a mock convincing enough to pass these
 * would be a mock convincing enough to lie. So the offline render, the decode
 * path and the schedule are all exercised against the real implementation.
 */

import { describe, expect, it } from "vitest";
import { createPlayer } from "@/audio/player";
import { keyingEnvelope, RAMP_SEC } from "@/audio/schedule";
import { encodeWav, encodeWavBuffer } from "@/audio/wav";
import { synthesize } from "@/audio/synth";
import {
  decodeAudioFile,
  FALLBACK_DECODE_RATE,
  normalized,
  segmentsFrom,
  sniffWavRate,
  toMono,
} from "@/dsp";
import { idealTimeline, targetTiming, estimateTiming, buildTimeline } from "@/timing";

const TIMING = targetTiming(20, 20);
const IDEAL = idealTimeline("CQ DE W1AW", TIMING);

describe("the keying schedule", () => {
  it("gates on and off once per mark, and never for a gap", () => {
    const env = keyingEnvelope(IDEAL, { peak: 0.8, padSec: 0.5 });
    const marks = IDEAL.blocks.filter((b) => b.kind === "dit" || b.kind === "dah");
    // Four breakpoints per mark: silent, up, hold, down.
    expect(env.points.length).toBe(marks.length * 4);
    expect(env.duration).toBeCloseTo(IDEAL.duration + 1.0, 6);
  });

  it("never ramps for longer than the mark it is shaping", () => {
    // At 40 wpm a dit is 30 ms and the ramp is 5 ms at each end; at some speed
    // the two would meet and the envelope would go non-monotonic.
    const fast = idealTimeline("EEE", targetTiming(45, 45));
    const env = keyingEnvelope(fast, { peak: 1, padSec: 0 });
    for (let i = 0; i < env.points.length; i += 4) {
      const [t0] = env.points[i]!;
      const [t1] = env.points[i + 1]!;
      const [t2] = env.points[i + 2]!;
      const [t3] = env.points[i + 3]!;
      expect(t1).toBeGreaterThanOrEqual(t0);
      expect(t2).toBeGreaterThanOrEqual(t1);
      expect(t3).toBeGreaterThanOrEqual(t2);
      expect(t1 - t0).toBeLessThanOrEqual(RAMP_SEC + 1e-9);
    }
  });

  it("clips to a requested window instead of playing the whole message", () => {
    const whole = keyingEnvelope(IDEAL, { peak: 1, padSec: 0.5 });
    const slice = keyingEnvelope(IDEAL, { peak: 1, padSec: 0.5, from: 0.5, to: 1.2 });
    expect(slice.points.length).toBeGreaterThan(0);
    expect(slice.points.length).toBeLessThan(whole.points.length);
    expect(slice.duration).toBeCloseTo(0.7, 6);
  });
});

describe("rendering the target offline", () => {
  it("produces audio that decodes back to the message it was built from", async () => {
    const player = createPlayer();
    try {
      const blob = await player.renderTarget(IDEAL, {
        peak: 0.9,
        padSec: 0.3,
        rate: 8000,
        voice: { toneHz: 700, filterQ: 3 },
      });
      expect(blob.type).toBe("audio/wav");

      // The real check: run the rendered audio back through the decoder. If
      // the schedule, the ramp shape or the padding were wrong, the text would
      // come back different — which is exactly what a user would hear.
      const clip = await decodeAudioFile(await blob.arrayBuffer());
      const { segments, toneHz } = segmentsFrom(normalized(clip).samples, clip.rate);
      expect(Math.abs(toneHz - 700)).toBeLessThan(3);
      const measured = estimateTiming(segments, "CQ DE W1AW");
      expect(buildTimeline(segments, measured).text).toBe("CQ DE W1AW");
    } finally {
      player.destroy();
    }
  });

  it("renders at the speed asked for, not at some default", async () => {
    const player = createPlayer();
    try {
      const slow = idealTimeline("PARIS", targetTiming(12, 12));
      const blob = await player.renderTarget(slow, {
        peak: 0.9,
        padSec: 0.2,
        rate: 8000,
        voice: { toneHz: 600, filterQ: 0 },
      });
      const clip = await decodeAudioFile(await blob.arrayBuffer());
      const { segments } = segmentsFrom(normalized(clip).samples, clip.rate);
      const measured = estimateTiming(segments, "PARIS");
      expect(Math.abs(measured.charWpm - 12)).toBeLessThan(1.5);
    } finally {
      player.destroy();
    }
  });
});

describe("WAV encoding", () => {
  it("round-trips through the browser's own decoder", async () => {
    const { samples } = synthesize("SOS", TIMING, { rate: 8000, toneHz: 600 });
    const clip = await decodeAudioFile(encodeWavBuffer(samples, 8000));
    expect(clip.rate).toBe(8000);
    expect(clip.samples.length).toBe(samples.length);
    // 16-bit quantization is the only loss, so a generous but real bound.
    for (let i = 0; i < samples.length; i += 97) {
      expect(Math.abs(clip.samples[i]! - samples[i]!)).toBeLessThan(2e-4);
    }
  });

  it("writes a header a decoder will accept at any rate", async () => {
    for (const rate of [8000, 22050, 44100, 48000]) {
      const blob = encodeWav(new Float32Array(rate), rate);
      const clip = await decodeAudioFile(await blob.arrayBuffer());
      expect(clip.rate, `${rate} Hz round trip`).toBe(rate);
    }
  });

  it("clamps rather than wrapping when a sample is out of range", async () => {
    // A wrap would turn a loud peak into a click at full negative scale, which
    // sounds like a dropped buffer and would get blamed on the recording.
    // Written as runs rather than single samples so the assertion is about the
    // clamp and not about how any filter treats a one-sample impulse.
    const hot = new Float32Array(300);
    hot.fill(1.5, 50, 150);
    hot.fill(-1.5, 150, 250);
    const clip = await decodeAudioFile(encodeWavBuffer(hot, 8000));
    expect(clip.samples[100]!).toBeGreaterThan(0.99);
    expect(clip.samples[200]!).toBeLessThan(-0.99);
  });
});

describe("decoding what the browser hands back", () => {
  it("keeps a WAV's own sample rate, so nothing is resampled", async () => {
    for (const rate of [8000, 22050, 44100, 48000]) {
      const { samples } = synthesize("TEST", TIMING, { rate, toneHz: 600 });
      const clip = await decodeAudioFile(encodeWavBuffer(samples, rate));
      // decodeAudioData resamples to the rate of the context it is called on,
      // so decoding through a plain AudioContext would hand back whatever the
      // hardware runs at — 44.1 kHz here, 48 kHz there. Reading the rate out
      // of the header first is what makes this machine-independent.
      expect(clip.rate, `${rate} Hz WAV`).toBe(rate);
      expect(clip.samples.length).toBe(samples.length);
    }
  });

  it("falls back to one fixed rate for a format it cannot sniff", async () => {
    // Not the hardware's rate: a fixed one, so two machines decoding the same
    // file still agree. The tone is forty times below Nyquist either way.
    const bogus = new Uint8Array(64).buffer;
    await expect(decodeAudioFile(bogus)).rejects.toThrow();
    expect(sniffWavRate(bogus)).toBeNull();
    expect(FALLBACK_DECODE_RATE).toBe(48000);
  });

  it("folds a stereo buffer to the average of its channels", () => {
    // toMono is what a stereo file goes through, so drive it directly rather
    // than round-tripping through a mono WAV that could not test it at all.
    const ctx = new OfflineAudioContext(2, 4000, 8000);
    const buf = ctx.createBuffer(2, 4000, 8000);
    buf.getChannelData(0).fill(0.5);
    buf.getChannelData(1).fill(-0.1);
    const clip = toMono(buf);
    expect(clip.rate).toBe(8000);
    expect(clip.samples[0]!).toBeCloseTo(0.2, 6);
    expect(clip.samples[3999]!).toBeCloseTo(0.2, 6);
    expect(clip.peak).toBeCloseTo(0.2, 6);
  });

  it("reads a WAV's declared rate straight out of its header", () => {
    // This is what keeps a decode from being resampled to whatever rate the
    // machine's audio hardware happens to run at.
    for (const rate of [8000, 22050, 44100, 48000, 96000]) {
      expect(sniffWavRate(encodeWavBuffer(new Float32Array(10), rate))).toBe(rate);
    }
    expect(sniffWavRate(new ArrayBuffer(8))).toBeNull();
    expect(sniffWavRate(new TextEncoder().encode("not a wav at all!!").buffer)).toBeNull();
  });
});
