/* The QSO page's two halves: copying an over with no message to follow, and
 * the script that answers it. */

import { describe, expect, it } from "vitest";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { LiveCopy, overEnded, sentSymbols } from "@/timing/live";
import type { Calibration } from "@/dsp";
import {
  answer,
  erased,
  isCall,
  isErrorSign,
  nearly,
  newQso,
  wordsOf,
  type Context,
  type Qso,
} from "@/qso/cq";
import { randomStation } from "@/qso/station";
import { NO_SEARCH, STEPS, faster, qrq, qrs, setTo, slower, type Speed } from "@/qso/speed";
import { gradeCopy, revealed } from "@/qso/show";
import { examples } from "@/qso/examples";

/** A fixed sequence, so the station is the same every run. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Feeds `text`, then `quietSec` of silence, in microphone-sized blocks, and
 *  asks for a reading after each quarter second. Returns every reading. */
function copyOf(
  text: string,
  wpm: number,
  quietSec: number,
  { readAt = targetTiming(wpm), lenient = false } = {},
) {
  const timing = targetTiming(wpm);
  const keyed = synthesize(text, timing, { rate: 48000, padSec: 0.3 }).samples;
  const all = new Float32Array(keyed.length + Math.round(quietSec * 48000));
  all.set(keyed);
  const copy = new LiveCopy(48000, readAt, lenient);
  const readings = [];
  let next = 12000;
  for (let k = 0; k < all.length; k += 128) {
    copy.push(all.subarray(k, k + 128));
    if (k >= next) {
      readings.push(copy.step());
      next += 12000;
    }
  }
  readings.push(copy.step());
  return readings;
}

describe("copying an over", () => {
  it("reads nothing from keying below the floor, however clean", () => {
    const timing = targetTiming(25);
    const keyed = synthesize("K7PP", timing, { rate: 48000, padSec: 0.3 }).samples;
    let peak = 0;
    for (const v of keyed) peak = Math.max(peak, Math.abs(v));
    const at = (level: number) => sentSymbols(keyed.map((v) => (v / peak) * level), 48000, timing).text;
    expect(at(0.01)).toBe("K7PP");
    expect(at(0.0005)).toBe("");
    expect(at(0.00001)).toBe("");
  });

  it("reads the words with spaces between them", () => {
    const last = copyOf("CQ CQ DE W7YFR K", 20, 2).at(-1)!;
    expect(last.text).toBe("CQ CQ DE W7YFR K");
  });

  it("ends the over a moment after K", () => {
    const readings = copyOf("CQ DE W7YFR K", 20, 3);
    expect(readings.at(-1)!.over).toBe(true);
    // Not before the K has been read.
    for (const r of readings) if (!r.text.endsWith(" K")) expect(r.over).toBe(false);
  });

  it("ends an over with no turn word only after a long silence", () => {
    expect(copyOf("5NN 123", 20, 1.5).at(-1)!.over).toBe(false);
    expect(copyOf("5NN 123", 20, 3.5).at(-1)!.over).toBe(true);
  });

  it("reads words keyed tighter than the set spacing, when lenient", () => {
    // Keyed at 25 wpm spacing, read against 16 wpm spacing.
    const readAt = targetTiming(25, 16);
    const text = "CQ CQ CQ DE W7YFR W7YFR K";
    expect(copyOf(text, 25, 2, { readAt }).at(-1)!.text).not.toBe(text);
    expect(copyOf(text, 25, 2, { readAt, lenient: true }).at(-1)!.text).toBe(text);
  });

  it("takes KN, BK, SK and a question as the turn", () => {
    const timing = targetTiming(20);
    for (const end of ["<KN>", "KN", "<BK>", "<SK>", "AGN?", "?"]) {
      expect(overEnded(`W7YFR DE K4ABC ${end}`, 2.5, timing)).toBe(true);
    }
    // A pause after a K in the middle of an over is not the end of it.
    expect(overEnded("R R K", 1.5, timing)).toBe(false);
    // A K alone, at the start of an over, waits twice as long.
    expect(overEnded("K", 2.5, timing)).toBe(false);
    expect(overEnded("K", 4, timing)).toBe(false);
    expect(overEnded("K", 4.8, timing)).toBe(true);
    // A misread character before a ? is not a question.
    expect(overEnded("K4ABC UR 5NN 5?", 2.5, timing)).toBe(false);
    expect(overEnded("W7YFR DE AA7K", 2.5, timing)).toBe(false);
    expect(overEnded("", 10, timing)).toBe(false);
  });
});

describe("reading an over", () => {
  it("knows a call from a report", () => {
    for (const call of ["W7YFR", "K4ABC", "AA7K", "VE3XYZ", "2E0ABC", "W7YFR/P"]) {
      expect(isCall(call)).toBe(true);
    }
    for (const word of ["5NN", "599", "73", "CQ", "TNX", "K"]) expect(isCall(word)).toBe(false);
  });

  it("knows the error sign, keyed cleanly or not", () => {
    for (const w of ["<HH>", "EEE", "EEEEEEEE", "HH", "H5", "SSS", "5S"]) expect(isErrorSign(w)).toBe(true);
    for (const w of ["E", "EE", "I", "S", "H", "5", "IS", "ES", "HE", "HI", "HIS", "SHE", "SEE"]) {
      expect(isErrorSign(w)).toBe(false);
    }
  });

  it("drops the word before each error sign", () => {
    expect(erased(wordsOf("DE W7YR EEE W7YFR K"))).toEqual(["DE", "W7YFR", "K"]);
    expect(erased(wordsOf("<HH> CQ"))).toEqual(["CQ"]);
    expect(erased(wordsOf("TU 73 E E"))).toEqual(["TU", "73", "E", "E"]);
  });

  it("splits a prosign keyed against a word", () => {
    expect(wordsOf("73<SK> ee")).toEqual(["73", "<SK>", "EE"]);
  });
});

describe("a QSO from your CQ", () => {
  const start = (): Qso => newQso(seeded());
  /** Every pick the first wording, every part kept, in the evening. */
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const LENIENT: Context = { ...FIRST, ear: { lenient: true, saved: "" } };

  it("runs to the end", () => {
    let q = start();
    const { call: c, rst, name, qth } = q.them;

    let t = answer(q, "CQ CQ DE W7YFR W7YFR K", FIRST);
    expect(t.reply).toBe(`W7YFR DE ${c} ${c} K`);
    q = t.qso;

    t = answer(q, `${c} DE W7YFR TNX FER CALL UR RST 579 579 NAME BOB BOB HW? ${c} DE W7YFR KN`, FIRST);
    const r = rst === "599" ? "5NN" : rst;
    expect(t.reply).toBe(
      `W7YFR DE ${c} R TNX FER RPT GE BOB <BT> UR RST ${r} ${r} NAME ${name} ${name} ` +
        `QTH ${qth} ${qth} HW? W7YFR DE ${c} KN`,
    );
    q = t.qso;

    t = answer(q, `R TNX ${name} 73 ${c} DE W7YFR <SK>`, FIRST);
    expect(t.ended).toBe(true);
    expect(t.reply).toBe(`TU BOB 73 GL W7YFR DE ${c} <SK> E E`);
  });

  it("thanks you for a report only when you sent one", () => {
    const q = answer(start(), "CQ DE W7YFR K", FIRST).qso;
    const c = q.them.call;
    const without = answer(q, `${c} DE W7YFR K`, FIRST).reply!;
    expect(without).not.toContain("RPT");
    expect(without).toMatch(new RegExp(`^W7YFR DE ${c} R GE OM `));
    expect(answer(q, `${c} DE W7YFR UR 5NN KN`, FIRST).reply).toContain("TNX FER RPT");
  });

  it("confirms its call when you ask about it", () => {
    const q = answer(start(), "CQ DE W7YFR K", FIRST).qso;
    const c = q.them.call;
    for (const over of [`${c}? DE W7YFR K`, `${c} ? K`]) {
      const t = answer(q, over, FIRST);
      expect(t.reply).toBe(`R R DE ${c} ${c} K`);
      expect(t.qso.stage).toBe("called");
    }
    // The over from the screenshot: AE4XS? keyed with its spacing broken.
    const garbled = `K AEV<BT>S ${c.slice(0, 3)} ${c.slice(3)} ?`;
    expect(answer(q, garbled, LENIENT).reply).toBe(`R R DE ${c} ${c} K`);
  });

  it("takes HW? at the end of your exchange as a question to it, not about its call", () => {
    const q = answer(start(), "CQ DE W7YFR K", FIRST).qso;
    const c = q.them.call;
    expect(answer(q, `${c} DE W7YFR NAME BOB HW? KN`, FIRST).qso.stage).toBe("exchanged");
  });

  it("asks for the call of a CQ it cannot read, and takes it without CQ", () => {
    const q = start();
    const t = answer(q, "CQ CQ DE K", FIRST);
    expect(t.reply).toBe(`CALL? DE ${q.them.call} K`);
    const next = answer(t.qso, "DE W7YFR W7YFR K", FIRST);
    expect(next.reply).toBe(`W7YFR DE ${q.them.call} ${q.them.call} K`);
  });

  it("does not answer an over that is not a CQ", () => {
    expect(answer(start(), "W7YFR K").reply).toBeNull();
  });

  it("takes your call as corrected with the error sign", () => {
    // The CQ from the screenshot.
    const t = answer(start(), "CQ W EEE POTA DE W7YR EEE W7YFR W7YFR K", FIRST);
    expect(t.qso.you).toBe("W7YFR");
  });

  it("takes the call you sent most after DE", () => {
    expect(answer(start(), "CQ DE W7YR W7YFR W7YFR K").qso.you).toBe("W7YFR");
  });

  it("takes a corrected call later in the QSO", () => {
    const q = answer(start(), "CQ DE W7YR K", FIRST).qso;
    const c = q.them.call;
    expect(q.you).toBe("W7YR");
    // The second over from the screenshot: DE keyed apart, so lenient only.
    const over = `K ${c} N EE D E W7YFR W7YFR <BT> HWP ?`;
    const strict = answer(q, over, FIRST);
    expect(strict.qso.you).toBe("W7YR");
    const t = answer(q, over, LENIENT);
    expect(t.qso.you).toBe("W7YFR");
    expect(t.reply).toMatch(new RegExp(`^W7YFR DE ${c} `));
    // With DE keyed right, strict copy takes it too.
    expect(answer(q, `${c} DE W7YFR W7YFR K`, FIRST).qso.you).toBe("W7YFR");
  });

  it("answers the call you sent, as copied", () => {
    expect(answer(start(), "CQ DE W7YFT K").qso.you).toBe("W7YFT");
  });

  it("sends its call again for as long as it takes", () => {
    let q = answer(start(), "CQ DE W7YFR K").qso;
    for (let i = 0; i < 5; i++) {
      const t = answer(q, "QRZ? DE W7YFR K", FIRST);
      expect(t.reply).toBe(`DE ${q.them.call} ${q.them.call} K`);
      expect(t.ended).toBe(false);
      q = t.qso;
    }
  });

  it("sends its exchange again on AGN", () => {
    let q = answer(start(), "CQ DE W7YFR K").qso;
    const ex = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB KN`);
    q = ex.qso;
    expect(answer(q, "AGN? KN").reply).toBe(ex.reply);
  });

  it("asks again for an exchange it cannot read, and AGN still means the exchange", () => {
    let q = answer(start(), "CQ DE W7YFR K").qso;
    const ex = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB KN`);
    q = ex.qso;
    const t = answer(q, "\u25AF\u25AF \u25AF5 KN", FIRST);
    expect(t.reply).toBe(`PSE AGN W7YFR DE ${q.them.call} KN`);
    expect(t.ended).toBe(false);
    expect(answer(t.qso, "AGN? KN").reply).toBe(ex.reply);
  });

  it("signs first when you keep going, and the QSO ends on your 73", () => {
    let q = answer(start(), "CQ DE W7YFR K").qso;
    q = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`).qso;
    const t = answer(q, "FB RIG HR IS K3 ES ANT IS DIPOLE KN", FIRST);
    expect(t.qso.stage).toBe("signing");
    expect(t.reply).toBe(`R R FB BOB TNX FER QSO HPE CUAGN 73 W7YFR DE ${q.them.call} <SK>`);
    const last = answer(t.qso, "TU 73 <SK>", FIRST);
    expect(last.ended).toBe(true);
    expect(last.reply).toBe("E E");
  });

  it("greets you by the time of day", () => {
    const q = answer(start(), "CQ DE W7YFR K").qso;
    const over = `${q.them.call} DE W7YFR UR 599 NAME BOB KN`;
    expect(answer(q, over, { ...FIRST, hour: 8 }).reply).toContain("GM BOB");
    expect(answer(q, over, { ...FIRST, hour: 14 }).reply).toContain("GA BOB");
    expect(answer(q, over, { ...FIRST, hour: 20 }).reply).toContain("GE BOB");
  });

  it("words its overs differently from one QSO to the next", () => {
    const rand = seeded(3);
    const callBacks = new Set<string>();
    const exchanges = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const q = answer(newQso(() => 0.5), "CQ DE W7YFR K", { rand }).qso;
      callBacks.add(q.last);
      const ex = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB KN`, { rand });
      exchanges.add(ex.reply!);
    }
    expect(callBacks.size).toBeGreaterThanOrEqual(4);
    expect(exchanges.size).toBeGreaterThanOrEqual(30);
  });

  it("keeps every over to characters it can key", () => {
    const rand = seeded(5);
    for (let i = 0; i < 40; i++) {
      let q = answer(newQso(rand), "CQ DE W7YFR K", { rand }).qso;
      const replies = [q.last];
      let t = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB KN`, { rand });
      replies.push(t.reply!);
      q = t.qso;
      t = answer(q, "FB KN", { rand });
      replies.push(t.reply!);
      t = answer(t.qso, "73 <SK>", { rand });
      replies.push(t.reply!);
      for (const r of replies) {
        expect(r).not.toMatch(/ {2}|^ | $/);
        expect(wordsOf(r).join(" ")).toBe(r);
      }
    }
  });

  it("reads words run together and a call one off, when lenient", () => {
    const q = start();
    const them = q.them.call;
    expect(answer(q, "CQCQCQDEW7YFRW7YFRX K").reply).toBeNull();
    const t = answer(q, "CQCQCQDEW7YFRW7YFRX K", LENIENT);
    expect(t.qso.you).toBe("W7YFR");
    // One character dropped from their call: strict copy does not see its
    // call, and lenient copy sees it sent wrong. Either way it waits.
    const off = them.slice(0, -1);
    expect(answer(t.qso, `${off} DE W7YFR UR 599 KN`, FIRST).reply).toBe(`DE ${them} ${them} K`);
    const fixed = answer(t.qso, `${off} DE W7YFR UR 599 KN`, LENIENT);
    expect(fixed.reply).toBe(`MY CALL ${them} ${them} K`);
    expect(fixed.qso.stage).toBe("called");
    expect(answer(fixed.qso, `${them} DE W7YFR UR 599 KN`, LENIENT).qso.stage).toBe("exchanged");
  });

  it("knows your call from Configuration, when lenient", () => {
    const t = answer(start(), "CQCQDEKK7XYZKK7XYZ K", { ear: { lenient: true, saved: "KK7XYZ" } });
    expect(t.qso.you).toBe("KK7XYZ");
  });

  it("knows a call one character off", () => {
    expect(nearly("K4ABC", "K4ABC")).toBe(true);
    expect(nearly("K4ABC", "K4ABD")).toBe(true);
    expect(nearly("K4ABC", "K4AB")).toBe(true);
    expect(nearly("K4ABC", "K44ABC")).toBe(true);
    expect(nearly("K4ABC", "K4AXD")).toBe(false);
    expect(nearly("K4ABC", "K4A")).toBe(false);
  });

  it("never sends your own call as its own", () => {
    const rand = seeded(7);
    for (let i = 0; i < 200; i++) {
      const s = randomStation(rand, "W7YFR");
      expect(s.call).not.toBe("W7YFR");
      expect(isCall(s.call)).toBe(true);
    }
  });
});

describe("QRS and QRQ steps", () => {
  const at = (charWpm: number, farnsworthWpm: number) => ({ charWpm, farnsworthWpm });

  it("steps the effective speed down and keeps the character speed", () => {
    expect(slower(at(25, 16))).toEqual(at(25, 15));
    expect(slower(at(25, 15))).toEqual(at(25, 14));
    expect(slower(at(25, 10))).toEqual(at(25, 9));
    expect(slower(at(25, 6))).toEqual(at(25, 6));
  });

  it("steps the effective speed up to the character speed", () => {
    expect(faster(at(25, 16))).toEqual(at(25, 18));
    expect(faster(at(25, 24))).toEqual(at(25, 25));
  });

  it("raises both when they are equal", () => {
    expect(faster(at(25, 25))).toEqual(at(26, 26));
    expect(faster(at(20, 20))).toEqual(at(22, 22));
    expect(faster(at(28, 28))).toEqual(at(30, 30));
    expect(faster(at(38, 38))).toEqual(at(40, 40));
    expect(faster(at(40, 40))).toEqual(at(40, 40));
  });

  it("walks every step from the bottom to the top", () => {
    let s = at(40, 6);
    const seen = [s.farnsworthWpm];
    while (s.farnsworthWpm < 40) {
      s = faster(s);
      seen.push(s.farnsworthWpm);
    }
    expect(seen).toEqual([...STEPS]);
  });

  it("sets the effective speed to a number asked for", () => {
    expect(setTo(at(25, 16), 12)).toEqual(at(25, 12));
    expect(setTo(at(25, 16), 30)).toEqual(at(30, 30));
    expect(setTo(at(25, 16), 1)).toEqual(at(25, 5));
  });
});

describe("QRS and QRQ in a QSO", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  /** A QSO the station has answered, at 25/16. */
  const called = (): Qso =>
    answer(newQso(seeded(), "", { charWpm: 25, farnsworthWpm: 16 }), "CQ DE W7YFR K", FIRST).qso;

  it("searches for your speed across several requests", () => {
    let q = called();
    const speeds: number[] = [];
    for (const over of ["QRS K", "QRQ K", "QRS K"]) {
      q = answer(q, over, FIRST).qso;
      speeds.push(q.speed.farnsworthWpm);
    }
    // 16, then halfway down to the bottom, back up, and down again.
    expect(speeds).toEqual([10, 12, 10]);
  });

  it("sends its last over again, slower, on QRS", () => {
    for (const over of ["QRS", "PSE QRS K", "QRS?", "QRS PSE KN"]) {
      const q = called();
      const t = answer(q, over, FIRST);
      expect(t.reply).toBe(q.last);
      expect(t.qso.speed).toEqual({ charWpm: 25, farnsworthWpm: 10 });
      expect(t.qso.stage).toBe("called");
    }
  });

  it("holds the new speed for the rest of the QSO", () => {
    let q = answer(called(), "QRS K", FIRST).qso;
    q = answer(q, `${q.them.call} DE W7YFR UR 599 KN`, FIRST).qso;
    expect(q.stage).toBe("exchanged");
    expect(q.speed).toEqual({ charWpm: 25, farnsworthWpm: 10 });
  });

  it("goes to the speed asked for with a number", () => {
    const t = answer(called(), "QRS 10 K", FIRST);
    expect(t.qso.speed).toEqual({ charWpm: 25, farnsworthWpm: 10 });
    expect(answer(called(), "QRQ 20WPM K", FIRST).qso.speed).toEqual({ charWpm: 25, farnsworthWpm: 20 });
  });

  it("sends its last over again, faster, on QRQ alone", () => {
    const q = called();
    const t = answer(q, "PSE QRQ K", FIRST);
    expect(t.reply).toBe(q.last);
    expect(t.qso.speed).toEqual({ charWpm: 25, farnsworthWpm: 20 });
  });

  it("answers the rest of an over with QRQ in it, faster", () => {
    const q = called();
    const t = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB QRQ? KN`, FIRST);
    expect(t.qso.stage).toBe("exchanged");
    expect(t.reply).not.toBe(q.last);
    expect(t.qso.speed).toEqual({ charWpm: 25, farnsworthWpm: 20 });
  });

  it("does nothing with QRS before it has sent anything", () => {
    const q = newQso(seeded());
    expect(answer(q, "QRS K", FIRST).reply).toBeNull();
  });

  it("starts each new QSO at the speed it is given", () => {
    expect(newQso(seeded(), "", { charWpm: 20, farnsworthWpm: 12 }).speed).toEqual({
      charWpm: 20,
      farnsworthWpm: 12,
    });
  });
});

describe("reply length", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const start = (): Qso => newQso(seeded());

  it("sends each item once, when short", () => {
    const ctx: Context = { ...FIRST, length: "short" };
    const q = answer(start(), "CQ DE W7YFR K", ctx).qso;
    const { call: c, rst, name, qth } = q.them;
    expect(q.last).toBe(`DE ${c} K`);
    const r = rst === "599" ? "5NN" : rst;
    expect(answer(q, `${c} DE W7YFR UR 599 KN`, ctx).reply).toBe(
      `W7YFR DE ${c} R TNX FER RPT UR ${r} NAME ${name} QTH ${qth} HW? KN`,
    );
  });

  it("sends report, name and QTH one per over, piece by piece", () => {
    const ctx: Context = { ...FIRST, length: "pieces" };
    let q = answer(start(), "CQ DE W7YFR K", ctx).qso;
    const { call: c, rst, name, qth } = q.them;
    const r = rst === "599" ? "5NN" : rst;

    let t = answer(q, `${c} DE W7YFR UR 579 579 KN`, ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} R TNX FER RPT GE OM UR RST ${r} ${r} KN`);
    expect(t.qso.stage).toBe("pieces");
    q = t.qso;

    // A piece of yours gets an R first.
    t = answer(q, "R R UR 579 KN", ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} R NAME ${name} ${name} KN`);
    q = t.qso;

    // Your name is still owed: it asks for it, and does not move on.
    t = answer(q, "FB KN", ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} UR NAME? KN`);
    expect(t.qso.piece).toBe(q.piece);
    t = answer(t.qso, "NAME BOB BOB KN", ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} R QTH ${qth} ${qth} HW? KN`);
    q = t.qso;

    // Your QTH back settles the last piece, and it signs.
    t = answer(q, "QTH SALEM OR KN", ctx);
    expect(t.qso.stage).toBe("signing");
  });

  it("sends the same piece again on AGN, and takes your name in any piece", () => {
    const ctx: Context = { ...FIRST, length: "pieces" };
    let q = answer(start(), "CQ DE W7YFR K", ctx).qso;
    const c = q.them.call;
    const first = answer(q, `${c} DE W7YFR UR 579 KN`, ctx);
    q = first.qso;
    expect(answer(q, "AGN KN", ctx).reply).toBe(first.reply);
    const t = answer(q, "NAME BOB BOB KN", ctx);
    expect(t.qso.yourName).toBe("BOB");
    expect(t.reply).toMatch(/^W7YFR DE \S+ R NAME /);
  });

  it("opens a piece with both calls by its habit, and more often when you did", () => {
    const ctx: Context = { ...FIRST, length: "pieces" };
    let q = answer(start(), "CQ DE W7YFR K", ctx).qso;
    const c = q.them.call;
    // A station that never opens with the calls by habit.
    q = { ...q, them: { ...q.them, habit: 0 } };
    q = answer(q, "UR 579 KN", ctx).qso;
    expect(q.stage).toBe("pieces");
    expect(q.last).not.toContain(" DE ");
    const plain = answer(q, "R NAME BOB KN", ctx).reply!;
    expect(plain).not.toContain(" DE ");
    const mirrored = answer(q, `${c} DE W7YFR R NAME BOB KN`, ctx).reply!;
    expect(mirrored).toMatch(new RegExp(`^W7YFR DE ${c} `));
  });

  it("signs off when you send 73 between pieces", () => {
    const ctx: Context = { ...FIRST, length: "pieces" };
    let q = answer(start(), "CQ DE W7YFR K", ctx).qso;
    q = answer(q, `${q.them.call} DE W7YFR UR 579 KN`, ctx).qso;
    expect(answer(q, "TNX 73 <SK>", ctx).ended).toBe(true);
  });
});

describe("questions about one thing", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  /** A QSO where the station has sent its exchange. */
  const exchanged = (): Qso => {
    const q = answer(newQso(seeded()), "CQ DE W7YFR K", FIRST).qso;
    return answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`, FIRST).qso;
  };

  it("sends its call for part of it with a ?", () => {
    const q = answer(newQso(seeded()), "CQ DE W7YFR K", FIRST).qso;
    const c = q.them.call;
    for (const over of [`${c.slice(0, 3)}?`, `${c.slice(0, 3)} ? K`, `${c.slice(-3)}? KN`]) {
      const t = answer(q, over, FIRST);
      expect(t.reply).toBe(`${c} ${c} K`);
      expect(t.qso.stage).toBe("called");
    }
  });

  it("sends just its name, QTH or report when asked", () => {
    const q = exchanged();
    const { name, qth, rst } = q.them;
    expect(answer(q, "NAME? KN", FIRST).reply).toBe(`NAME ${name} ${name} K`);
    expect(answer(q, "QTH? KN", FIRST).reply).toBe(`QTH ${qth} ${qth} K`);
    const r = rst === "599" ? "5NN" : rst;
    expect(answer(q, "RST? KN", FIRST).reply).toBe(`UR RST ${r} ${r} K`);
    expect(answer(q, "NAME? QTH? KN", FIRST).reply).toBe(`NAME ${name} ${name} QTH ${qth} ${qth} K`);
  });

  it("does not move the QSO on alone, and AGN after it gets the answer again", () => {
    const q = exchanged();
    const t = answer(q, "NAME? KN", FIRST);
    expect(t.qso.stage).toBe("exchanged");
    expect(answer(t.qso, "AGN KN", FIRST).reply).toBe(t.reply);
    expect(answer(t.qso, "QRS KN", FIRST).reply).toBe(t.reply);
  });

  it("confirms its QTH, name or report sent back with a ?", () => {
    const q = exchanged();
    const { name, qth, rst } = q.them;
    for (const [over, item] of [
      [`${qth} ? KN`, qth],
      [`${qth}? KN`, qth],
      [`${name}? KN`, name],
      [`${rst} ? KN`, rst],
    ] as const) {
      const t = answer(q, over, FIRST);
      expect(t.reply).toBe(`R R ${item} K`);
      expect(t.qso.stage).toBe("exchanged");
    }
  });

  it("does not move on for a check, even with an acknowledgement", () => {
    const q = exchanged();
    const t = answer(q, `R ${q.them.qth} ? KN`, FIRST);
    expect(t.reply).toBe(`R R ${q.them.qth} K`);
    expect(t.qso.stage).toBe("exchanged");
  });

  it("answers and sends its next piece when the over goes on", () => {
    const ctx: Context = { ...FIRST, length: "pieces" };
    let q = answer(newQso(seeded()), "CQ DE W7YFR K", ctx).qso;
    const { call: c, name, qth } = q.them;
    q = answer(q, `${c} DE W7YFR UR 599 KN`, ctx).qso;
    const t = answer(q, "TU FER RPT QTH IS SEATTLE QTH? KN", ctx);
    expect(t.reply).toBe(`QTH ${qth} ${qth} <BT> W7YFR DE ${c} R NAME ${name} ${name} KN`);
    expect(answer(t.qso, "AGN KN", ctx).reply).toBe(t.reply);
    // It still waits for your name, so it asks for it with each answer.
    expect(answer(t.qso, `${qth} ? KN`, ctx).reply).toBe(`R R ${qth} <BT> UR NAME? KN`);
    expect(answer(t.qso, "QTH? KN", ctx).reply).toBe(`QTH ${qth} ${qth} <BT> UR NAME? KN`);
    // Its QTH went with the answer, so your name settles the last piece.
    expect(answer(t.qso, "NAME BOB KN", ctx).qso.stage).toBe("signing");
  });

  it("answers and signs when the over goes on after its exchange", () => {
    const q = exchanged();
    const t = answer(q, "R TU QTH? KN", FIRST);
    expect(t.reply).toMatch(new RegExp(`^QTH ${q.them.qth} ${q.them.qth} <BT> `));
    expect(t.qso.stage).toBe("signing");
  });

  it("takes HW? as part of an exchange, not a question", () => {
    const q = exchanged();
    expect(answer(q, "FB HW? KN", FIRST).qso.stage).toBe("signing");
  });
});

describe("showing an over", () => {
  it("reveals the characters sent so far, with the spaces between", () => {
    const text = "W7YFR DE K4ABC <SK>";
    expect(revealed(text, 0)).toBe("");
    expect(revealed(text, 3)).toBe("W7Y");
    expect(revealed(text, 5)).toBe("W7YFR");
    expect(revealed(text, 6)).toBe("W7YFR D");
    expect(revealed(text, 13)).toBe("W7YFR DE K4ABC <SK>");
    expect(revealed(text, 99)).toBe(text);
  });

  /** Marks as a string: + right, x wrong, _ unmarked. */
  const pattern = (marks: readonly { ok: boolean | null }[]) =>
    marks.map((m) => (m.ok === null ? "_" : m.ok ? "+" : "x")).join("");

  it("grades a copy character by character, both ways", () => {
    const g = gradeCopy("UR RST 579", "ur rst 589");
    expect(g.total).toBe(8);
    expect(g.right).toBe(7);
    expect(pattern(g.yours)).toBe("++_+++_+x+");
    expect(pattern(g.sent)).toBe("++_+++_+x+");
  });

  it("finds what you copied past a part you missed", () => {
    // The station's line, and a copy with its middle left out.
    const sent = "W7YFR DE N1AK GE OM UR RST IS 479 479 KN";
    const g = gradeCopy(sent, "W7YFR DE N1AK ... 479 479 KN");
    // Every character you typed is right, and the gap is not graded.
    expect(pattern(g.yours)).toBe("+++++_++_++++_..._+++_+++_++".replace("...", "_"));
    // What you left out is missed; the calls and the reports are copied.
    const missed = g.sent.filter((m) => m.ok === false).map((m) => m.text).join("");
    expect(missed).toBe("GEOMURRSTIS");
    expect(g.right).toBe(g.total - missed.length);
  });

  it("finds what you copied past a mistake", () => {
    const g = gradeCopy("NAME JIM QTH ATLANTA GA", "NAME JIN QTH ATLANTA GA");
    expect(g.yours.filter((m) => m.ok === false).map((m) => m.text)).toEqual(["N"]);
    expect(g.sent.filter((m) => m.ok === false).map((m) => m.text)).toEqual(["M"]);
  });

  it("lines a character up with the one sent next to it, past a gap", () => {
    const sent = "W7YFR DE K1NO R R TNX FER RPT GM OM RST 569 569 BK";
    const g = gradeCopy(sent, "W7YFR DE K1NO R R TNX FER ... RST 569 569 BK");
    // The R of FER is right; what the gap stands for is missed.
    const missed = g.sent.filter((m) => m.ok === false).map((m) => m.text).join("");
    expect(missed).toBe("RPTGMOM");
    expect(g.right).toBe(30);
    expect(g.total).toBe(37);
  });

  it("sets your copy over the station's line, column by column", () => {
    const g = gradeCopy("W7YFR DE K1NO FB OM NAME HR AL AL BK", "W7YFR DE K1NO ... HR AL AL BK");
    /** A row as drawn: each column as wide as its wider side. */
    const draw = (side: "yours" | "sent") =>
      g.columns
        .map((c) => {
          const w = Math.max(...[c.yours, c.sent].map((ms) => ms.map((m) => m.text).join("").length));
          return c[side].map((m) => m.text).join("").padEnd(w);
        })
        .join("");
    const yours = draw("yours");
    const sent = draw("sent");
    expect(yours.indexOf("HR AL AL BK")).toBe(sent.indexOf("HR AL AL BK"));
    expect(yours.indexOf("...")).toBe(sent.indexOf("FB"));
  });

  it("marks what you did not copy missed, and nothing as yours", () => {
    const g = gradeCopy("NAME BOB", "NAME");
    expect(g.right).toBe(4);
    expect(g.sent.filter((m) => m.ok === false).map((m) => m.text).join("")).toBe("BOB");
    expect(gradeCopy("NAME BOB", "").right).toBe(0);
    expect(gradeCopy("NAME BOB", "").yours).toEqual([]);
  });
});

describe("the station moves on only once the current part is settled", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const LENIENT: Context = { ...FIRST, ear: { lenient: true, saved: "" } };
  const called = (ctx: Context): Qso => answer(newQso(seeded()), "CQ DE W7YFR K", ctx).qso;

  it("asks for your report before it moves past its own", () => {
    // The QSO from the screenshot, piece by piece.
    const ctx: Context = { ...LENIENT, length: "pieces" };
    let q = called(ctx);
    const c = q.them.call;
    q = answer(q, `${c} DEW7YFR TU FER QH EEEQSO QEEEEEEE TU FERCALL`, ctx).qso;
    expect(q.stage).toBe("pieces");
    const t = answer(q, "KRR KRR", ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} UR RST? KN`);
    expect(t.qso.piece).toBe(1);
    expect(answer(t.qso, "R UR 579 579 KN", ctx).reply).toMatch(/ NAME /);
  });

  it("sends the current piece again for a question it cannot place", () => {
    // The over from the second screenshot: a garbled NAME IS WHAT?.
    const ctx: Context = { ...LENIENT, length: "pieces" };
    let q = called(ctx);
    q = answer(q, `${q.them.call} DE W7YFR UR 579 KN`, ctx).qso;
    q = answer(q, "R UR 579 KN", ctx).qso;
    expect(q.last).toMatch(/ NAME /);
    expect(answer(q, "NA E ISWHAT?", ctx).reply).toBe(q.last);
  });

  it("asks for every piece it gave and did not get back, in full", () => {
    let q = called(FIRST);
    q = answer(q, `${q.them.call} DE W7YFR UR 599 KN`, FIRST).qso;
    const t = answer(q, "FB TNX KN", FIRST);
    expect(t.reply).toBe(`W7YFR DE ${q.them.call} PSE UR NAME ES QTH? KN`);
    expect(t.qso.stage).toBe("exchanged");
  });

  it("asks you to send again an over it cannot read", () => {
    let q = called(FIRST);
    q = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`, FIRST).qso;
    expect(answer(q, "XQZ JJV PTY", FIRST).reply).toBe(`PSE AGN W7YFR DE ${q.them.call} KN`);
    // Your rig and the weather are an over it can read.
    expect(answer(q, "RIG HR IS IC7300 ES ANT IS DIPOLE WX SUNNY", FIRST).qso.stage).toBe("signing");
  });
});

describe("error runs", () => {
  it("takes a run of dits as one error sign", () => {
    expect(erased(wordsOf("NAME BOP EEE E E BOB"))).toEqual(["NAME", "BOB"]);
    expect(erased(wordsOf("QTH SALEN I I I SALEM"))).toEqual(["QTH", "SALEM"]);
  });

  it("splits an error sign keyed against a word", () => {
    expect(erased(wordsOf("TU FER QH EEEQSO"))).toEqual(["TU", "FER", "QSO"]);
    expect(erased(wordsOf("QSO QEEEEEEE TU"))).toEqual(["QSO", "TU"]);
  });

  it("keeps a short run, and words of dits alone", () => {
    expect(erased(wordsOf("73 <SK> E E"))).toEqual(["73", "<SK>", "E", "E"]);
    expect(erased(wordsOf("NAME IS BOB ES QTH"))).toEqual(["NAME", "IS", "BOB", "ES", "QTH"]);
    expect(erased(wordsOf("HI HI"))).toEqual(["HI", "HI"]);
  });
});

describe("QRS and QRQ search for your speed", () => {
  const at = (charWpm: number, farnsworthWpm: number): Speed => ({ charWpm, farnsworthWpm });
  /** The effective speeds a run of requests lands on, from `start`. */
  const walk = (start: Speed, asks: string): number[] => {
    let speed = start;
    let search = NO_SEARCH;
    const out: number[] = [];
    for (const ask of asks) {
      ({ speed, search } = ask === "S" ? qrs(speed, search) : qrq(speed, search));
      out.push(speed.farnsworthWpm);
    }
    return out;
  };

  it("drops halfway to the bottom on the first QRS", () => {
    expect(walk(at(20, 20), "S")).toEqual([12]);
    expect(walk(at(30, 30), "S")).toEqual([18]);
    expect(walk(at(25, 16), "S")).toEqual([10]);
  });

  it("closes in from both sides", () => {
    // From 20: too fast. 12: too slow. 15: too fast. 14 is all that is left.
    expect(walk(at(20, 20), "SQSS")).toEqual([12, 15, 14, 12]);
    expect(walk(at(30, 30), "SQQ")).toEqual([18, 24, 26]);
  });

  it("moves at least one step when nothing is left between", () => {
    expect(walk(at(20, 15), "QS")).toEqual([18, 15]);
    // 12 too slow, 14 too fast: no step between, so QRS goes one step down
    // to 12 and forgets 12 was too slow. The next QRS searches below it.
    expect(walk(at(20, 20), "SQSSS")).toEqual([12, 15, 14, 12, 8]);
  });

  it("goes up halfway to the character speed, then raises both", () => {
    expect(walk(at(25, 16), "Q")).toEqual([20]);
    expect(walk(at(25, 24), "QQ")).toEqual([25, 26]);
    expect(qrq(at(25, 25), NO_SEARCH).speed).toEqual(at(26, 26));
  });

  it("stays at the bottom and top steps", () => {
    expect(walk(at(20, 6), "S")).toEqual([6]);
    expect(qrq(at(40, 40), NO_SEARCH).speed).toEqual(at(40, 40));
  });
});

describe("a piece begun that did not come through", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const LENIENT: Context = { ...FIRST, ear: { lenient: true, saved: "" } };

  it("takes your call past a fragment left by a mistake", () => {
    // The CQ from the screenshot.
    const t = answer(newQso(seeded()), "CQ CQ CQ DE W 7YU EIEEEEEEI W7YFR W7YFR K", LENIENT);
    expect(t.qso.you).toBe("W7YFR");
  });

  it("asks for a report it cannot read, and waits for it", () => {
    const ctx: Context = { ...LENIENT, length: "pieces" };
    let q = answer(newQso(seeded()), "CQ DE W7YFR K", ctx).qso;
    const c = q.them.call;
    // The over from the screenshot.
    let t = answer(q, `K RR ${c} TU FER CALL <BT> UR RST IS 4 4 B 44 B K`, ctx);
    expect(t.reply).toBe(`W7YFR DE ${c} UR RST? KN`);
    expect(t.qso.stage).toBe("called");
    q = t.qso;

    // The report again, without its call: now it goes on.
    t = answer(q, "UR RST 579 579 K", ctx);
    expect(t.qso.stage).toBe("pieces");
    expect(t.reply).toContain("R TNX FER RPT");
  });

  it("asks for a name or a QTH begun and not finished", () => {
    let q = answer(newQso(seeded()), "CQ DE W7YFR K", FIRST).qso;
    const c = q.them.call;
    expect(answer(q, `${c} DE W7YFR UR 579 NAME ▯▯ KN`, FIRST).reply).toBe(
      `W7YFR DE ${c} UR NAME? KN`,
    );
    expect(answer(q, `${c} DE W7YFR UR 579 NAME BOB QTH KN`, FIRST).reply).toBe(
      `W7YFR DE ${c} UR QTH? KN`,
    );
  });

  it("asks you to send again an over it cannot read, while it waits", () => {
    let q = answer(newQso(seeded()), "CQ DE W7YFR K", FIRST).qso;
    q = answer(q, `${q.them.call} DE W7YFR UR RST 4B KN`, FIRST).qso;
    expect(answer(q, "XQZ JJV", FIRST).reply).toBe(`PSE AGN W7YFR DE ${q.them.call} KN`);
  });
});

describe("its call sent wrong", () => {
  const LENIENT: Context = { rand: () => 0, hour: 20, ear: { lenient: true, saved: "" } };

  it("puts its call right before it goes on", () => {
    // The QSO from the screenshot: K7SP sent for K7SJ.
    const ctx: Context = { ...LENIENT, length: "pieces" };
    const q = answer(newQso(seeded()), "CQ DE W7YFR W7YFR K", ctx).qso;
    const c = q.them.call;
    const wrong = `${c.slice(0, -1)}${c.endsWith("P") ? "Q" : "P"}`;
    const t = answer(q, `K ${wrong} TU FER CALL UR 5NN 5NN K`, ctx);
    expect(t.reply).toBe(`MY CALL ${c} ${c} K`);
    expect(t.qso.stage).toBe("called");
    expect(t.qso.got).toEqual(["report"]);
    // The right call: it goes on, and your report already counts.
    const next = answer(t.qso, `R ${c} DE W7YFR K`, ctx);
    expect(next.qso.stage).toBe("pieces");
    expect(next.reply).toContain("TNX FER RPT");
  });

  it("confirms the right call when you ask about the wrong one", () => {
    const q = answer(newQso(seeded()), "CQ DE W7YFR K", LENIENT).qso;
    const c = q.them.call;
    const wrong = `${c.slice(0, -1)}${c.endsWith("P") ? "Q" : "P"}`;
    expect(answer(q, `${wrong}?`, LENIENT).reply).toBe(`R R DE ${c} ${c} K`);
  });
});

describe("HW ? with the ? keyed apart", () => {
  it("takes it as HW?, not AGN", () => {
    // The over from the screenshot, after the station asked for a report.
    const ctx: Context = { rand: () => 0, hour: 20, ear: { lenient: true, saved: "" }, length: "pieces" };
    let q = answer(newQso(seeded()), "CQ DE W7YFR K", ctx).qso;
    const c = q.them.call;
    q = answer(q, `${c} DE W7YFR TU FER CALL OP IS ROB ROB K`, ctx).qso;
    q = answer(q, "HI", ctx).qso;
    const t = answer(q, `W3QD EEE ${c} UR RST IS 4 NN 4NN <BT> HW ? K`, ctx);
    expect(t.reply).toMatch(/ NAME /);
  });
});

describe("your sign-off", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const LENIENT: Context = { ...FIRST, ear: { lenient: true, saved: "" } };
  /** A QSO with both exchanges done. */
  const exchanged = (ctx: Context): Qso => {
    const q = answer(newQso(seeded()), "CQ DE W7YFR K", ctx).qso;
    return answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`, ctx).qso;
  };

  it("takes the words the station signs off with", () => {
    for (const over of ["TNX FER QSO", "TNX FB QSO", "CU AGN", "CUL", "GL ES BCNU", "73", "TU <SK>"]) {
      expect(answer(exchanged(FIRST), over, FIRST).ended, over).toBe(true);
    }
  });

  it("does not take TU alone, or QSO alone", () => {
    for (const over of ["TU", "FB QSL TU", "NICE QSO"]) {
      expect(answer(exchanged(FIRST), over, FIRST).ended, over).toBe(false);
    }
  });

  it("finds a sign-off run together, when lenient", () => {
    expect(answer(exchanged(FIRST), "TNXFERQSO", FIRST).ended).toBe(false);
    expect(answer(exchanged(LENIENT), "TNXFERQSO", LENIENT).ended).toBe(true);
    expect(answer(exchanged(LENIENT), "HPECUAGN", LENIENT).ended).toBe(true);
  });
});

describe("QRQ and QRS past the last step", () => {
  const FIRST: Context = { rand: () => 0, hour: 20 };
  const at = (charWpm: number, farnsworthWpm: number) =>
    answer(newQso(seeded(), "", { charWpm, farnsworthWpm }), "CQ DE W7YFR K", FIRST).qso;

  it("says it cannot go faster at the top step", () => {
    const t = answer(at(40, 40), "QRQ K", FIRST);
    expect(t.reply).toBe("SRI NO QRQ K");
    expect(t.qso.speed).toEqual({ charWpm: 40, farnsworthWpm: 40 });
  });

  it("says it cannot go slower at the bottom step", () => {
    expect(answer(at(20, 6), "QRS K", FIRST).reply).toBe("SRI NO QRS K");
  });

  it("goes on with the rest of an over with QRQ in it", () => {
    const q = at(40, 40);
    expect(answer(q, `${q.them.call} DE W7YFR UR 599 QRQ KN`, FIRST).qso.stage).toBe("exchanged");
  });
});

describe("copying an over through a calibration", () => {
  it("corrects the edges, and reads the over the same", () => {
    // A microphone path that holds each mark 8 ms long, and the profile that
    // takes it back off.
    const timing = targetTiming(25);
    const text = "CQ DE W7YFR K";
    const clean = synthesize(text, timing, { rate: 48000, padSec: 0.3 }).samples;
    const tail = new Float32Array(clean.length + 48000 * 3);
    tail.set(clean);
    const read = (calibration?: Calibration) => {
      const copy = new LiveCopy(48000, timing, false, calibration);
      for (let k = 0; k < tail.length; k += 128) copy.push(tail.subarray(k, k + 128));
      return copy.step();
    };
    const cal: Calibration = { wpm: 25, releaseOffsetSec: 0.008, spreadSec: 0.001, elements: 40 };
    expect(read().text).toBe(text);
    const corrected = read(cal);
    expect(corrected.text).toBe(text);
    expect(corrected.over).toBe(true);

    // The correction is applied: each mark comes out 8 ms shorter.
    const marks = (calibration?: Calibration) =>
      sentSymbols(tail, 48000, timing, undefined, false, calibration)
        .segments.filter((g) => g[0] === 1)
        .map((g) => g[1]);
    const plain = marks();
    const fixed = marks(cal);
    expect(fixed).toHaveLength(plain.length);
    for (let i = 0; i < plain.length; i++) expect(plain[i]! - fixed[i]!).toBeCloseTo(0.008, 3);
  });
});

describe("the help's example QSO", () => {
  it("goes straight through to the station's 73, as the script answers it", () => {
    const [ex] = examples();
    const lines = ex!.lines;
    expect(lines.map((l) => l.you)).toEqual([true, false, true, false, true, false]);
    expect(lines[0]!.text).toBe("CQ CQ DE KD9XYZ K");
    expect(lines[1]!.text).toBe("DE K4ABC K");
    expect(lines[2]!.text).toBe("K4ABC DE KD9XYZ UR 579 NAME TOM QTH OMAHA NE K");
    expect(lines[3]!.text).toBe("KD9XYZ DE K4ABC R TNX FER RPT UR 5NN NAME JIM QTH ATLANTA GA HW? KN");
    expect(lines[5]!.text).toBe("TU 73 E E");
  });
});


describe("working the station without its call", () => {
  const LENIENT: Context = { rand: () => 0, hour: 20, ear: { lenient: true, saved: "" } };
  const called = (): Qso => answer(newQso(seeded()), "CQ CQ CQ DE W7YFR K", LENIENT).qso;

  it("goes on with your report after confirming its call", () => {
    // The QSO from the screenshot: its call asked about and confirmed, then
    // your report with no call in it.
    let q = called();
    const c = q.them.call;
    q = answer(q, "AGN?", LENIENT).qso;
    const confirmed = answer(q, `${c}?`, LENIENT);
    expect(confirmed.reply).toBe(`R R DE ${c} ${c} K`);
    const t = answer(confirmed.qso, "K GE OM TU FER CALL UR RST IS 5NN 5NN K", LENIENT);
    expect(t.qso.stage).toBe("exchanged");
    expect(t.reply).toContain("R TNX FER RPT");
  });

  it("goes on with your report even unasked, when no other station is named", () => {
    const t = answer(called(), "GE OM UR RST 579 579 NAME BOB K", LENIENT);
    expect(t.qso.stage).toBe("exchanged");
  });

  it("does not take an over named to another station as its own", () => {
    const q = called();
    const t = answer(q, "N9ZZZ DE W7YFR UR 579 K", LENIENT);
    expect(t.qso.stage).toBe("called");
    expect(t.reply).toBe(`DE ${q.them.call} ${q.them.call} K`);
  });
});
