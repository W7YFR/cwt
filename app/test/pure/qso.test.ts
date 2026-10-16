/* The QSO page's two halves: copying an over with no message to follow, and
 * the script that answers it. */

import { describe, expect, it } from "vitest";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { LiveCopy, overEnded } from "@/timing/live";
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
  it("reads the words with spaces between them", () => {
    const last = copyOf("CQ CQ DE W7YFR K", 20, 2).at(-1)!;
    expect(last.text).toBe("CQ CQ DE W7YFR K");
  });

  it("ends the over a moment after K", () => {
    const readings = copyOf("CQ DE W7YFR K", 20, 2);
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
      expect(overEnded(`W7YFR DE K4ABC ${end}`, 1.5, timing)).toBe(true);
    }
    // A misread character before a ? is not a question.
    expect(overEnded("K4ABC UR 5NN 5?", 1.5, timing)).toBe(false);
    expect(overEnded("W7YFR DE AA7K", 1.5, timing)).toBe(false);
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
    q = answer(q, `${q.them.call} DE W7YFR UR 599 NAME BOB KN`).qso;
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
    // One character dropped from their call.
    const off = them.slice(0, -1);
    expect(answer(t.qso, `${off} DE W7YFR UR 599 KN`).qso.stage).toBe("called");
    expect(answer(t.qso, `${off} DE W7YFR UR 599 KN`, LENIENT).qso.stage).toBe("exchanged");
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
