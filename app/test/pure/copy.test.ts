/* The Copy page's reading of a recording, and your copy of it. */

import { describe, expect, it } from "vitest";
import { synthesize } from "@/audio/synth";
import { decodeRecording, groupPitches, runsOf, type Over } from "@/copy/decode";
import {
  copyText,
  emptyCopy,
  gradeLine,
  heard,
  nextCopy,
  overOfText,
  skipSpan,
  slotRight,
  type LineCopy,
} from "@/copy/lines";
import { targetTiming } from "@/timing/model";

const RATE = 8000;

/** A QSO as one recording: each over at its station's tone, a word gap
 *  between overs, as a QSO tape has. */
function qso(overs: readonly { text: string; toneHz: number }[], wpm = 20): Float32Array {
  const timing = targetTiming(wpm, wpm);
  const parts = overs.map((o) =>
    synthesize(o.text, timing, { toneHz: o.toneHz, rate: RATE, padSec: timing.wordGapSec / 2, amplitude: 0.5 }).samples,
  );
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

const EXCHANGE = [
  { text: "CQ CQ DE W7YFR K", a: true },
  { text: "W7YFR DE N1AK KN", a: false },
  { text: "N1AK DE W7YFR UR 599 BK", a: true },
  { text: "R TU 73 DE N1AK SK", a: false },
  { text: "EE", a: true },
];

describe("decodeRecording", () => {
  for (const [name, a, b] of [
    ["two stations close in pitch", 600, 630],
    ["two stations far apart in pitch", 600, 820],
  ] as const) {
    it(`reads ${name} as one line per over`, () => {
      const samples = qso(EXCHANGE.map((o) => ({ text: o.text, toneHz: o.a ? a : b })));
      const rec = decodeRecording(samples, RATE)!;
      expect(rec).not.toBeNull();
      expect(rec.overs.map((o) => o.text)).toEqual(EXCHANGE.map((o) => o.text));
      expect(rec.overs.map((o) => o.sender)).toEqual(EXCHANGE.map((o) => (o.a ? 0 : 1)));
      expect(rec.senders.map((s) => s.call)).toEqual(["W7YFR", "N1AK"]);
      expect(Math.abs(rec.senders[0]!.toneHz - a)).toBeLessThan(3);
      expect(Math.abs(rec.senders[1]!.toneHz - b)).toBeLessThan(3);
    });
  }

  it("keeps each character's time, in order", () => {
    const rec = decodeRecording(qso([{ text: "TEST DE W7YFR", toneHz: 600 }]), RATE)!;
    const chars = rec.overs.flatMap((o) => o.words.flatMap((w) => w.chars));
    expect(chars.map((c) => c.char).join("")).toBe("TESTDEW7YFR");
    for (let i = 1; i < chars.length; i++) expect(chars[i]!.t0).toBeGreaterThan(chars[i - 1]!.t1);
  });

  it("reads silence as nothing", () => {
    expect(decodeRecording(new Float32Array(RATE * 3), RATE)).toBeNull();
  });
});

describe("groupPitches", () => {
  it("puts pitches within a few hertz in one group", () => {
    const { group, centers } = groupPitches([590, 620, 590.5, 619.5, 590, 620]);
    expect(group).toEqual([0, 1, 0, 1, 0, 1]);
    expect(centers).toEqual([590, 620]);
  });

  it("joins a group too small to be a station to the nearest", () => {
    const pitches = [...Array(100).fill(600), 612, ...Array(100).fill(700)];
    expect(groupPitches(pitches).centers).toHaveLength(2);
  });
});

describe("runsOf", () => {
  const word = (...senders: number[]) => ({ senders });

  it("gives a word the station most of its characters have", () => {
    expect(runsOf([word(0, 0, 0), word(1, 0, 0), word(0, 0)])).toEqual([0, 0, 0]);
  });

  it("keeps a short word whole at another pitch, as a hunter's NK", () => {
    expect(runsOf([word(0, 0, 0), word(1, 1), word(0, 0, 0)])).toEqual([0, 1, 0]);
  });
});

/** An over of `words`, a character every half second. */
function over(...words: string[]): Over {
  let t = 0;
  const ws = words.map((w) => ({
    chars: (w.match(/<[A-Z]+>|./g) ?? []).map((char) => {
      const c = { char, t0: t, t1: t + 0.3 };
      t += 0.5;
      return c;
    }),
  }));
  return { sender: 0, words: ws, text: words.join(" "), t0: 0, t1: t };
}

describe("your copy", () => {
  const o = over("CQ", "DE", "N1AK", "<KN>");

  it("grades a box by character, a prosign by its letters", () => {
    const copy: LineCopy = { ...emptyCopy(o), typed: "CQ DE N1A" };
    expect(gradeLine(o, copy, "text")).toEqual({ right: 7, total: 10 });
    expect(gradeLine(o, { ...copy, typed: "CQ DE N1AK KN" }, "text")).toEqual({ right: 10, total: 10 });
    expect(gradeLine(o, { ...copy, typed: "CQ DE N1AK <KN>" }, "text")).toEqual({ right: 10, total: 10 });
  });

  it("grades slots one by one, and takes a prosign's letters", () => {
    const slots = ["C", "Q", "D", "X", "N", "1", "A", "K", "KN"];
    expect(gradeLine(o, { ...emptyCopy(o), slots }, "slots")).toEqual({ right: 8, total: 9 });
    expect(slotRight("<KN>", "kn")).toBe(true);
  });

  it("writes slots as text, with a gap for empty slots", () => {
    const slots = ["C", "Q", "", "", "N", "", "A", "K", ""];
    expect(copyText(o, { ...emptyCopy(o), slots }, "slots")).toBe("CQ .. N..AK ..");
  });

  it("starts the next attempt from your last copy, right slots kept", () => {
    const slots = ["C", "Q", "D", "X", "N", "1", "A", "K", "KN"];
    const next = nextCopy(o, { ...emptyCopy(o), slots, locked: true }, true);
    expect(next.locked).toBe(false);
    expect(next.slots).toEqual(["C", "Q", "D", "", "N", "1", "A", "K", "KN"]);
    expect(next.kept).toEqual([true, true, true, false, true, true, true, true, true]);
  });

  it("starts the next attempt clean", () => {
    const copy: LineCopy = { ...emptyCopy(o), typed: "CQ DE", locked: true };
    expect(nextCopy(o, copy, false)).toEqual(emptyCopy(o));
  });

  it("locks a line of slots all right in the next attempt", () => {
    const slots = ["C", "Q", "D", "E", "N", "1", "A", "K", "KN"];
    expect(nextCopy(o, { ...emptyCopy(o), slots, locked: true }, true).locked).toBe(true);
  });

  it("has a call only when it is copied whole", () => {
    expect(heard("N1AK", ["CQ DE N1AK"])).toBe(true);
    expect(heard("N1AK", ["CQ DE N1A"])).toBe(false);
  });
});

describe("skipSpan", () => {
  const spans: [number, number][] = [
    [1, 2],
    [3, 4],
    [5, 6],
  ];

  it("goes back to the start of the span it is in", () => {
    expect(skipSpan(spans, 3.8, -1)).toBe(3);
  });

  it("goes back one more when it is at the start already", () => {
    expect(skipSpan(spans, 3.1, -1)).toBe(1);
  });

  it("goes back one more while still in the span the last skip back landed on", () => {
    expect(skipSpan(spans, 3.8, -1, 3)).toBe(1);
    expect(skipSpan(spans, 5.8, -1, 3)).toBe(5);
  });

  it("goes on to the start of the next span", () => {
    expect(skipSpan(spans, 3, 1)).toBe(5);
    expect(skipSpan(spans, 5.5, 1)).toBeNull();
  });
});

describe("each station's call", () => {
  it("comes from the other station when a station never sends DE and its call", () => {
    const samples = qso([
      { text: "CQ POTA DE W3YNI", toneHz: 600 },
      { text: "NK", toneHz: 640 },
      { text: "NK0V GA UR 5NN", toneHz: 600 },
      { text: "GA 5NN 5NN", toneHz: 640 },
    ]);
    const rec = decodeRecording(samples, RATE)!;
    expect(rec.senders.map((s) => s.call)).toEqual(["W3YNI", "NK0V"]);
  });
});

describe("overOfText", () => {
  it("makes a line sent from text, a word at a time, a prosign as one character", () => {
    const over = overOfText("w1aw de k7abc <BK>", 25, 20);
    expect(over.words.map((w) => w.chars.map((c) => c.char).join(""))).toEqual(["W1AW", "DE", "K7ABC", "<BK>"]);
    expect(over.text).toBe("W1AW DE K7ABC <BK>");
  });

  it("puts each character after the one before, inside the line", () => {
    const over = overOfText("TU 5NN", 25, 25);
    const chars = over.words.flatMap((w) => w.chars);
    for (let i = 1; i < chars.length; i++) expect(chars[i]!.t0).toBeGreaterThan(chars[i - 1]!.t1);
    expect(chars[0]!.t0).toBe(0);
    expect(over.t1).toBe(chars.at(-1)!.t1);
  });

  it("takes longer at a slower speed", () => {
    expect(overOfText("CQ CQ", 15, 15).t1).toBeGreaterThan(overOfText("CQ CQ", 30, 30).t1);
  });
});
