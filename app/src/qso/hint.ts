/* A suggested reply: what you could send next, from where the QSO is.
 *
 * One plain way through, not the only one: the station takes more than one
 * order and wording. Your call, name, QTH and CWops number come from User.
 * What User leaves empty shows as a note in brackets, as (YOUR NAME), for
 * you to fill in as you send.
 *
 * Pure. A test works whole QSOs from the hints alone, in every format.
 */

import { sentPieces, type Qso } from "./cq";
import { FORMATS, type FormatId } from "./formats";
import { isRun, type AnyQso, type RunQso } from "./run";
import type { Piece } from "./wording";

/** You, as the hints send you. */
export interface Me {
  readonly call: string;
  readonly name: string;
  /** City and region: PORTLAND OR. */
  readonly qth: string;
  readonly region: string;
  /** Your CWops number, or empty. */
  readonly nr: string;
}

/** You from User, with a note in brackets for each thing it leaves empty. */
export function meOf(user: {
  callsign: string;
  name: string;
  qthCity: string;
  qthRegionShort: string;
  cwopsNumber: string;
}): Me {
  const city = user.qthCity.trim();
  const region = user.qthRegionShort.trim();
  return {
    call: user.callsign.trim() || "(YOUR CALL)",
    name: user.name.trim() || "(YOUR NAME)",
    qth: [city, region].filter(Boolean).join(" ") || "(YOUR QTH)",
    region: region || "(YOUR STATE)",
    nr: user.cwopsNumber.trim(),
  };
}

/** Each piece of your exchange, as a rag chew sends it. */
function pieceOf(p: Piece, me: Me): string {
  if (p === "report") return "UR 599 599";
  if (p === "name") return `NAME ${me.name} ${me.name}`;
  return `QTH ${me.qth}`;
}

/** Your CQ for a run of `format`. */
function cqFor(format: FormatId, call: string): string {
  return format === "pota" ? `CQ POTA DE ${call}` : `CQ ${FORMATS[format].word} ${call}`;
}

/** Your next over in a rag chew. Before a station answers, the CQ is for
 *  `start`: a plain CQ, or a format's. */
function chat(qso: Qso, me: Me, start: FormatId | null): string {
  const { call } = me;
  const them = qso.them.call;
  switch (qso.stage) {
    case "cq":
      return start ? cqFor(start, call) : `CQ CQ DE ${call} ${call} K`;
    case "asking":
      return `DE ${call} ${call} K`;
    case "called":
      return `${them} DE ${call} ${pieceOf("report", me)} ${pieceOf("name", me)} ${pieceOf("qth", me)} K`;
    case "pieces":
    case "exchanged": {
      // What it gave and has not had back from you.
      const owed = sentPieces(qso).filter((p) => !qso.got.includes(p));
      if (owed.length) return `${them} DE ${call} ${owed.map((p) => pieceOf(p, me)).join(" ")} K`;
      if (qso.stage === "pieces") return `R TNX ${them} DE ${call} K`;
      return `TNX ${qso.them.name} 73 SK`;
    }
    case "signing":
      return "TU 73 E E";
  }
}

/** What the station asked for, and your answer to it, twice. */
function answerTo(qso: RunQso, me: Me): string | null {
  const nr = qso.format === "mst" ? String(qso.made + 1) : me.nr || me.region;
  const asked: Readonly<Record<string, string>> = {
    "NAME?": me.name,
    "NR?": nr,
    "QTH?": me.region,
    "RST?": "5NN",
  };
  const value = asked[qso.last];
  return value === undefined ? null : `${value} ${value}`;
}

/** Your next over in a run. */
function run(qso: RunQso, me: Me): string {
  const { call } = me;
  const them = qso.them.call;
  switch (qso.stage) {
    case "waiting":
      return cqFor(qso.format, call);
    case "called": {
      const again = answerTo(qso, me);
      if (again) return again;
      switch (qso.format) {
        case "cwt":
          return `${them} ${me.name} ${me.nr || me.region}`;
        case "sst":
          return `${them} ${me.name} ${me.region}`;
        case "mst":
          return `${them} ${me.name} ${qso.made + 1}`;
        case "pota":
          return `${them} UR 5NN ${me.region} ${me.region} BK`;
      }
      break;
    }
    case "exchanged":
      return qso.format === "pota" ? "BK TU 73 EE" : `TU ${call}`;
  }
  return `TU ${call}`;
}

/** What you could send next in `qso`. A first CQ is for `start`, the kind
 *  of QSO the guide shows: a plain CQ, or a format's. */
export function hint(qso: AnyQso, me: Me, start: FormatId | null = null): string {
  return isRun(qso) ? run(qso, me) : chat(qso, me, start);
}
