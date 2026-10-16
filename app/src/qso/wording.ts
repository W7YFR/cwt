/* What the station says, in the words an operator would use.
 *
 * Each over is built from parts, and each part has several wordings. The
 * station picks one at random each time, so two QSOs do not read the same.
 * With `rand` always 0, every pick is the first wording and every part that
 * may be left out is kept. The tests rely on that.
 */

import { pick, type Rand, type Station } from "./station";

/** What the station knows when it speaks. */
export interface Say {
  readonly them: Station;
  /** Your call, as the station copied it. */
  readonly you: string;
  /** Your name, as the station copied it, or empty. */
  readonly name: string;
  readonly rand: Rand;
  /** The station's local hour, 0 to 23, for GM, GA or GE. */
  readonly hour: number;
}

/** How often a part that may be left out is kept. */
const KEEP = 0.6;

function maybe(rand: Rand, text: string): string {
  return rand() < KEEP ? text : "";
}

/** The words joined, with the empty ones left out. */
function words(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

export function greeting(hour: number): string {
  return hour < 12 ? "GM" : hour < 18 ? "GA" : "GE";
}

/** Your name, or OM when the station did not copy it. */
function to(s: Say): string {
  return s.name || "OM";
}

/** The station's first over, answering your CQ. */
export function callBack(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [
    `${s.you} DE ${c} ${c} K`,
    `${s.you} DE ${c} ${c} AR`,
    `${s.you} DE ${c} ${c} ${c} K`,
    `DE ${c} ${c} K`,
    `${c} ${c}`,
  ]);
}

/** Its call again, for an over that did not have it. */
export function callAgain(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`DE ${c} ${c} K`, `${s.you} DE ${c} ${c} K`, `${c} ${c} ${c} K`]);
}

/** Its call confirmed, for you asking whether you have it right. */
export function confirmCall(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`R R DE ${c} ${c} K`, `RR ${c} ${c} K`, `R ${s.you} DE ${c} ${c} K`]);
}

/** It asks for your call, for a CQ it could not read. */
export function askCall(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`CALL? DE ${c} K`, `UR CALL? DE ${c} K`, `? DE ${c} K`]);
}

/** It asks for your over again, when it could not read it. */
export function askAgain(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`PSE AGN ${s.you} DE ${c} KN`, `AGN PSE ${s.you} DE ${c} KN`, `PSE AGN KN`]);
}

/** Its report, with 599 sometimes sent as 5NN. */
function report(s: Say): string {
  const r = s.them.rst === "599" && s.rand() < 0.3 ? "5NN" : s.them.rst;
  return pick(s.rand, [`UR RST ${r} ${r}`, `UR ${r} ${r}`, `RST ${r} ${r}`, `UR RST IS ${r} ${r}`]);
}

function nameOf(s: Say): string {
  const n = s.them.name;
  return pick(s.rand, [`NAME ${n} ${n}`, `NAME HR ${n} ${n}`, `OP ${n} ${n}`, `NAME IS ${n} ${n}`]);
}

function qthOf(s: Say): string {
  const q = s.them.qth;
  const at = q.lastIndexOf(" ");
  const city = q.slice(0, at);
  const state = q.slice(at + 1);
  return pick(s.rand, [`QTH ${q} ${q}`, `QTH ${city} ${city} ${state}`, `QTH HR ${q} ${q}`, `QTH IS ${q}`]);
}

/** Its exchange: report, name and QTH.
 *
 * `gotReport` says whether your over held a report. Only then does it thank
 * you for one. */
export function exchange(s: Say, gotReport: boolean): string {
  const { rand } = s;
  const c = s.them.call;
  const thanks = gotReport
    ? pick(rand, ["R TNX FER RPT", "R R TNX FER RPT", "FB TNX FER RPT", "R TNX RPT"])
    : pick(rand, ["R", "", "TNX"]);
  const hello = maybe(rand, `${greeting(s.hour)} ${to(s)}`);
  const parts = [report(s), nameOf(s), qthOf(s)];
  if (rand() >= KEEP) parts.splice(1, 2, parts[2]!, parts[1]!);
  const bt = rand() < 0.3 ? "<BT>" : "";
  const ask = pick(rand, ["HW?", "HW CPY?", "SO HW?", ""]);
  const end = pick(rand, ["KN", "K", "BK"]);
  return words(s.you, "DE", c, thanks, hello, bt, ...parts, ask, s.you, "DE", c, end);
}

/** Its 73, sent first, when you went on without signing. */
export function signFirst(s: Say): string {
  const c = s.them.call;
  const n = to(s);
  return words(
    pick(s.rand, [
      `R R FB ${n} TNX FER QSO HPE CUAGN 73`,
      `R TNX FER QSO ${n} GL ES 73`,
      `FB ${n} TNX FB QSO 73 ES GL`,
      `OK ${n} TNX QSO CUL 73`,
    ]),
    `${s.you} DE ${c} <SK>`,
  );
}

/** Its last over, after your 73. */
export function signOff(s: Say): string {
  const c = s.them.call;
  const n = to(s);
  return pick(s.rand, [
    `TU ${n} 73 GL ${s.you} DE ${c} <SK> E E`,
    `R TNX FER QSO ${n} 73 ${s.you} DE ${c} <SK>`,
    `FB ${n} TNX FB QSO CUAGN 73 <SK> E E`,
    `R R TNX ${n} GL ES 73 <SK> E E`,
  ]);
}

/** The two dits that close the QSO after your last 73. */
export function lastDits(s: Say): string {
  return pick(s.rand, ["E E", "TU E E", "73 E E"]);
}
