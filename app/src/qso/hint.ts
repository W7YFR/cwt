/* A suggested reply: what you could send next, from where the QSO is.
 *
 * One way through of several. Each over has a few wordings, and `rand`
 * picks one, as an operator would. With `rand` always 0, every pick is the
 * first wording, the plainest. Every wording here is one the station takes:
 * a test works whole QSOs from the hints alone, in every format, and the
 * station never has to ask again.
 *
 * Your call, name, QTH and CWops number come from User. What User leaves
 * empty shows as a note in brackets, as (YOUR NAME), for you to fill in as
 * you send. The Copy page's generated QSOs send the station that calls CQ this way too.
 *
 * Pure.
 */

import { sentPieces, type Qso } from "./cq";
import { FORMATS, type FormatId } from "./formats";
import { isRun, type AnyQso, type RunQso } from "./run";
import { REGIONS } from "./formats";
import { pick, type Rand } from "./station";
import { greeting, type Piece } from "./wording";

/** You, as the hints send you. */
export interface Me {
  readonly call: string;
  readonly name: string;
  /** City and region: PORTLAND OR. */
  readonly qth: string;
  readonly region: string;
  /** Your CWops number, or empty. */
  readonly nr: string;
  /** The report you give, as 599. Absent: 599. */
  readonly rst?: string;
}

/** How the hints pick their words. */
export interface Voice {
  readonly rand: Rand;
  /** Your local hour, 0 to 23, for GM, GA or GE. */
  readonly hour: number;
}

/** The first wording of every over. */
export const PLAIN: Voice = { rand: () => 0, hour: 12 };

/** Wordings picked by `seed`: the same seed, the same wordings. The QSO
 *  page seeds by the over, so a hint stays as it is while it shows. */
export function seededVoice(seed: number, hour: number): Voice {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return {
    rand: () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    },
    hour,
  };
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
function pieceOf(p: Piece, me: Me, v: Voice): string {
  const rst = me.rst ?? "599";
  if (p === "report") {
    const r = rst === "599" && v.rand() < 0.2 ? "5NN" : rst;
    return pick(v.rand, [`UR ${r} ${r}`, `UR RST ${r} ${r}`, `RST ${r} ${r}`, `UR RST IS ${r} ${r}`]);
  }
  const n = me.name;
  if (p === "name") return pick(v.rand, [`NAME ${n} ${n}`, `NAME HR ${n} ${n}`, `OP ${n} ${n}`, `NAME IS ${n} ${n}`]);
  const q = me.qth;
  return pick(v.rand, [`QTH ${q}`, `QTH HR ${q}`, `QTH IS ${q}`]);
}

/** The words joined, with the empty ones left out. */
function words(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Your CQ for a run of `format`. */
function cqFor(format: FormatId, call: string, v: Voice): string {
  const w = FORMATS[format].word;
  if (format === "pota") {
    return pick(v.rand, [
      `CQ POTA DE ${call}`,
      `CQ POTA DE ${call} ${call} K`,
      `CQ CQ POTA DE ${call} ${call} K`,
      `CQ POTA ${call} ${call}`,
    ]);
  }
  return pick(v.rand, [`CQ ${w} ${call}`, `CQ ${w} ${call} ${call}`, `CQ ${w} DE ${call}`, `${w} ${call}`]);
}

/** Your next over in a rag chew. Before a station answers, the CQ is for
 *  `start`: a plain CQ, or a format's. */
function chat(qso: Qso, me: Me, start: FormatId | null, v: Voice): string {
  const { call } = me;
  const them = qso.them.call;
  const end = () => pick(v.rand, ["K", "KN", "BK"]);
  switch (qso.stage) {
    case "cq":
      if (start) return cqFor(start, call, v);
      return pick(v.rand, [
        `CQ CQ DE ${call} ${call} K`,
        `CQ CQ CQ DE ${call} ${call} ${call} K`,
        `CQ CQ DE ${call} ${call} ${call} K`,
        `CQ CQ CQ DE ${call} ${call} K`,
        `CQ DE ${call} ${call} K`,
      ]);
    case "asking":
      return pick(v.rand, [`DE ${call} ${call} K`, `${call} ${call} ${call} K`, `DE ${call} ${call} ${call} K`]);
    case "called": {
      const hello = pick(v.rand, ["", `${greeting(v.hour)} OM`, "TNX FER CALL", `${greeting(v.hour)} ES TNX FER CALL`]);
      const order: Piece[] = v.rand() < 0.7 ? ["report", "name", "qth"] : ["report", "qth", "name"];
      const bt = v.rand() < 0.8 ? "" : "<BT>";
      const ask = pick(v.rand, ["", "HW?", "HW CPY?"]);
      const tail = ask ? `${ask} ${them} DE ${call}` : "";
      return words(them, "DE", call, hello, bt, ...order.map((p) => pieceOf(p, me, v)), tail, end());
    }
    case "pieces":
    case "exchanged": {
      // What it gave and has not had back from you.
      const owed = sentPieces(qso).filter((p) => !qso.got.includes(p));
      if (owed.length) {
        const head = pick(v.rand, [`${them} DE ${call}`, "R", `R R ${them} DE ${call}`, "TNX"]);
        return words(head, ...owed.map((p) => pieceOf(p, me, v)), end());
      }
      if (qso.stage === "pieces") {
        return pick(v.rand, [`R TNX ${them} DE ${call} K`, "R R FB K", `QSL ${them} DE ${call} KN`, "R TNX OM BK"]);
      }
      const n = qso.them.name;
      return pick(v.rand, [
        `TNX ${n} 73 SK`,
        `R TNX FER QSO ${n} 73 <SK>`,
        `FB ${n} TNX FER QSO HPE CUAGN 73 ${them} DE ${call} <SK>`,
        `R R TU ${n} GL ES 73 <SK>`,
        `TNX FB QSO ${n} 73 ${them} DE ${call} SK`,
      ]);
    }
    case "signing":
      return pick(v.rand, ["TU 73 E E", "73 E E", "TU E E", `73 ${them} DE ${call} <SK> E E`]);
  }
}

/** What the station asked for, and your answer to it, twice. */
function answerTo(qso: RunQso, me: Me, v: Voice): string | null {
  const nr = qso.format === "mst" ? String(qso.made + 1) : me.nr || me.region;
  const asked: Readonly<Record<string, string>> = {
    "NAME?": me.name,
    "NR?": nr,
    "QTH?": me.region,
    "RST?": "5NN",
  };
  const value = asked[qso.last];
  if (value === undefined) return null;
  return pick(v.rand, [`${value} ${value}`, `${value} ${value} ${value}`, `R ${value} ${value}`]);
}

/** Your next over in a run. */
function run(qso: RunQso, me: Me, v: Voice): string {
  const { call } = me;
  const them = qso.them.call;
  switch (qso.stage) {
    case "waiting":
      return cqFor(qso.format, call, v);
    case "called": {
      const again = answerTo(qso, me, v);
      if (again) return again;
      const g = greeting(v.hour);
      // Greeting by its name reads as a name of yours unless yours follows
      // it and is no region: GE JIM AL NE would give your name as JIM.
      const byName = !REGIONS.has(me.name) && v.rand() >= 0.5 ? `${g} ${qso.them.name}` : g;
      switch (qso.format) {
        case "cwt": {
          const nr = me.nr || me.region;
          return pick(v.rand, [`${them} ${me.name} ${nr}`, `${them} TU ${me.name} ${nr}`, `${me.name} ${nr}`, `${them} ${me.name} ${nr} ${nr}`]);
        }
        case "sst":
          return pick(v.rand, [`${them} ${me.name} ${me.region}`, `${them} ${byName} ${me.name} ${me.region}`, `${byName} ${me.name} ${me.region}`, `${them} TU ${me.name} ${me.region}`]);
        case "mst": {
          const nr = String(qso.made + 1);
          return pick(v.rand, [`${them} ${me.name} ${nr}`, `${them} TU ${me.name} ${nr}`, `${me.name} ${nr}`]);
        }
        case "pota": {
          const r = me.rst === undefined || me.rst === "599" ? "5NN" : me.rst;
          const st = me.region;
          return pick(v.rand, [
            `${them} UR ${r} ${st} ${st} BK`,
            `${them} ${g} UR ${r} ${r} ${st} ${st} BK`,
            `BK ${them} TU UR ${r} ${st} ${st} BK`,
            `${them} ${r} ${r} ${st} ${st} BK`,
            `${them} ${g} OM UR ${r} ${r} ${st} ${st} BK`,
          ]);
        }
      }
      break;
    }
    case "exchanged":
      if (qso.format === "pota") return pick(v.rand, ["BK TU 73 EE", "RR TU 73 E E", "BK TU 72 E E", "TU 73 GL E E"]);
      if (qso.format === "sst") return pick(v.rand, [`TU ${call}`, `TU ${qso.them.name} 73 ${call}`, `R TU ${call}`, `TU GL ${call} SST`]);
      return pick(v.rand, [`TU ${call}`, `TU ${call} ${FORMATS[qso.format].word}`, `R TU ${call}`, `TU GL ${call}`]);
  }
  return `TU ${call}`;
}

/** What you could send next in `qso`. A first CQ is for `start`, the kind
 *  of QSO the guide shows: a plain CQ, or a format's. `voice` picks the
 *  wording: the plainest, unless given. */
export function hint(qso: AnyQso, me: Me, start: FormatId | null = null, voice: Voice = PLAIN): string {
  return isRun(qso) ? run(qso, me, voice) : chat(qso, me, start, voice);
}
