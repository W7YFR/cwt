/* Example QSOs for the guide, worked by the script itself.
 *
 * Only your side is written here. The station's side is what the script says
 * to it, with every wording fixed to its first, so the guide can never show
 * the station saying something it would not say. A test works the same
 * examples.
 *
 * Your side uses your call, name, QTH and CWops number from User where you
 * have set them, and a made-up operator's where you have not.
 */

import { answer, newQso, type Qso } from "./cq";
import type { FormatId } from "./formats";
import { answerRun, newRun, type RunQso } from "./run";
import type { Station } from "./station";

export interface ExampleLine {
  /** Sent by you, or by the station. */
  readonly you: boolean;
  readonly text: string;
}

/** What the guide can show: a rag chew from a plain CQ, or a format. */
export type GuideId = "cq" | FormatId;

/** The order the guide offers them in. */
export const GUIDE_IDS: readonly GuideId[] = ["cq", "pota", "sst", "mst", "cwt"];

/** The station in the examples. */
export const EXAMPLE_STATION: Station = {
  call: "K4ABC",
  name: "JIM",
  qth: "ATLANTA GA",
  rst: "599",
  toneHz: 600,
  nr: "2345",
  serial: 23,
};

/** You, in the examples. */
export interface ExampleYou {
  readonly call: string;
  readonly name: string;
  /** City and region: OMAHA NE. */
  readonly qth: string;
  readonly region: string;
  /** Your CWops number, or empty. */
  readonly nr: string;
}

/** A made-up operator, for what User leaves empty. */
export const EXAMPLE_YOU: ExampleYou = { call: "KD9XYZ", name: "TOM", qth: "OMAHA NE", region: "NE", nr: "1234" };

/** You from User, each item filled in from the made-up operator where it is
 *  empty. With no CWops number but a region of your own, you send your
 *  region, as a station that is not a member does. */
export function exampleYou(user: {
  callsign: string;
  name: string;
  qthCity: string;
  qthRegionShort: string;
  cwopsNumber: string;
}): ExampleYou {
  const region = user.qthRegionShort.trim() || EXAMPLE_YOU.region;
  const city = user.qthCity.trim();
  return {
    call: user.callsign.trim() || EXAMPLE_YOU.call,
    name: user.name.trim() || EXAMPLE_YOU.name,
    qth: city ? `${city} ${region}` : user.qthRegionShort.trim() ? region : EXAMPLE_YOU.qth,
    region,
    nr: user.cwopsNumber.trim() || (user.qthRegionShort.trim() ? "" : EXAMPLE_YOU.nr),
  };
}

const FIXED = { rand: () => 0, hour: 20 } as const;

/** Work your side of a rag chew through the script, and return both sides. */
function chat(yours: readonly string[]): ExampleLine[] {
  let qso: Qso = { ...newQso(() => 0), them: EXAMPLE_STATION };
  const lines: ExampleLine[] = [];
  for (const text of yours) {
    lines.push({ you: true, text });
    const turn = answer(qso, text, { ...FIXED, length: "short" });
    if (turn.reply !== null) lines.push({ you: false, text: turn.reply });
    qso = turn.qso;
  }
  return lines;
}

/** Work your side of one QSO in a run through the script. */
function run(format: FormatId, you: ExampleYou, yours: readonly string[]): ExampleLine[] {
  let qso: RunQso = { ...newRun(format, () => 0), them: EXAMPLE_STATION };
  const lines: ExampleLine[] = [];
  for (const text of yours) {
    lines.push({ you: true, text });
    const turn = answerRun(qso, text, { ...FIXED, region: you.region });
    if (turn.reply !== null) lines.push({ you: false, text: turn.reply });
    qso = turn.qso as RunQso;
  }
  return lines;
}

/** One short QSO of `id`, start to finish. */
export function example(id: GuideId, you: ExampleYou = EXAMPLE_YOU): ExampleLine[] {
  const { call, name, qth, region, nr } = you;
  switch (id) {
    case "cq":
      return chat([`CQ CQ DE ${call} K`, `K4ABC DE ${call} UR 579 NAME ${name} QTH ${qth} K`, "TNX JIM 73 SK"]);
    case "cwt":
      return run(id, you, [`CQ CWT ${call}`, `K4ABC ${name} ${nr || region}`, `TU ${call}`]);
    case "sst":
      return run(id, you, [`CQ SST ${call}`, `K4ABC ${name} ${region}`, `TU ${call}`]);
    case "mst":
      return run(id, you, [`CQ MST ${call}`, `K4ABC ${name} 1`, `TU ${call}`]);
    case "pota":
      return run(id, you, [`CQ POTA DE ${call}`, `K4ABC GE UR 5NN ${region} ${region} BK`, "BK TU 73 EE"]);
  }
}
