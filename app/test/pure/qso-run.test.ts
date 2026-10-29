/* Runs: CWT, SST, MST and POTA, one station after another. */

import { describe, expect, it } from "vitest";
import { FORMATS } from "@/qso/formats";
import { answerRun, callIn, following, isRun, newRun, respond, unglued, type RunContext, type RunQso } from "@/qso/run";
import { newQso } from "@/qso/cq";
import type { Station } from "@/qso/station";
import { EXAMPLE_YOU, example, exampleYou } from "@/qso/examples";

/** Every pick the first, and every part that may be left out kept. */
const FIRST: RunContext = { rand: () => 0, hour: 20 };

/** A rand that moves on each time, for a new station: with rand always 0,
 *  every station has the same call, and none can differ from the last. */
function counting(): () => number {
  let n = 0;
  return () => (n++ % 97) / 97;
}

/** A context for a CQ that may bring a new station. */
const NEW: () => RunContext = () => ({ rand: counting(), hour: 20 });

const JIM: Station = {
  call: "K4ABC",
  name: "JIM",
  qth: "ATLANTA GA",
  rst: "599",
  toneHz: 600,
  nr: "2345",
  serial: 23,
};

/** A run of `format` with JIM, after JIM has called. */
function called(format: RunQso["format"], them: Station = JIM): RunQso {
  const qso = { ...newRun(format, () => 0), them, you: "KD9XYZ" };
  return callIn(qso, () => 0).qso as RunQso;
}

/** Send `overs` in turn, and return the station's replies. */
function work(qso: RunQso, overs: readonly string[], context: RunContext = FIRST) {
  const replies: (string | null)[] = [];
  let ended = false;
  for (const heard of overs) {
    const turn = answerRun(qso, heard, context);
    replies.push(turn.reply);
    qso = turn.qso as RunQso;
    ended = turn.ended;
  }
  return { replies, qso, ended };
}

describe("your CQ picks the format", () => {
  it("starts a run for each format's word, and the station calls", () => {
    for (const [id, f] of Object.entries(FORMATS)) {
      const turn = respond(newQso(() => 0), `CQ ${f.word} KD9XYZ`, NEW());
      expect(isRun(turn.qso) && turn.qso.format).toBe(id);
      expect(turn.qso.stage).toBe("called");
      expect(turn.reply).toBe(turn.qso.them.call);
      expect(turn.qso.you).toBe("KD9XYZ");
    }
  });

  it("keeps a plain CQ a rag chew", () => {
    const turn = respond(newQso(() => 0), "CQ CQ DE KD9XYZ K", FIRST);
    expect(isRun(turn.qso)).toBe(false);
  });

  it("goes back to a rag chew on a plain CQ between QSOs of a run", () => {
    const turn = respond(newRun("cwt", () => 0), "CQ CQ DE KD9XYZ K", NEW());
    expect(isRun(turn.qso)).toBe(false);
  });

  it("starts a new run when the CQ names another format", () => {
    const run = { ...newRun("cwt", () => 0), made: 4 };
    const turn = respond(run, "CQ SST KD9XYZ", NEW());
    expect(isRun(turn.qso) && [turn.qso.format, turn.qso.made]).toEqual(["sst", 0]);
  });

  it("keeps the run going on the same format's CQ", () => {
    const run = { ...newRun("cwt", () => 0), made: 4 };
    const turn = respond(run, "CQ CWT KD9XYZ", FIRST);
    expect(isRun(turn.qso) && turn.qso.made).toBe(4);
  });

  it("finds the word run into the CQ, with lenient copy", () => {
    const turn = respond(newQso(() => 0), "CQCWT KD9XYZ", { ...NEW(), ear: { lenient: true, saved: "" } });
    expect(isRun(turn.qso) && turn.qso.format).toBe("cwt");
  });
});

describe("a QSO in each format", () => {
  it("CWT: name and number each way, then your TU ends it", () => {
    const { replies, ended } = work(called("cwt"), ["K4ABC TOM 1234", "TU KD9XYZ"]);
    expect(replies).toEqual(["TU JIM 2345", null]);
    expect(ended).toBe(true);
  });

  it("CWT: your region in place of a number, and a station that is not a member", () => {
    const { replies } = work(called("cwt", { ...JIM, nr: "" }), ["K4ABC TOM OR"], { ...FIRST, region: "OR" });
    expect(replies).toEqual(["TU JIM GA"]);
  });

  it("SST: name and region, with a greeting and your name", () => {
    const { replies } = work(called("sst"), ["K4ABC TOM NE", "TU KD9XYZ"]);
    expect(replies).toEqual(["GE TOM JIM GA", "73"]);
  });

  it("MST: name and serial number", () => {
    const { replies } = work(called("mst"), ["K4ABC TOM 1", "TU KD9XYZ"]);
    expect(replies).toEqual(["TU JIM 23", null]);
  });

  it("POTA: a report and a region each way, and the hunter's dits", () => {
    const { replies } = work(called("pota"), ["K4ABC GE UR 5NN NE NE BK", "BK TU 73 EE"]);
    expect(replies).toEqual(["BK TU UR 5NN 5NN GA GA BK", "73 E E"]);
  });

  it("takes the station's name before yours as a greeting", () => {
    expect(work(called("sst"), ["K4ABC GE JIM TOM NE"]).replies).toEqual(["GE TOM JIM GA"]);
    expect(work(called("sst"), ["K4ABC JIM NE"]).replies).toEqual(["GE JIM JIM GA"]);
  });

  it("reads a number sent with cut letters", () => {
    const { replies } = work(called("mst"), ["K4ABC TOM 1T"]);
    expect(replies).toEqual(["TU JIM 23"]);
  });

  it("reads GA after your name or report as Georgia, not good afternoon", () => {
    expect(work(called("sst"), ["K4ABC TOM GA"]).qso.got?.region).toBe("GA");
    expect(work(called("sst"), ["GA JIM TOM GA"]).qso.got).toMatchObject({ name: "TOM", region: "GA" });
    expect(work(called("pota"), ["K4ABC UR 5NN GA GA BK"]).qso.got?.region).toBe("GA");
    expect(work(called("sst"), ["K4ABC TOM", "GA GA"]).qso.got?.region).toBe("GA");
  });

  it("reads a number shaped like a report or a 73, unless another comes with it", () => {
    expect(work(called("cwt"), ["K4ABC TOM 291"]).qso.got?.number).toBe("291");
    expect(work(called("cwt"), ["K4ABC TOM 73"]).qso.got?.number).toBe("73");
    expect(work(called("cwt"), ["K4ABC TOM 5NN 1234"]).qso.got?.number).toBe("1234");
    expect(work(called("mst"), ["K4ABC TOM", "155 155"]).qso.got?.number).toBe("155");
    expect(work(called("cwt"), ["K4ABC TOM 55"]).qso.got).toMatchObject({ name: "TOM", number: "55" });
  });

  it("takes a name a character off its call as a name", () => {
    const { qso, replies } = work(called("sst", { ...JIM, call: "W9LT" }), ["W9LT WALT OK"]);
    expect(qso.got).toMatchObject({ name: "WALT", region: "OK" });
    expect(replies[0]).toMatch(/WALT/);
  });

  it("takes your region from User as one, outside the list", () => {
    const { replies } = work(called("sst"), ["K4ABC TOM DL"], { ...FIRST, region: "DL" });
    expect(replies).toEqual(["GE TOM JIM GA"]);
  });
});

describe("the station asks again", () => {
  it("asks for the item missing from your exchange", () => {
    expect(work(called("cwt"), ["K4ABC TOM"]).replies).toEqual(["NR?"]);
    expect(work(called("sst"), ["K4ABC TOM"]).replies).toEqual(["QTH?"]);
    expect(work(called("mst"), ["K4ABC 12"]).replies).toEqual(["NAME?"]);
    expect(work(called("pota"), ["K4ABC 5NN"]).replies).toEqual(["QTH?"]);
  });

  it("keeps what you sent before, and does not ask for it again", () => {
    // The report keyed apart, then sent alone after RST?.
    expect(work(called("pota"), ["K4ABC UR 5 NN WA WA BK"]).replies).toEqual(["BK TU UR 5NN 5NN GA GA BK"]);
    expect(work(called("pota"), ["K4ABC WA WA BK", "5NN 5NN K"]).replies).toEqual([
      "RST?",
      "BK TU UR 5NN 5NN GA GA BK",
    ]);
    expect(work(called("pota"), ["K4ABC 5NN BK", "WA WA"]).replies).toEqual(["QTH?", "BK TU UR 5NN 5NN GA GA BK"]);
  });

  it("reads words run together with lenient copy, and not with strict", () => {
    const LENIENT: RunContext = { ...FIRST, ear: { lenient: true, saved: "" } };
    expect(work(called("pota"), ["K4ABC UR5NN WA WA BK"], LENIENT).replies).toEqual(["BK TU UR 5NN 5NN GA GA BK"]);
    expect(work(called("pota"), ["K4ABC UR 5NNWAWA BK"], LENIENT).replies).toEqual(["BK TU UR 5NN 5NN GA GA BK"]);
    expect(work(called("cwt"), ["K4ABC TOM1234"], LENIENT).replies).toEqual(["TU JIM 2345"]);
    expect(work(called("pota"), ["K4ABC UR5NN WA WA BK"]).replies).toEqual(["RST?"]);
  });

  it("puts a state keyed apart back together, with lenient copy", () => {
    const LENIENT: RunContext = { ...FIRST, ear: { lenient: true, saved: "" } };
    expect(work(called("sst"), ["K4ABC TOM W A"], LENIENT).replies).toEqual(["GE TOM JIM GA"]);
    expect(work(called("sst"), ["K4ABC TOM", "W A W A"], LENIENT).replies).toEqual(["QTH?", "GE TOM JIM GA"]);
    expect(work(called("sst"), ["K4ABC TOM W A"]).replies).toEqual(["QTH?"]);
  });

  it("leaves a call keyed apart out of the exchange, with lenient copy", () => {
    const LENIENT: RunContext = { ...FIRST, ear: { lenient: true, saved: "" } };
    // AK 3SD is the station's call, not a name or a state.
    const ak = { ...JIM, call: "AK3SD" };
    expect(work(called("sst", ak), ["AK 3SD RM EEE R OB WA"], LENIENT).replies).toEqual(["GE OB JIM GA"]);
    expect(work(called("sst"), ["K4 ABC TOM NE"], LENIENT).replies).toEqual(["GE TOM JIM GA"]);
  });

  it("puts its call right when sent a character off, and keeps your exchange", () => {
    const LENIENT: RunContext = { ...FIRST, ear: { lenient: true, saved: "" } };
    const n6 = { ...JIM, call: "N6MZA" };
    // A 6 keyed with a dit short is a B. Not your name: its call, sent wrong.
    for (const context of [FIRST, LENIENT]) {
      expect(work(called("sst", n6), ["NBMZA ROB WA", "N6MZA"], context).replies).toEqual([
        "N6MZA N6MZA",
        "GE ROB JIM GA",
      ]);
    }
  });

  it("parts only what was run together", () => {
    expect(unglued(["UR5NN", "5NNWA", "TOM1234", "WAWA", "K7YGJ", "1234", "5NN", "OR", "TOM"])).toEqual([
      "UR", "5NN", "5NN", "WA", "TOM", "1234", "WA", "WA", "K7YGJ", "1234", "5NN", "OR", "TOM",
    ]);
  });

  it("reads your answer to its question as that item", () => {
    // WA after QTH? is your region, not your name.
    expect(work(called("sst"), ["K4ABC TOM", "WA WA"]).replies).toEqual(["QTH?", "GE TOM JIM GA"]);
    expect(work(called("cwt"), ["K4ABC TOM", "1234 1234"]).replies).toEqual(["NR?", "TU JIM 2345"]);
  });

  it("asks for it all again when it can read none of it", () => {
    expect(work(called("cwt"), ["K4ABC"]).replies).toEqual(["AGN?"]);
  });

  it("sends its call again for AGN, for its call sent wrong, and for part of it with a ?", () => {
    expect(work(called("cwt"), ["AGN"]).replies).toEqual(["K4ABC"]);
    expect(work(called("cwt"), ["K4ABD TOM 1234"]).replies).toEqual(["K4ABC K4ABC"]);
    expect(work(called("cwt"), ["K4?"]).replies).toEqual(["K4ABC K4ABC"]);
  });

  it("takes your exchange without its call", () => {
    expect(work(called("cwt"), ["TOM 1234"]).replies).toEqual(["TU JIM 2345"]);
  });

  it("sends one item twice for NR?, NAME? or QTH?, and stays", () => {
    const { replies, ended } = work(called("cwt"), ["K4ABC TOM 1234", "NR?", "NAME ?", "TU KD9XYZ"]);
    expect(replies).toEqual(["TU JIM 2345", "2345 2345", "JIM JIM", null]);
    expect(ended).toBe(true);
  });

  it("sends its exchange again for AGN after it", () => {
    expect(work(called("mst"), ["K4ABC TOM 1", "AGN"]).replies).toEqual(["TU JIM 23", "TU JIM 23"]);
  });

  it("goes slower for QRS", () => {
    const { qso, replies } = work(called("cwt"), ["QRS"]);
    expect(replies).toEqual(["K4ABC"]);
    expect(qso.speed.farnsworthWpm).toBeLessThan(FORMATS.cwt.wpm[0]);
  });
});

describe("one station after another", () => {
  it("sends at the format's speed, not yours", () => {
    for (const f of Object.values(FORMATS)) {
      for (const r of [0, 0.5, 0.999]) {
        const { speed } = newRun(f.id, () => r);
        expect(speed.farnsworthWpm).toBeGreaterThanOrEqual(f.wpm[0]);
        expect(speed.farnsworthWpm).toBeLessThanOrEqual(f.wpm[1]);
        expect(speed.charWpm).toBe(speed.farnsworthWpm);
      }
    }
  });

  it("counts the QSOs, and the next station is a new one", () => {
    const done = work(called("mst"), ["K4ABC TOM 1", "TU KD9XYZ"]).qso;
    const next = following(done, () => 0.5);
    expect(isRun(next) && [next.format, next.made, next.stage, next.you]).toEqual(["mst", 1, "waiting", "KD9XYZ"]);
    expect(next.them.call).not.toBe("K4ABC");
  });

  it("calls the next station on anything you send between QSOs", () => {
    const turn = answerRun({ ...newRun("cwt", () => 0), them: JIM }, "TU KD9XYZ", FIRST);
    expect([turn.reply, turn.qso.stage]).toEqual(["K4ABC", "called"]);
  });
});

describe("the guide's examples", () => {
  const EMPTY = { callsign: "", name: "", qthCity: "", qthRegionShort: "", cwopsNumber: "" };

  it("goes through to the end for each format, as the script answers it", () => {
    expect(example("cwt").map((l) => l.text)).toEqual(["CQ CWT KD9XYZ", "K4ABC", "K4ABC TOM 1234", "TU JIM 2345", "TU KD9XYZ"]);
    expect(example("sst").map((l) => l.text)).toEqual(["CQ SST KD9XYZ", "K4ABC", "K4ABC TOM NE", "GE TOM JIM GA", "TU KD9XYZ", "73"]);
    expect(example("mst").map((l) => l.text)).toEqual(["CQ MST KD9XYZ", "K4ABC", "K4ABC TOM 1", "TU JIM 23", "TU KD9XYZ"]);
    expect(example("pota").map((l) => l.text)).toEqual([
      "CQ POTA DE KD9XYZ", "K4ABC", "K4ABC GE UR 5NN NE NE BK", "BK TU UR 5NN 5NN GA GA BK", "BK TU 73 EE", "73 E E",
    ]);
  });

  it("uses what you set in User, and the made-up operator for the rest", () => {
    expect(exampleYou(EMPTY)).toEqual(EXAMPLE_YOU);
    const you = exampleYou({ ...EMPTY, callsign: "W7YFR", qthRegionShort: "OR" });
    expect(you).toEqual({ call: "W7YFR", name: "TOM", qth: "OR", region: "OR", nr: "" });
    expect(example("cwt", you)[2]!.text).toBe("K4ABC TOM OR");
    expect(example("cwt", { ...you, nr: "3001" })[2]!.text).toBe("K4ABC TOM 3001");
    expect(example("cq", you)[0]!.text).toBe("CQ CQ DE W7YFR K");
  });
});
