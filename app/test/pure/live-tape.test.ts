/* The Live page's recording: the latest audio at the decode rate. */

import { describe, expect, it } from "vitest";
import { Tape } from "@/live/tape";

/** `sec` seconds of a steady level at 48 kHz. */
const level = (sec: number, v: number) => new Float32Array(Math.round(sec * 48000)).fill(v);

describe("the tape", () => {
  it("keeps what it heard at the decode rate", () => {
    const tape = new Tape(60);
    tape.start(48000, 1_000);
    tape.push(level(2, 0.5));
    const { samples, rate } = tape.audio();
    expect(rate).toBe(8000);
    expect(samples.length).toBe(16000);
    expect(samples[100]).toBeCloseTo(0.5, 3);
    expect(tape.startedAt).toBe(1_000);
  });

  it("keeps only the latest, and moves its start on", () => {
    const tape = new Tape(1);
    tape.start(48000, 0);
    tape.push(level(1, 0.2));
    tape.push(level(0.5, 0.8));
    const { samples } = tape.audio();
    expect(samples.length).toBe(8000);
    expect(samples[0]).toBeCloseTo(0.2, 3);
    expect(samples[7999]).toBeCloseTo(0.8, 3);
    expect(tape.startedAt).toBe(500);
  });

  it("puts a second of silence between one Listen and the next", () => {
    const tape = new Tape(60);
    tape.start(48000, 0);
    tape.push(level(1, 0.5));
    tape.stop();
    tape.start(48000, 5_000);
    tape.push(level(1, 0.5));
    const { samples } = tape.audio();
    expect(samples.length).toBe(24000);
    expect(samples[12000]).toBe(0);
  });

  it("finds a stretch by the clock, across two Listens", () => {
    const tape = new Tape(60);
    tape.start(48000, 10_000);
    tape.push(level(2, 0.2));
    tape.stop();
    // The second Listen starts a minute later on the clock.
    tape.start(48000, 70_000);
    tape.push(level(2, 0.8));
    const first = tape.audio(10_500, 11_500).samples;
    expect(first.length).toBe(8000);
    expect(first[4000]).toBeCloseTo(0.2, 3);
    const second = tape.audio(70_500, 71_000).samples;
    expect(second.length).toBe(4000);
    expect(second[2000]).toBeCloseTo(0.8, 3);
    expect(tape.holds(10_000, 12_000)).toBe(true);
    expect(tape.holds(30_000, 40_000)).toBe(false);
  });

  it("holds nothing of a stretch that fell off the end", () => {
    const tape = new Tape(1);
    tape.start(48000, 0);
    tape.push(level(3, 0.5));
    expect(tape.holds(0, 1_500)).toBe(false);
    expect(tape.holds(2_200, 2_800)).toBe(true);
  });

  it("forgets what it held when cleared", () => {
    const tape = new Tape(60);
    tape.start(48000, 0);
    tape.push(level(1, 0.5));
    tape.stop();
    tape.clear();
    expect(tape.heldSec).toBe(0);
    expect(tape.startedAt).toBeNull();
  });
});
