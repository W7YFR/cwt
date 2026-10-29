/* A run: short QSOs, one station after another, in one format.
 *
 * Your CQ names the format: CQ CWT, CQ SST, CQ MST or CQ POTA (see
 * formats.ts). A station answers with its call. You send its call and your
 * exchange, it sends its own, and your TU ends the QSO. The next station
 * calls when you send anything, or when the page says it is time.
 *
 * The station asks again the way a contest operator would:
 *
 *   - AGN, ? or QRZ? gets its last over again;
 *   - its call sent wrong, or part of it with a ?, gets its call;
 *   - an exchange with an item missing gets NAME?, NR? or QTH?, and one it
 *     cannot read at all gets AGN?;
 *   - after its exchange, NR?, NAME?, QTH? or RST? gets that item twice;
 *   - QRS and QRQ work as in a rag chew.
 *
 * Your call is not needed: whoever answers a CQ in a run takes the next over
 * as theirs. Its call with another call sent wrong is not.
 *
 * Each station sends at a speed of its own in the format's range, not yours.
 *
 * Pure, like cq.ts. `respond` is the page's way in: it picks the run or the
 * rag chew from your CQ.
 */

import { pick, randomCaller, regionOf, type Rand, type Station } from "./station";
import { FORMATS, FORMAT_IDS, REGIONS, formatNamed, type FormatId, type Item } from "./formats";
import { NO_SEARCH, type Search, type Speed } from "./speed";
import {
  DEFAULT_SPEED,
  Over,
  REPORT_IN,
  REPORT_RE,
  STRICT,
  urApart,
  TURN_WORDS,
  answer,
  isCall,
  nearly,
  newQso,
  pace,
  type Context,
  type Qso,
} from "./cq";

/** Your exchange, item by item: what the station has copied of it. */
export interface Heard {
  readonly name: string;
  readonly number: string;
  readonly region: string;
  readonly report: string;
}

const NOTHING: Heard = { name: "", number: "", region: "", report: "" };

/** Waiting for a station to call, it has sent its call, or it has sent its
 *  exchange and waits for your TU. */
export type RunStage = "waiting" | "called" | "exchanged";

export interface RunQso {
  readonly format: FormatId;
  readonly stage: RunStage;
  readonly them: Station;
  /** Your call, from your CQ. Empty until you send it. */
  readonly you: string;
  /** Your name, as the station copied it. */
  readonly yourName: string;
  /** The station's last over, for AGN. */
  readonly last: string;
  readonly speed: Speed;
  readonly search: Search;
  /** The QSOs made in this run before this one. */
  readonly made: number;
  /** What it has of your exchange so far, from every over. Absent in a QSO
   *  kept before there was one. */
  readonly got?: Heard;
}

export type AnyQso = Qso | RunQso;

export function isRun(qso: AnyQso): qso is RunQso {
  return "format" in qso;
}

/** Everything an answer depends on beyond the QSO and the over. */
export interface RunContext extends Context {
  /** Your region from User, which the station takes as a region. */
  readonly region?: string;
  /** Your speed: a rag chew's station starts at it. */
  readonly speed?: Speed;
}

export interface RunTurn {
  readonly qso: AnyQso;
  /** What the station sends, or null for nothing. */
  readonly reply: string | null;
  /** The QSO is over. */
  readonly ended: boolean;
}

/** A new QSO in a run of `format`, after `made` QSOs, with a station not at
 *  the call `not`. */
export function newRun(format: FormatId, rand: Rand, made = 0, not = "", you = ""): RunQso {
  const [lo, hi] = FORMATS[format].wpm;
  const wpm = lo + Math.floor(rand() * (hi - lo + 1));
  return {
    format,
    stage: "waiting",
    them: randomCaller(rand, not),
    you,
    yourName: "",
    last: "",
    speed: { charWpm: wpm, farnsworthWpm: wpm },
    search: NO_SEARCH,
    made,
    got: NOTHING,
  };
}

/** The QSO after `qso`: the next station in a run, or a new rag chew. */
export function following(qso: AnyQso, rand: Rand, speed: Speed = DEFAULT_SPEED): AnyQso {
  if (isRun(qso)) return newRun(qso.format, rand, qso.made + 1, qso.them.call, qso.you);
  return newQso(rand, qso.you, speed);
}

/** The station calls you: its first over. */
export function callIn(qso: RunQso, rand: Rand = Math.random): RunTurn {
  const c = qso.them.call;
  return say(qso, pick(rand, [c, `${c} ${c}`]), "called");
}

function say(qso: RunQso, reply: string, stage: RunStage = qso.stage): RunTurn {
  return { qso: { ...qso, stage, last: reply }, reply, ended: false };
}

/** Words around an exchange that are not part of it. */
export const AROUND = new Set([
  ...TURN_WORDS, "TU", "TNX", "R", "RR", "QSL", "GM", "GA", "GE", "GN", "UR", "NAME", "OP",
  "NR", "QTH", "ST", "RST", "5NN", "599", "73", "72", "EE", "E", "FB", "ES", "HR", "IS", "CQ",
  "TEST", "QRZ", "BK", "<BK>", "AGN", "PSE", "SRI", "QRS", "QRQ", "WPM", "CALL",
]);

/** A number as sent: digits, with the cut letters T for 0 and N for 9 read
 *  as digits. At least one real digit, and never a report. */
function numberOf(word: string): string | null {
  if (!/^[0-9TNO]{1,5}$/.test(word) || !/\d/.test(word) || REPORT_RE.test(word)) return null;
  return word.replace(/[TO]/g, "0").replace(/N/g, "9");
}

/** Read your exchange of `format` from `words`. With a name in it, the name
 *  comes first, and the number or region after it. The report anywhere.
 *  `mine` is your own region, which counts as one. The station's own name
 *  `theirs`, as in GE JIM TOM OR, is a greeting, not your name, when
 *  another name comes after it. */
function heardIn(format: FormatId, words: readonly string[], mine: string, theirs: string, lenient = false): Heard {
  const isRegion = (w: string) => REGIONS.has(w) || (mine !== "" && w === mine);
  const rest = words.filter((w) => !AROUND.has(w) && !isCall(w) && !w.endsWith("?") && formatNamed(w) === null);
  const report = reportIn(words);
  const named = FORMATS[format].yours.includes("name");
  const isName = (w: string | undefined) => w !== undefined && /^[A-Z]{2,}$/.test(w);
  let at = named ? rest.findIndex((w) => isName(w)) : -1;
  if (at >= 0 && rest[at] === theirs && isName(rest[at + 1]) && !isRegion(rest[at + 1]!)) at++;
  const name = at >= 0 ? rest[at]! : "";
  const after = rest.slice(at + 1);
  const number = after.map(numberOf).find((n) => n !== null) ?? "";
  const region = regionIn(after, mine, lenient);
  return { name, number, region, report };
}

/** Words run together, apart, as lenient copy reads them: UR5NN is UR 5NN,
 *  5NNWA is 5NN WA, TOM1234 is TOM 1234, and WAWA is WA WA. A call stays
 *  whole. */
export function unglued(words: readonly string[]): string[] {
  const apart = (w: string): string[] => {
    const ur = urApart(w);
    if (ur.length > 1) return ur;
    if (isCall(w) || REPORT_RE.test(w) || /^[A-Z]{1,2}$/.test(w)) return [w];
    const m = REPORT_IN.exec(w);
    if (m && /[A-Z]/.test(w.replace(m[0], ""))) {
      const before = w.slice(0, m.index);
      const after = w.slice(m.index + m[0].length);
      return [...(before ? apart(before) : []), m[0], ...(after ? apart(after) : [])];
    }
    const named = /^([A-Z]{2,})(\d[0-9TN]*)$/.exec(w);
    if (named) return [named[1]!, named[2]!];
    if (w.length === 4 && REGIONS.has(w.slice(0, 2)) && REGIONS.has(w.slice(2))) return [w.slice(0, 2), w.slice(2)];
    return [w];
  };
  return words.flatMap(apart);
}

/** The words with a call keyed apart taken out: AK 3SD, when the call is
 *  AK3SD. One to four words that run together into one of `calls`, or one
 *  character off the station's call `theirs`, as NBMZA for N6MZA. What is
 *  left is the exchange. */
export function withoutCalls(words: readonly string[], calls: readonly string[], theirs: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let taken = 0;
    for (let n = Math.min(4, words.length - i); n >= 1 && !taken; n--) {
      const run = words.slice(i, i + n).join("");
      if (calls.includes(run) || nearly(run, theirs)) taken = n;
    }
    if (taken) i += taken - 1;
    else out.push(words[i]!);
  }
  return out;
}

/** Whether `words` hold `call` a character off: one word, or two to four
 *  keyed apart. */
function offCall(words: readonly string[], call: string): boolean {
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n).join("");
      if (run !== call && run.length >= 4 && nearly(run, call)) return true;
    }
  }
  return false;
}

/** A region: one of the list, or your own. With `lenient`, also two single
 *  letters keyed apart that make one: W A is WA. */
function regionIn(words: readonly string[], mine: string, lenient: boolean): string {
  const isRegion = (w: string) => REGIONS.has(w) || (mine !== "" && w === mine);
  const whole = words.find(isRegion);
  if (whole || !lenient) return whole ?? "";
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (/^[A-Z]$/.test(a) && /^[A-Z]$/.test(b) && isRegion(a + b)) return a + b;
  }
  return "";
}

/** A report: 5NN, or one keyed apart, as 5 NN. */
function reportIn(words: readonly string[]): string {
  const whole = words.find((w) => REPORT_RE.test(w));
  if (whole) return whole;
  for (let i = 0; i + 1 < words.length; i++) {
    const two = words[i]! + words[i + 1]!;
    if (REPORT_RE.test(two)) return two;
  }
  return "";
}

/** Your answer to the station asking for `item`: that item, wherever it is
 *  in the over. WA WA after QTH? is a region, not a name. */
function answerFor(item: Item, words: readonly string[], mine: string, lenient = false): Heard {
  const rest = words.filter((w) => !AROUND.has(w) && !isCall(w) && !w.endsWith("?"));
  switch (item) {
    case "name":
      return { ...NOTHING, name: rest.find((w) => /^[A-Z]{2,}$/.test(w)) ?? "" };
    case "number":
      return { ...NOTHING, number: rest.map(numberOf).find((n) => n !== null) ?? "" };
    case "region":
      return { ...NOTHING, region: regionIn(rest, mine, lenient) };
    case "report":
      return { ...NOTHING, report: reportIn(words) };
  }
}

/** What it had, with what this over adds. A new item replaces an old one:
 *  you may have sent it again to put it right. */
function merged(had: Heard, more: Heard): Heard {
  return {
    name: more.name || had.name,
    number: more.number || had.number,
    region: more.region || had.region,
    report: more.report || had.report,
  };
}

/** The items of `format` your over lacks, in order. CWT takes a region in
 *  place of a number. */
function lacking(format: FormatId, heard: Heard): Item[] {
  return FORMATS[format].yours.filter((item) => {
    if (item === "number" && format === "cwt") return !heard.number && !heard.region;
    return !heard[item];
  });
}

/** What the station asks for, for an item it did not get. */
const ASK: Readonly<Record<Item, string>> = { name: "NAME?", number: "NR?", region: "QTH?", report: "RST?" };

/** The words after a ? that ask for one item. */
const ASKED: Readonly<Record<string, Item>> = {
  NR: "number", NAME: "name", OP: "name", QTH: "region", ST: "region", SPC: "region", RST: "report", RPT: "report",
};

/** A report as a contest sends it: 599 as 5NN. */
function cut(rst: string): string {
  return rst.replace(/9/g, "N");
}

/** The station's own exchange, worded a little differently each time. */
function exchange(qso: RunQso, rand: Rand, hour: number): string {
  const { them, yourName } = qso;
  const name = them.name;
  const st = regionOf(them);
  const g = hour < 12 ? "GM" : hour < 18 ? "GA" : "GE";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  switch (qso.format) {
    case "cwt": {
      const nr = them.nr || st;
      return pick(rand, [`TU ${name} ${nr}`, `R ${name} ${nr}`, `${name} ${nr}`, join("TU", yourName, name, nr)]);
    }
    case "sst":
      return pick(rand, [join(g, yourName, name, st), join("TU", yourName, name, st), `R ${name} ${st}`]);
    case "mst":
      return pick(rand, [`TU ${name} ${them.serial ?? 1}`, `R ${name} ${them.serial ?? 1}`, `${name} ${them.serial ?? 1}`]);
    case "pota": {
      const r = cut(them.rst);
      return pick(rand, [`BK TU UR ${r} ${r} ${st} ${st} BK`, `R R ${r} ${st} ${st} BK`, `${g} TU ${r} ${st} ${st} BK`]);
    }
  }
}

/** One item of the station's exchange, twice, for NR? and the like. Null
 *  when its exchange has no such item. */
function itemOf(qso: RunQso, item: Item): string | null {
  const { them, format } = qso;
  const value =
    item === "name"
      ? format === "pota"
        ? null
        : them.name
      : item === "number"
        ? format === "cwt"
          ? them.nr || null
          : format === "mst"
            ? String(them.serial ?? 1)
            : null
        : item === "region"
          ? format === "sst" || format === "pota" || (format === "cwt" && !them.nr)
            ? regionOf(them)
            : null
          : format === "pota"
            ? cut(them.rst)
            : null;
  return value === null ? null : `${value} ${value}`;
}

/** What the station sends after your TU, or null for nothing. */
function lastWord(qso: RunQso, rand: Rand): string | null {
  if (qso.format === "pota") return pick(rand, ["73 E E", "E E", "TU 73 E E"]);
  if (qso.format === "sst") return rand() < 0.5 ? "73" : null;
  return null;
}

/** The item asked for with a ?, as NR? or NR ?, or null. */
function askedItem(over: Over): Item | null {
  const { words } = over;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const bare = w.replace(/\?+$/, "");
    const asked = w.endsWith("?") || words[i + 1] === "?";
    if (asked && bare in ASKED) return ASKED[bare]!;
  }
  return null;
}

/** Whether `over` asks for the last over again: AGN, ?, QRZ? or CALL?. */
function asksAgain(over: Over): boolean {
  return over.has("AGN") || over.words.some((w) => ["?", "AGN?", "QRZ?", "CALL?"].includes(w));
}

/** The station's answer to one over you sent, in a run. */
export function answerRun(qso: RunQso, heard: string, context: RunContext = {}): RunTurn {
  const { ear = STRICT, rand = Math.random, hour = new Date().getHours(), region = "" } = context;
  const over = new Over(heard, ear);
  const { them } = qso;
  const c = them.call;

  const paced = pace(qso, over, (slower) => `SRI NO ${slower ? "QRS" : "QRQ"}`);
  if (paced?.reply) return { qso: paced.qso, reply: paced.reply, ended: false };
  if (paced) qso = paced.qso;

  switch (qso.stage) {
    case "waiting": {
      // Whatever you send, a CQ, QRZ? or your call, the next station calls.
      const you = over.yourCall(c) ?? qso.you;
      return callIn({ ...qso, you }, rand);
    }

    case "called": {
      // Calls in the over, other than yours.
      const calls = over.words.filter((w) => isCall(w) && w !== qso.you && w !== ear.saved);
      const exact = over.hasExactly(c);
      // Its call with a ?, or part of it: it sends its call again.
      const checks = over.words.some((w, i) => {
        const bare = w.replace(/\?+$/, "");
        const asked = w.endsWith("?") || over.words[i + 1] === "?";
        return asked && bare.length >= 2 && c.includes(bare) && !(bare in ASKED);
      });
      if (checks) return say(qso, `${c} ${c}`);
      // After it asked for one item, your over is read as that item.
      // Lenient copy reads words run together apart. Its call, and yours,
      // are not part of the exchange, keyed apart or a character off.
      const mine = [c, qso.you, ear.saved].filter(Boolean);
      const words = withoutCalls(ear.lenient ? unglued(over.words) : over.words, mine, c);
      const asked = (Object.keys(ASK) as Item[]).find((item) => ASK[item] === qso.last);
      const fresh = asked
        ? answerFor(asked, words, region, ear.lenient)
        : heardIn(qso.format, words, region, them.name, ear.lenient);
      const had = qso.got ?? NOTHING;
      const got = merged(had, fresh);
      // Its call sent wrong: another call, or its own a character off, as
      // NBMZA for N6MZA. It puts you right, and keeps the rest of your
      // exchange, so its call alone next time goes on.
      const off = !exact && (calls.length > 0 || offCall(over.words, c));
      if (off) return say({ ...qso, got }, `${c} ${c}`);
      const missing = lacking(qso.format, got);
      const before = { ...qso, got };
      if (missing.length > 0) {
        const nothing = !fresh.name && !fresh.number && !fresh.region && !fresh.report;
        // Nothing new: AGN gets its last over again, and an over it cannot
        // read gets AGN?, or the item it still lacks.
        if (nothing && asksAgain(over)) return say(before, qso.last);
        if (lacking(qso.format, had).length === FORMATS[qso.format].yours.length && nothing) {
          return say(before, pick(rand, ["AGN?", "?"]));
        }
        return say(before, ASK[missing[0]!]);
      }
      const next = { ...before, yourName: got.name };
      return say(next, exchange(next, rand, hour), "exchanged");
    }

    case "exchanged": {
      const item = askedItem(over);
      if (item) return say(qso, itemOf(qso, item) ?? qso.last);
      if (asksAgain(over) && !over.has("TU")) return say(qso, qso.last);
      const reply = lastWord(qso, rand);
      return { qso: { ...qso, last: reply ?? qso.last }, reply, ended: true };
    }
  }
}

/** The format your over names, or null. Lenient copy finds it run into
 *  other words too, as CQCWT. */
function namedIn(over: Over): FormatId | null {
  for (const w of over.words) {
    const id = formatNamed(w);
    if (id) return id;
  }
  if (!over.ear.lenient) return null;
  return FORMAT_IDS.find((id) => over.joined.includes(`CQ${FORMATS[id].word}`)) ?? null;
}

/** The station's answer to one over you sent: in a run, or in a rag chew.
 *
 * Before a station has called, your CQ picks: one with a format's word
 * starts a run of it, or one of another format a new run. A plain CQ in a
 * run goes back to a rag chew. */
export function respond(qso: AnyQso, heard: string, context: RunContext = {}): RunTurn {
  const { ear = STRICT, rand = Math.random, speed = DEFAULT_SPEED } = context;
  const fresh = isRun(qso) ? qso.stage === "waiting" : qso.stage === "cq";
  if (fresh) {
    const over = new Over(heard, ear);
    const named = namedIn(over);
    if (named && (!isRun(qso) || named !== qso.format)) qso = newRun(named, rand, 0, qso.them.call, qso.you);
    else if (!named && isRun(qso) && over.has("CQ")) qso = newQso(rand, qso.them.call, speed);
  }
  return isRun(qso) ? answerRun(qso, heard, context) : answer(qso, heard, context);
}
