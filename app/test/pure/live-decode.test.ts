/* The Live page's decoder, on audio it has never been told the speed of.
 *
 * The audio goes in as the microphone delivers it, 128 samples at a time,
 * and the decoder runs a pass every 150 ms, as the worker does. */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LiveDecoder, type Turn } from "@/live/decoder";
import { bugFist, straightFist } from "@/timing/fist";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";
import { vocabulary } from "@/qso/vocabulary";
import { inTurn, mix, type Keyed } from "../live-mix";

/** The words the page reads by meaning with, as for a station with no
 *  details set. */
const WORDS = vocabulary([]);

/** Every turn, final, in the order they started. Each turn shown while
 *  still being read goes in `shown`, when given. */
function decode(audio: Float32Array, rate: number, words: readonly string[] = WORDS, shown?: Turn[]): Turn[] {
  const d = new LiveDecoder(rate, null, words);
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
      const step = d.step();
      out.push(...step.final);
      shown?.push(...step.open);
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

  for (const wpm of [12, 20, 30, 40]) {
    it(`reads ${wpm} WPM with no speed set, and measures it`, () => {
      const turns = decode(mix(lines(wpm)), 48000);
      expect(texts(turns)).toEqual(["CQ CQ DE K7ABC K7ABC K", "K7ABC DE W1AW UR 579 NAME JOE QTH CT BK"]);
      for (const t of turns) expect(Math.abs(t.wpm - wpm)).toBeLessThanOrEqual(Math.max(1, wpm * 0.05));
    });
  }

  it("takes keying faster than 45 WPM for noise", () => {
    expect(texts(decode(mix(lines(52)), 48000))).toEqual([]);
  });

  it("reads through heavy noise", () => {
    const turns = decode(mix(lines(22), 48000, 0.15), 48000);
    expect(texts(turns)).toEqual(["CQ CQ DE K7ABC K7ABC K", "K7ABC DE W1AW UR 579 NAME JOE QTH CT BK"]);
  });

  it("reads a bug", () => {
    const turns = decode(mix(lines(25, { fist: bugFist(3) })), 48000);
    expect(texts(turns).join(" ")).toBe("CQ CQ DE K7ABC K7ABC K K7ABC DE W1AW UR 579 NAME JOE QTH CT BK");
  });

  it("reads a straight key's words by meaning", () => {
    for (const seed of [1, 2, 4, 5]) {
      const turns = decode(mix(lines(15, { fist: straightFist(seed) })), 48000);
      expect(texts(turns).join(" ")).toBe("CQ CQ DE K7ABC K7ABC K K7ABC DE W1AW UR 579 NAME JOE QTH CT BK");
    }
  });

  it("reads by timing alone with no words", () => {
    const turns = decode(mix(lines(15, { fist: straightFist(4) })), 48000, []);
    expect(texts(turns).join(" ")).not.toBe("CQ CQ DE K7ABC K7ABC K K7ABC DE W1AW UR 579 NAME JOE QTH CT BK");
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

  it("decodes only the pitches in its range", () => {
    const audio = mix([...ragChew(0.5), ...cwt]);
    const d = new LiveDecoder(48000, null, WORDS);
    d.setRange([700, 900]);
    const out: Turn[] = [];
    const padded = new Float32Array(audio.length + 48000 * 3);
    padded.set(audio);
    for (let i = 0; i < padded.length; i += 128) {
      d.push(padded.subarray(i, i + 128));
      if (i % 7200 < 128) out.push(...d.step().final);
    }
    out.push(...d.flush());
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => Math.abs(t.hz - 820) < 30)).toBe(true);
  });

  it("reads hard-keyed signals without opening channels on their clicks", () => {
    const hard = [...ragChew(1.2), ...cwt].map((k) => ({ ...k, rampMs: 1 }));
    const shown: Turn[] = [];
    const turns = decode(mix(hard, 48000, 0.006, 2), 48000, WORDS, shown);
    expect(new Set(turns.map((t) => t.ch)).size).toBe(2);
    // Not even for a moment, while a turn is still being read.
    expect(new Set(shown.map((t) => t.ch)).size).toBe(2);
    expect(texts(turns).filter((t) => t.startsWith("CQ"))).toEqual(["CQ CQ DE W7YFR W7YFR K", "CQ CWT N5XX N5XX"]);
  });

  it("reads nothing from noise alone", () => {
    expect(decode(mix([{ text: "E", wpm: 20, hz: 700, amp: 0, at: 0 }], 48000, 0.05), 48000)).toEqual([]);
  });
});

describe("recordings", () => {
  // The author's own call is in the words, as Settings › You puts it there.
  const mine = vocabulary(["W7YFR"]);
  const cases: [string, string, readonly string[]][] = [
    ["cq-ab1cd-20wpm-k3ng.wav", "CQ CQ DE AB1CD K", WORDS],
    ["cq-de-w7yfr-mic-1.wav", "CQ DE W7YFR", mine],
    ["cq-de-w7yfr-mic-2.wav", "CQ DE W7YFR", mine],
    // The author's keyer: letter gaps as wide as word gaps.
    ["cq-de-w7yfr.wav", "CQ DE W7YFR", mine],
    ["tu-w7yfr-wide-letters.wav", "T A EEE TU W7YFR", mine],
    ["bk-tu-error-sign-73-ee.wav", "BK TU Z EEE 73 EE", mine],
  ];
  for (const [file, text, words] of cases) {
    it(`reads ${file}`, () => {
      const w = readWav(join(DATA_DIR, file));
      expect(texts(decode(w.samples, w.rate, words))).toEqual([text]);
    });
  }
});

describe("hard starts", () => {
  const cq = "CQ CQ DE K7ABC K7ABC K";

  it("reads nothing into the digital silence the recorder starts with", () => {
    const audio = mix([{ text: cq, wpm: 22, hz: 600, amp: 0.3, at: 3 }]);
    audio.fill(0, 0, 48000 / 2);
    expect(texts(decode(audio, 48000))).toEqual([cq]);
  });

  it("follows a station after noise has opened every channel", () => {
    // Bursts of dits on 8 pitches every 10 s, never keyed like a station,
    // and a CQ among them.
    const blips: Keyed[] = [];
    for (let at = 1; at < 90; at += 10) {
      for (let k = 0; k < 8; k++) blips.push({ text: "EEE", wpm: 30, hz: 650 + 90 * k, amp: 0.2, at: at + k * 0.3 });
    }
    const turns = decode(mix([...blips, { text: cq, wpm: 22, hz: 450, amp: 0.3, at: 64 }]), 48000);
    expect(texts(turns.filter((t) => Math.abs(t.hz - 450) < 20))).toEqual([cq]);
  });
});

describe("on the air", () => {
  // The author's radio, W1AW/5 running at 540 Hz inside a CW filter's band of
  // noise, with the AGC pumping. Kept with the plans, not in the repo: it has
  // real calls in it. Skipped where it is not.
  const file = join(DATA_DIR, "../../../docs/live/w1aw5-agc-2026-11-21.wav");

  it.skipIf(!existsSync(file))("reads the run to its end, with no noise read as lines", () => {
    const w = readWav(file);
    const shown: Turn[] = [];
    const turns = decode(w.samples, w.rate, vocabulary(["W7YFR"]), shown);
    const text = texts(turns);
    expect(text).toContain("CQ W1AW/5");
    expect(text).toContain("UR CALL?");
    expect(text).toContain("KC3RN OK W1AW/5");
    // The last two bursts, after 79 s, which the channel used to lose.
    expect(turns.filter((t) => t.t0 > 79 && t.text.includes("W1AW")).length).toBeGreaterThanOrEqual(2);
    // Nothing off the station's pitch but the odd faint E, I or T.
    expect(turns.filter((t) => Math.abs(t.hz - 520) > 40 && /[^EIT ]/.test(t.text))).toEqual([]);
    // Nor while being read: an echo beside the station, then gone.
    expect(new Set(shown.filter((t) => Math.abs(t.hz - 520) > 40 && /[^EIT ]/.test(t.text)).map((t) => t.text))).toEqual(new Set());
  });

  // A long rag chew: K5KV sends for over a minute and a half in one turn,
  // with a hum at 750 Hz and spill far under the signal.
  const ragchew = join(DATA_DIR, "../../../docs/live/k5kv-ragchew-2026-11-21.wav");

  it.skipIf(!existsSync(ragchew))("keeps a long turn steady while it is read, and shows no echo of it", () => {
    const w = readWav(ragchew);
    const d = new LiveDecoder(w.rate, null, vocabulary(["W7YFR"]));
    const pass = Math.round(w.rate * 0.15);
    let prev = "";
    let prevTurn = "";
    let rewrites = 0;
    const off: string[] = [];
    for (let i = 0; i < w.samples.length; i += 128) {
      d.push(w.samples.subarray(i, i + 128));
      if (i % pass >= 128) continue;
      const step = d.step();
      for (const t of [...step.open, ...step.final]) if (Math.abs(t.hz - 500) > 40 && /[^EIT ]/.test(t.text)) off.push(t.text);
      const open = step.open.filter((t) => Math.abs(t.hz - 500) <= 40).at(-1);
      if (!open) continue;
      // A change before the last few words would move the lines under it.
      if (open.id === prevTurn && prev.length > 30 && !open.text.startsWith(prev.slice(0, -30))) rewrites++;
      prev = open.text;
      prevTurn = open.id;
    }
    expect(rewrites).toBeLessThanOrEqual(3);
    expect(off).toEqual([]);
  });

  // The same rag chew, from the author's screen recording of the page. At
  // 37.7 s a turn's pace was once thrown off for a pass, and its last words
  // read as ▯ M TT TT TO MT.
  const video = join(DATA_DIR, "../../../docs/live/live-decode-2026-11-21.wav");

  it.skipIf(!existsSync(video))("keeps the speed and words of a turn steady through a pass its pace is thrown off", () => {
    const w = readWav(video);
    const d = new LiveDecoder(w.rate, null, vocabulary(["W7YFR"]));
    const pass = Math.round(w.rate * 0.15);
    let prevId = "";
    let prevWpm = 0;
    let prev = "";
    const jumps: string[] = [];
    for (let i = 0; i < w.samples.length; i += 128) {
      d.push(w.samples.subarray(i, i + 128));
      if (i % pass >= 128) continue;
      const open = d.step().open.filter((t) => Math.abs(t.hz - 500) <= 60).at(-1);
      if (!open) continue;
      if (open.id === prevId) {
        if (prevWpm && Math.abs(open.wpm - prevWpm) > 0.3 * prevWpm) jumps.push(`${prevWpm} to ${open.wpm} WPM`);
        if (prev.length > 30 && !open.text.startsWith(prev.slice(0, -30))) jumps.push(open.text.slice(-40));
      }
      prevId = open.id;
      prevWpm = open.wpm;
      prev = open.text;
    }
    expect(jumps).toEqual([]);
  });
});
