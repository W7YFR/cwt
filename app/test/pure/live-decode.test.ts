/* The Live page's decoder, on audio it has never been told the speed of.
 *
 * The audio goes in as the microphone delivers it, 128 samples at a time,
 * and the decoder runs a pass every 150 ms, as the worker does. */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { LiveDecoder, type Turn } from "@/live/decoder";
import { bugFist, straightFist } from "@/timing/fist";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";
import { inTurn, mix, type Keyed } from "../live-mix";

/** Every turn, final, in the order they started. */
function decode(audio: Float32Array, rate: number): Turn[] {
  const d = new LiveDecoder(rate);
  const out: Turn[] = [];
  const pass = Math.round(rate * 0.15);
  // Quiet after, so the last turn settles.
  const padded = new Float32Array(audio.length + rate * 3);
  padded.set(audio);
  let next = pass;
  for (let i = 0; i < padded.length; i += 128) {
    d.push(padded.subarray(i, i + 128));
    if (i >= next) {
      next += pass;
      out.push(...d.step().final);
    }
  }
  out.push(...d.flush());
  return out.sort((a, b) => a.t0 - b.t0);
}

const texts = (turns: readonly Turn[]) => turns.map((t) => t.text);

describe("speed", () => {
  const lines = (wpm: number, extra: Partial<Keyed> = {}): Keyed[] =>
    inTurn([
      { text: "CQ CQ DE K7ABC K7ABC K", wpm, hz: 700, amp: 0.3, ...extra },
      { text: "K7ABC DE W1AW UR 579 NAME JOE QTH CT BK", wpm, hz: 700, amp: 0.3, ...extra },
    ]);

  for (const wpm of [12, 20, 30, 40, 50]) {
    it(`reads ${wpm} WPM with no speed set, and measures it`, () => {
      const turns = decode(mix(lines(wpm)), 48000);
      expect(texts(turns)).toEqual(["CQ CQ DE K7ABC K7ABC K", "K7ABC DE W1AW UR 579 NAME JOE QTH CT BK"]);
      for (const t of turns) expect(Math.abs(t.wpm - wpm)).toBeLessThanOrEqual(Math.max(1, wpm * 0.05));
    });
  }

  it("reads through heavy noise", () => {
    const turns = decode(mix(lines(22), 48000, 0.15), 48000);
    expect(texts(turns)).toEqual(["CQ CQ DE K7ABC K7ABC K", "K7ABC DE W1AW UR 579 NAME JOE QTH CT BK"]);
  });

  it("reads a bug", () => {
    const turns = decode(mix(lines(25, { fist: bugFist(3) })), 48000);
    expect(texts(turns).join(" ")).toBe("CQ CQ DE K7ABC K7ABC K K7ABC DE W1AW UR 579 NAME JOE QTH CT BK");
  });

  it("reads a straight key's characters", () => {
    const turns = decode(mix(lines(15, { fist: straightFist(5) })), 48000);
    expect(texts(turns).join("").replace(/ /g, "")).toBe("CQCQDEK7ABCK7ABCKK7ABCDEW1AWUR579NAMEJOEQTHCTBK");
  });
});

describe("stations", () => {
  const ragChew = (start: number): Keyed[] =>
    inTurn(
      [
        { text: "CQ CQ DE W7YFR W7YFR K", wpm: 18, hz: 600, amp: 0.5 },
        { text: "W7YFR DE K7ABC K7ABC K", wpm: 25, hz: 610, amp: 0.15 },
        { text: "K7ABC DE W7YFR UR RST 579 NAME BOB QTH SEATTLE WA BK", wpm: 18, hz: 600, amp: 0.5 },
        { text: "BK R TNX BOB UR 599 NAME JIM QTH BOISE ID BK", wpm: 25, hz: 610, amp: 0.15 },
      ],
      start,
    );
  const cwt: Keyed[] = inTurn(
    [
      { text: "CQ CWT N5XX N5XX", wpm: 28, hz: 820, amp: 0.4 },
      { text: "K1ZZ", wpm: 30, hz: 825, amp: 0.12 },
      { text: "K1ZZ TOM 1234", wpm: 28, hz: 820, amp: 0.4 },
      { text: "TU MIKE 2345", wpm: 30, hz: 825, amp: 0.12 },
      { text: "TU N5XX", wpm: 28, hz: 820, amp: 0.4 },
    ],
    3,
    0.6,
  );

  it("splits the two sides of a QSO on one pitch into turns", () => {
    const turns = decode(mix(ragChew(0.5)), 48000);
    expect(texts(turns)).toEqual([
      "CQ CQ DE W7YFR W7YFR K",
      "W7YFR DE K7ABC K7ABC K",
      "K7ABC DE W7YFR UR RST 579 NAME BOB QTH SEATTLE WA BK",
      "BK R TNX BOB UR 599 NAME JIM QTH BOISE ID BK",
    ]);
    expect(new Set(turns.map((t) => t.ch)).size).toBe(1);
    expect(turns.map((t) => t.wpm)).toEqual([18, 25, 18, 25]);
  });

  it("follows two QSOs on two pitches at once", () => {
    const turns = decode(mix([...ragChew(0.5), ...cwt]), 48000);
    const on = (hz: number) => texts(turns.filter((t) => Math.abs(t.hz - hz) < 50));
    expect(on(600)).toEqual([
      "CQ CQ DE W7YFR W7YFR K",
      "W7YFR DE K7ABC K7ABC K",
      "K7ABC DE W7YFR UR RST 579 NAME BOB QTH SEATTLE WA BK",
      "BK R TNX BOB UR 599 NAME JIM QTH BOISE ID BK",
    ]);
    expect(on(820)).toEqual(["CQ CWT N5XX N5XX", "K1ZZ", "K1ZZ TOM 1234", "TU MIKE 2345", "TU N5XX"]);
    expect(turns.every((t) => Math.abs(t.hz - 600) < 50 || Math.abs(t.hz - 820) < 50)).toBe(true);
  });

  it("reads hard-keyed signals without opening channels on their clicks", () => {
    const hard = [...ragChew(1.2), ...cwt].map((k) => ({ ...k, rampMs: 1 }));
    const turns = decode(mix(hard, 48000, 0.006, 2), 48000);
    expect(new Set(turns.map((t) => t.ch)).size).toBe(2);
    expect(texts(turns).filter((t) => t.startsWith("CQ"))).toEqual(["CQ CQ DE W7YFR W7YFR K", "CQ CWT N5XX N5XX"]);
  });

  it("reads nothing from noise alone", () => {
    expect(decode(mix([{ text: "E", wpm: 20, hz: 700, amp: 0, at: 0 }], 48000, 0.05), 48000)).toEqual([]);
  });
});

describe("recordings", () => {
  const cases: [string, string][] = [
    ["cq-ab1cd-20wpm-k3ng.wav", "CQ CQ DE AB1CD K"],
    ["cq-de-w7yfr-mic-1.wav", "CQ DE W7YFR"],
    ["cq-de-w7yfr-mic-2.wav", "CQ DE W7YFR"],
  ];
  for (const [file, text] of cases) {
    it(`reads ${file}`, () => {
      const w = readWav(join(DATA_DIR, file));
      expect(texts(decode(w.samples, w.rate))).toEqual([text]);
    });
  }
});
