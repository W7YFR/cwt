/* What the station says, in the words an operator would use.
 *
 * Each over is built from parts, and each part has several wordings. The
 * station picks one at random each time, so two QSOs do not read the same.
 * With `rand` always 0, every pick is the first wording and every part that
 * may be left out is kept. The tests rely on that.
 *
 * How much it says follows the length: full, short, or piece by piece, where
 * the exchange comes one item per over.
 *
 * A line in the middle of the QSO opens with both calls by the station's own
 * habit, and half the time when your last over did. A full exchange ends
 * with them, and the sign-off carries them.
 */

import { pick, type Rand, type Station } from "./station";

export type Length = "full" | "short" | "pieces";

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
  readonly length: Length;
  /** Your last over opened with both calls, so the station mostly does too. */
  readonly mirror: boolean;
}

/** The items of the exchange, in the order piece by piece sends them. */
export const PIECES = ["report", "name", "qth"] as const;
export type Piece = (typeof PIECES)[number];

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

/** How often a line opens with both calls when your last over did. Operators
 *  match each other's style, now and then. */
const MIRROR = 0.5;

/** Whether a line in the middle of the QSO opens with both calls: by the
 *  station's own habit, and more often when your last over did. */
function opens(s: Say): boolean {
  const habit = s.them.habit ?? KEEP;
  return s.rand() < (s.mirror ? Math.max(habit, MIRROR) : habit);
}

/** Your name, or OM when the station did not copy it. */
function to(s: Say): string {
  return s.name || "OM";
}

const short = (s: Say) => s.length === "short";

/** The station's first over, answering your CQ. */
export function callBack(s: Say): string {
  const c = s.them.call;
  if (short(s)) return pick(s.rand, [`DE ${c} K`, `${c} ${c}`, `${c}`]);
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

/** Its call put right, for an over that sent it wrong. */
export function correctCall(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`MY CALL ${c} ${c} K`, `${s.you} DE ${c} ${c} ${c} K`, `CALL IS ${c} ${c} K`]);
}

/** It cannot go faster, or slower, than it is. */
export function cannotChange(s: Say, slower: boolean): string {
  const q = slower ? "QRS" : "QRQ";
  return pick(s.rand, [`SRI NO ${q} K`, `${q} NIL SRI K`, `SRI CANT ${slower ? "GO SLOWER" : "GO FASTER"} K`]);
}

/** It asks for your call, for a CQ it could not read. */
export function askCall(s: Say): string {
  const c = s.them.call;
  return pick(s.rand, [`CALL? DE ${c} K`, `UR CALL? DE ${c} K`, `? DE ${c} K`]);
}

/** It asks for your over again, when it could not read it. */
export function askAgain(s: Say): string {
  const c = s.them.call;
  if (!opens(s)) return "PSE AGN KN";
  return pick(s.rand, [`PSE AGN ${s.you} DE ${c} KN`, `AGN PSE ${s.you} DE ${c} KN`]);
}

/** Its report, with 599 sometimes sent as 5NN. Twice, or once when short. */
function report(s: Say): string {
  const r = s.them.rst === "599" && s.rand() < 0.3 ? "5NN" : s.them.rst;
  if (short(s)) return pick(s.rand, [`UR ${r}`, `RST ${r}`, `UR RST ${r}`]);
  return pick(s.rand, [`UR RST ${r} ${r}`, `UR ${r} ${r}`, `RST ${r} ${r}`, `UR RST IS ${r} ${r}`]);
}

function nameOf(s: Say): string {
  const n = s.them.name;
  if (short(s)) return pick(s.rand, [`NAME ${n}`, `OP ${n}`, `NAME HR ${n}`]);
  return pick(s.rand, [`NAME ${n} ${n}`, `NAME HR ${n} ${n}`, `OP ${n} ${n}`, `NAME IS ${n} ${n}`]);
}

function qthOf(s: Say): string {
  const q = s.them.qth;
  const at = q.lastIndexOf(" ");
  const city = q.slice(0, at);
  const state = q.slice(at + 1);
  if (short(s)) return pick(s.rand, [`QTH ${q}`, `QTH ${city}`, `QTH HR ${q}`]);
  return pick(s.rand, [`QTH ${q} ${q}`, `QTH ${city} ${city} ${state}`, `QTH HR ${q} ${q}`, `QTH IS ${q}`]);
}

const ITEM: Readonly<Record<Piece, (s: Say) => string>> = { report, name: nameOf, qth: qthOf };

/** How it opens its exchange. `gotReport` says whether your over held a
 *  report. Only then does it thank you for one. */
function thanks(s: Say, gotReport: boolean): string {
  return gotReport
    ? pick(s.rand, ["R TNX FER RPT", "R R TNX FER RPT", "FB TNX FER RPT", "R TNX RPT"])
    : pick(s.rand, ["R", "", "TNX"]);
}

/** Its exchange: report, name and QTH. In piece by piece, this is the first
 *  piece alone: see `piece`. */
export function exchange(s: Say, gotReport: boolean): string {
  if (s.length === "pieces") return piece(s, 0, thanks(s, gotReport));
  const { rand } = s;
  const c = s.them.call;
  const open = thanks(s, gotReport);
  const hello = maybe(rand, `${greeting(s.hour)} ${to(s)}`);
  const parts = [report(s), nameOf(s), qthOf(s)];
  if (rand() >= KEEP) parts.splice(1, 2, parts[2]!, parts[1]!);
  // Both calls first by habit. A full exchange ends with them all the same.
  const head = opens(s) ? `${s.you} DE ${c}` : "";
  if (short(s)) {
    const ask = pick(rand, ["HW?", ""]);
    return words(head, open, ...parts, ask, pick(rand, ["KN", "BK", "K"]));
  }
  const bt = rand() < 0.3 ? "<BT>" : "";
  const ask = pick(rand, ["HW?", "HW CPY?", "SO HW?", ""]);
  const end = pick(rand, ["KN", "K", "BK"]);
  return words(head, open, hello, bt, ...parts, ask, s.you, "DE", c, end);
}

/** One piece of the exchange, for piece by piece: piece `at` of `PIECES`.
 *
 * `open` starts it: the thanks for the first piece, or R, TNX or FB for a
 * piece of yours that came with your last over. The first piece greets you
 * and the last asks how you copied. */
export function piece(s: Say, at: number, open: string): string {
  const { rand } = s;
  const c = s.them.call;
  const first = at === 0;
  const last = at === PIECES.length - 1;
  const head = opens(s) ? `${s.you} DE ${c}` : "";
  const hello = first ? maybe(rand, `${greeting(s.hour)} ${to(s)}`) : "";
  const ask = last ? pick(rand, ["HW?", "HW CPY?", "SO HW?"]) : "";
  const end = pick(rand, ["KN", "BK", "K"]);
  return words(head, open, hello, ITEM[PIECES[at]!](s), ask, end);
}

/** How it acknowledges a piece of yours: R, TNX or FB, with your name when
 *  it has it. */
export function gotPiece(s: Say): string {
  return pick(s.rand, ["R", "TNX", `FB ${to(s)}`, "R R"]);
}

/** What it sends for a question about one thing. */
export type Question = "call" | Piece;

/** One item of its exchange, as plain as it goes: 599, BOB, SALEM OR. */
function valueOf(s: Say, p: Piece): string {
  return p === "report" ? s.them.rst : p === "name" ? s.them.name : s.them.qth;
}

/** The answer to your questions, each one once, in the order asked.
 *
 * `checked` are the items you sent back with a ?, as in SALEM OR ?. It
 * confirms them first: R R SALEM OR. With `close` false, the answer has no
 * K, so the station can go on in the same over. */
export function answers(
  s: Say,
  asked: readonly Question[],
  checked: readonly Piece[] = [],
  close = true,
): string {
  const c = s.them.call;
  const yes = checked.length
    ? words(pick(s.rand, ["R R", "YES", "RR"]), ...checked.map((p) => valueOf(s, p)))
    : "";
  const parts = asked.map((q) => {
    if (q === "call") return pick(s.rand, [`${c} ${c}`, `DE ${c} ${c}`, `${c} ${c} ${c}`]);
    return ITEM[q]({ ...s, length: "full" });
  });
  return words(yes, ...parts, close ? pick(s.rand, ["K", "KN"]) : "");
}

/** The word that names each piece, as the station asks for it: NAME?. */
export const LABEL: Readonly<Record<Piece, string>> = { report: "RST", name: "NAME", qth: "QTH" };

/** It asks for the pieces of your exchange it gave and has not had back.
 *  With `calls` false, it sends no calls first: the ask follows an answer
 *  in the same over. */
export function askFor(s: Say, missing: readonly Piece[], calls = true): string {
  const c = s.them.call;
  const labels = missing.map((p) => LABEL[p]);
  const head = calls && opens(s) ? `${s.you} DE ${c}` : "";
  if (labels.length === 1) {
    const l = labels[0]!;
    return words(head, pick(s.rand, [`UR ${l}? KN`, `${l}? KN`, `PSE UR ${l}? KN`]));
  }
  return words(head, pick(s.rand, [`PSE UR ${labels.join(" ES ")}? KN`, `UR ${labels.join(" ")}? KN`]));
}

/** Its 73, sent first, when you went on without signing. */
export function signFirst(s: Say): string {
  const c = s.them.call;
  const n = to(s);
  if (short(s)) {
    return pick(s.rand, [`TNX QSO 73 <SK>`, `R TU ${n} 73 GL <SK>`, `FB ${n} 73 <SK>`]);
  }
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
  if (short(s)) return pick(s.rand, [`TU 73 E E`, `73 TU <SK> E E`, `TNX ${n} 73 <SK>`]);
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
