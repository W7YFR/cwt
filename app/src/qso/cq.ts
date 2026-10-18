/* A QSO that starts with your CQ, run as a script.
 *
 * You call CQ, a station answers, you send the exchange, it sends its own,
 * and you sign. Each over you send is read as copied, and the station answers
 * what it heard. A mistake never ends the QSO. The station asks again, the
 * way an operator would:
 *
 *   - a CQ with no call it can read gets CALL?;
 *   - its call with a question mark gets its call confirmed;
 *   - an over without its call gets its call again, and one with its call
 *     sent wrong gets it put right. Only the exact call moves it on;
 *   - your call after DE replaces the one it copied before;
 *   - part of its call with a ?, as in N1?, gets its call. NAME?, QTH?, RST?
 *     and CALL? get that one thing. None of these moves the QSO on;
 *   - QRS gets its last over again, slower, and QRQ makes it faster. The two
 *     search for your speed by halving (see speed.ts). The new speed holds
 *     until you ask again;
 *   - AGN or ? gets its last over again;
 *   - an exchange it cannot read gets PSE AGN;
 *   - an exchange with no 73 gets its own 73, and the QSO ends on yours.
 *
 * Strict copy reads the words as they were spaced and needs each call sent
 * exactly. Lenient copy also finds words run together, takes a call one
 * character off as the call, and knows your call from Configuration.
 *
 * Piece by piece, the exchange comes one item per over: report, name, QTH.
 * It starts each with R, TNX or FB when your over held a piece of your own
 * exchange or an acknowledgement.
 *
 * It moves on only once the current part is settled. Everything it sends,
 * you send back: it asks for your report, name or QTH until it has each one
 * it gave. An over it cannot read gets PSE AGN, and a question it cannot
 * place gets the current part again. A piece you began that did not come
 * through, as UR RST and nothing it can read, gets asked for.
 *
 * It thanks you for a report only when your over held one. What it says is
 * worded in wording.ts, a little differently each time.
 *
 * Pure. The page plays the replies and reads your overs.
 */

import { UNKNOWN } from "@/morse";
import { NO_SEARCH, qrq, qrs, setTo, type Search, type Speed } from "./speed";
import { randomStation, type Rand, type Station } from "./station";
import * as wording from "./wording";

export type Stage = "cq" | "asking" | "called" | "pieces" | "exchanged" | "signing";

export interface Qso {
  readonly stage: Stage;
  readonly them: Station;
  /** Your call, as the station copied it. Empty until it has. */
  readonly you: string;
  /** Your name, as the station copied it. Empty until it has. */
  readonly yourName: string;
  /** The station's last over, for AGN. */
  readonly last: string;
  /** How fast the station sends. */
  readonly speed: Speed;
  /** What QRS and QRQ have told it of the speed you can copy. */
  readonly search: Search;
  /** Piece by piece: the next piece of `PIECES` to send. */
  readonly piece: number;
  /** The pieces of your exchange it has copied. */
  readonly got: readonly wording.Piece[];
  /** You have sent its call back, so it is working you, even while it asks
   *  for a piece again. */
  readonly working: boolean;
}

/** How the station reads your overs. */
export interface Ear {
  readonly lenient: boolean;
  /** Your call from Configuration, or empty. Lenient copy only. */
  readonly saved: string;
}

export const STRICT: Ear = { lenient: false, saved: "" };

/** Everything an answer depends on beyond the QSO and the over. */
export interface Context {
  readonly ear?: Ear;
  /** Picks the wording. */
  readonly rand?: Rand;
  /** The station's local hour, for GM, GA or GE. */
  readonly hour?: number;
  /** How much the station says in each over. */
  readonly length?: wording.Length;
}

export interface Turn {
  readonly qso: Qso;
  /** What the station sends, or null for nothing. */
  readonly reply: string | null;
  /** The QSO is over. The next CQ is answered by a new station. */
  readonly ended: boolean;
}

/** A call: an optional letter or digit, a letter, a digit, then letters, and
 *  an optional suffix after a slash. 599 and 5NN are not calls. */
const CALL_RE = /^(?:[A-Z0-9]?[A-Z])\d[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;

/** A call after DE in words run together. Three suffix letters at most, so
 *  the next word is not taken into the call. */
const RUN_DE_RE = /DE([A-Z0-9]?[A-Z]\d[A-Z]{1,3})/g;

/** Words keyed with dits alone, which are not the error sign. */
const DIT_WORDS = new Set(["HI", "HIS", "SHE"]);

/** Dits in each character keyed with dits alone. */
const DITS: Readonly<Record<string, number>> = { E: 1, I: 2, S: 3, H: 4, "5": 5 };

/** Whether `word` is the error sign: <HH>, or a run of dits read as letters.
 *  Eight dits keyed unevenly read as EEE, or as HH, or as 5 and S. Three E,
 *  or six dits or more, counts. A word keyed with dits alone does not: HI,
 *  HIS, SHE. */
export function isErrorSign(word: string): boolean {
  if (word === "<HH>" || /^E{3,}$/.test(word)) return true;
  if (DIT_WORDS.has(word) || !/^[EISH5]+$/.test(word)) return false;
  let dits = 0;
  for (const ch of word) dits += DITS[ch]!;
  return dits >= 6;
}

/** Whether `word` is keyed with dits alone and could be part of a run of
 *  them: E, EE, I, S, 5. Words such as HI are not. */
function ditsOnly(word: string): boolean {
  return /^[EISH5]+$/.test(word) && !DIT_WORDS.has(word);
}

function ditCount(word: string): number {
  let dits = 0;
  for (const ch of word) dits += DITS[ch] ?? 0;
  return dits;
}

/** A word with the error sign keyed against it, as in EEEQSO or QEEEEEEE,
 *  split into the word and the sign. */
function unglue(word: string): string[] {
  const m = /^(.*?)(E{3,})(.*)$/.exec(word);
  if (!m || (!m[1] && !m[3])) return [word];
  return [...(m[1] ? [m[1]] : []), m[2]!, ...(m[3] ? unglue(m[3]) : [])];
}

/** The words of an over with each error sign applied: the sign and the word
 *  before it are gone.
 *
 * A run of dits keyed unevenly reads as several words, as in EEE E E. The
 * whole run is one sign when it adds up to six dits or holds a sign: it
 * drops the one word before it. A short run, as the E E that ends a QSO,
 * is kept. */
export function erased(words: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const sign = run.some(isErrorSign) || run.reduce((n, w) => n + ditCount(w), 0) >= 6;
    if (sign) out.pop();
    else out.push(...run);
    run = [];
  };
  for (const w of words.flatMap(unglue)) {
    if (w === "<HH>" || ditsOnly(w)) {
      run.push(w);
      continue;
    }
    flush();
    out.push(w);
  }
  flush();
  return out;
}

/** Words that sign off. TU is not one: it opens TU FER CALL as well. */
const CLOSING = ["73", "<SK>", "SK", "CUL", "CUAGN", "GB", "GL", "CU"];

/** Pairs of words that sign off: TNX FER QSO, TNX FB QSO. */
const CLOSING_PAIRS = ["FER QSO", "FB QSO", "TNX QSO", "FOR QSO"];

/** What signs off inside words run together. Short ones such as SK or GL
 *  turn up inside other words, so only these count. */
const CLOSING_RUN = ["73", "CUAGN", "FERQSO", "FBQSO", "TNXQSO"];

/** A signal report: 599, 579, 5NN. */
const REPORT_RE = /^[1-5][1-9N][1-9N]$/;

/** Words that sit between a label and its value: NAME HR IS BOB. */
const FILLER = new Set(["HR", "IS", "ES", "=", "<BT>"]);

/** The speed with none given: the practice page's own default. */
export const DEFAULT_SPEED: Speed = { charWpm: 25, farnsworthWpm: 25 };

/** A new QSO with a new station, never at the call `not`, sending at
 *  `speed`: your speed. */
export function newQso(rand: Rand, not = "", speed: Speed = DEFAULT_SPEED): Qso {
  return {
    stage: "cq",
    them: randomStation(rand, not),
    you: "",
    yourName: "",
    last: "",
    speed,
    search: NO_SEARCH,
    piece: 0,
    got: [],
    working: false,
  };
}

/** A request to send slower or faster, with the effective speed asked for
 *  when a number came with it. */
interface SpeedAsk {
  readonly slower: boolean;
  readonly wpm?: number;
}

/** What a word before a ? asks for. */
const ASKS_FOR: Readonly<Record<string, wording.Question>> = {
  CALL: "call",
  NAME: "name",
  NM: "name",
  OP: "name",
  QTH: "qth",
  RST: "report",
  RPT: "report",
};

/** Words the station knows, for telling an over it can read from one it
 *  cannot. Calls, reports, numbers and its own name and QTH count too. */
const KNOWN = new Set([
  "R", "RR", "RRR", "QSL", "TU", "TNX", "TKS", "FER", "FOR", "UR", "RST", "RPT", "NAME",
  "OP", "NM", "QTH", "HR", "IS", "ES", "AND", "FB", "OM", "YL", "GM", "GA", "GE", "GN", "HW",
  "CPY", "K", "KN", "BK", "AR", "SK", "DE", "CQ", "73", "88", "OK", "SOLID", "ALL", "GUD",
  "GD", "VY", "NICE", "RIG", "ANT", "PWR", "W", "WATTS", "DIPOLE", "VERT", "YAGI", "BEAM",
  "LOOP", "WX", "TEMP", "SUNNY", "CLDY", "RAIN", "SNOW", "HOT", "COLD", "WARM", "AGE", "YRS",
  "LIC", "HAM", "SINCE", "CALL", "QRZ", "QRS", "QRQ", "QSB", "QRM", "QRN", "QRP", "AGN", "PSE",
  "SRI", "GL", "CUL", "CUAGN", "GB", "HPE", "NW", "MY", "THE", "A", "I", "IN", "AT", "ON",
  "TO", "WID", "ABT", "OLD", "NEW", "KEY", "BUG", "PADDLE", "MNI", "DR", "SIG", "SIGS", "WKD",
  "QSO", "FIRST", "TIME", "RETIRED", "WORK", "SO", "BUT", "NOT", "NO", "YES", "HI", "WATT",
]);

/** How many words after DE it looks for your call. */
const DE_REACH = 4;

/** Words that start the rest of an over, after the calls. */
const DE_STOP = new Set([
  "K", "KN", "BK", "AR", "<KN>", "<BK>", "<AR>", "<BT>", "R", "RR", "TNX", "TU", "UR", "RST",
  "NAME", "QTH", "GM", "GA", "GE", "FB",
]);

/** Questions that are part of an exchange, not about what was sent. */
const NOT_QUESTIONS = new Set(["HW?", "CPY?"]);

/** Words with a ? that are not part of a call. */
const NOT_CALL = new Set(["AGN", "QRZ", "HW", "CPY", "QRS", "QRQ", "PSE", "UR", "SRI"]);

/** Words that may come with QRS or QRQ in an over that asks nothing else. */
const ASK_WORDS = new Set(["QRS", "QRQ", "PSE", "DE", "K", "KN", "BK", "AR", "<KN>", "<BK>", "<AR>", "WPM"]);

/** The words of an over. A prosign stands alone even when keyed against a
 *  word. */
export function wordsOf(heard: string): string[] {
  return heard
    .toUpperCase()
    .replace(/(<[A-Z]+>)/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isCall(word: string): boolean {
  return CALL_RE.test(word);
}

/** Whether `a` becomes `b` by changing, adding or dropping one character at
 *  most. */
export function nearly(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: string, y: string) => x.slice(i + 1) === y.slice(i + 1);
  const short = (x: string, y: string) => x.slice(i) === y.slice(i + 1);
  return a.length === b.length ? rest(a, b) : a.length < b.length ? short(a, b) : short(b, a);
}

/** HW ? and CPY ?, the ? keyed apart, put back together. A lone ? after
 *  them is part of the question, not AGN. */
function joinQuestions(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (w === "?" && (prev === "HW" || prev === "CPY")) out[out.length - 1] = `${prev}?`;
    else out.push(w);
  }
  return out;
}

/** One over, as the station reads it. */
class Over {
  readonly words: string[];
  /** The over with its spaces taken out. */
  readonly joined: string;

  constructor(
    heard: string,
    private readonly ear: Ear,
  ) {
    this.words = joinQuestions(erased(wordsOf(heard)));
    this.joined = this.words.join("");
  }

  /** Whether `word` was sent: as a word, or run into others or, for a call,
   *  one character off, when lenient. */
  has(word: string): boolean {
    if (this.words.includes(word)) return true;
    if (!this.ear.lenient) return false;
    if (this.joined.includes(word)) return true;
    return isCall(word) && this.words.some((w) => nearly(w, word));
  }

  /** Whether `word` was sent exactly: as a word or, when lenient, run into
   *  others. A call one character off does not count. */
  hasExactly(word: string): boolean {
    return this.words.includes(word) || (this.ear.lenient && this.joined.includes(word));
  }

  /** Whether the over signs off: 73, SK, CUL, GL, TNX FER QSO and the like.
   *  The same words the station signs off with. */
  closing(): boolean {
    const { words } = this;
    if (words.some((w) => CLOSING.includes(w))) return true;
    const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
    if (pairs.some((p) => CLOSING_PAIRS.includes(p))) return true;
    return this.ear.lenient && CLOSING_RUN.some((w) => this.joined.includes(w));
  }

  /** The word after the first of `labels`, past any filler. */
  after(labels: readonly string[]): string | null {
    const { words } = this;
    for (let i = 0; i < words.length; i++) {
      if (!labels.includes(words[i]!)) continue;
      let j = i + 1;
      while (j < words.length && FILLER.has(words[j]!)) j++;
      if (j < words.length) return words[j]!;
    }
    return null;
  }

  /** The calls sent after DE, each one as often as it was sent: DE W7YFR
   *  W7YFR gives it twice. A fragment left from a mistake, as the W in DE W
   *  W7YFR W7YFR, is passed over. Run-together ones too, when lenient. */
  private deCalls(them: string): string[] {
    const { words } = this;
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== "DE") continue;
      for (let j = i + 1; j < words.length && j <= i + DE_REACH; j++) {
        const w = words[j]!;
        if (isCall(w)) {
          if (!this.isThem(w, them)) out.push(w);
        } else if (DE_STOP.has(w)) break;
      }
    }
    if (out.length || !this.ear.lenient) return out;
    for (const m of this.joined.matchAll(RUN_DE_RE)) {
      if (!this.isThem(m[1]!, them)) out.push(m[1]!);
    }
    return out;
  }

  /** The call you sent after DE: the one sent most, and of those the last.
   *  A call sent wrong and then sent again right comes out right. */
  deCall(them: string): string | null {
    const calls = this.deCalls(them);
    let best: string | null = null;
    let most = 0;
    for (const c of calls) {
      const n = calls.filter((x) => x === c).length;
      if (n >= most) {
        best = c;
        most = n;
      }
    }
    return best;
  }

  /** The call you sent as your own, not `them`. */
  yourCall(them: string): string | null {
    const de = this.deCall(them);
    if (de) return de;
    const word = this.words.find((w) => isCall(w) && !this.isThem(w, them));
    if (word) return word;
    if (!this.ear.lenient) return null;
    if (this.ear.saved && this.joined.includes(this.ear.saved)) return this.ear.saved;
    return null;
  }

  private isThem(word: string, them: string): boolean {
    return word === them || (this.ear.lenient && nearly(word, them));
  }

  /** QRS or QRQ, as QRS, PSE QRS, QRS? or QRS 12. */
  speedAsk(): SpeedAsk | null {
    const { words } = this;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!.replace(/\?$/, "");
      if (w !== "QRS" && w !== "QRQ") continue;
      const n = /^(\d{1,2})(?:WPM)?$/.exec(words[i + 1] ?? "")?.[1];
      return n ? { slower: w === "QRS", wpm: Number(n) } : { slower: w === "QRS" };
    }
    if (!this.ear.lenient) return null;
    if (this.joined.includes("QRS")) return { slower: true };
    if (this.joined.includes("QRQ")) return { slower: false };
    return null;
  }

  /** Whether it asks for a speed and nothing else. */
  onlyAsks(): boolean {
    return this.words.every(
      (w) => ASK_WORDS.has(w.replace(/\?$/, "")) || w === "?" || isCall(w) || /^\d{1,2}$/.test(w),
    );
  }

  /** What it asks about one thing: part of `call` with a ?, as in N1? or
   *  N1 ?, or NAME?, QTH?, RST? or CALL?. Each once, in the order asked. The
   *  whole call with a ? is not here: see `asksAbout`. */
  questions(call: string): wording.Question[] {
    const out: wording.Question[] = [];
    const add = (q: wording.Question) => {
      if (!out.includes(q)) out.push(q);
    };
    const partOfCall = (w: string) =>
      w.length >= 2 &&
      w !== call &&
      !NOT_CALL.has(w) &&
      !(w in ASKS_FOR) &&
      (/\d/.test(w) || w.length >= 3) &&
      call.includes(w);
    const { words } = this;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === "?") {
        if (i > 0 && partOfCall(words[i - 1]!)) add("call");
        continue;
      }
      if (!w.endsWith("?")) continue;
      const bare = w.replace(/\?+$/, "");
      const asked = ASKS_FOR[bare];
      if (asked) add(asked);
      else if (partOfCall(bare)) add("call");
    }
    return out;
  }

  /** The pieces of your own exchange it holds: a report, a name, a QTH. */
  pieces(): wording.Piece[] {
    const out: wording.Piece[] = [];
    if (this.hasReport()) out.push("report");
    if (this.yourName()) out.push("name");
    if (this.qth() === "sent") out.push("qth");
    return out;
  }

  /** The pieces you began but that did not come through: a label with
   *  nothing it can read after it. UR RST 4 4 B is a report begun. */
  botched(): wording.Piece[] {
    const { words } = this;
    const out: wording.Piece[] = [];
    if (words.some((w) => w === "RST" || w === "RPT") && !this.hasReport()) out.push("report");
    if (words.some((w) => ["NAME", "OP", "NM"].includes(w)) && !this.yourName()) out.push("name");
    if (this.qth() === "botched") out.push("qth");
    return out;
  }

  /** Whether a QTH came with it: sent, begun with nothing it can read
   *  after it, or not at all. */
  private qth(): "sent" | "botched" | "none" {
    const at = this.words.indexOf("QTH");
    if (at < 0) return "none";
    const where = this.words[at + 1];
    const empty = !where || where.includes(UNKNOWN) || ["K", "KN", "BK", "<KN>", "<BK>"].includes(where);
    return empty ? "botched" : "sent";
  }

  /** Whether it names a station other than `them` and `you`. */
  namesOther(them: string, you: string): boolean {
    return this.words.some(
      (w) => isCall(w) && w !== you && !this.isThem(w, them) && !(this.ear.lenient && nearly(w, them)),
    );
  }

  /** Whether it acknowledges: R, QSL, TNX, FB, OK and the like. */
  acknowledges(): boolean {
    return this.words.some((w) => ["R", "RR", "RRR", "QSL", "TU", "TNX", "FB", "OK", "SOLID"].includes(w));
  }

  /** Whether it asks something the station cannot place: a word with a ?
   *  that is none of AGN?, HW? or the questions it answers. */
  puzzles(): boolean {
    return this.words.some((w) => w.endsWith("?") && w !== "?" && !NOT_QUESTIONS.has(w));
  }

  /** Whether the station can read it: most of its words are words it knows.
   *  The words after NAME, OP and QTH count, whatever they are. */
  readable(them: Station): boolean {
    const { words } = this;
    if (words.length === 0) return false;
    const theirs = new Set([...them.name.split(" "), ...them.qth.split(" ")]);
    let known = 0;
    let free = 0;
    for (const w of words) {
      const bare = w.replace(/\?+$/, "");
      if (this.knows(bare) || theirs.has(bare)) known++;
      else if (free > 0) known++;
      // Filler, as the HR IS in NAME HR IS BOB, leaves the free words for
      // what comes after it.
      if (free > 0 && !FILLER.has(bare)) free--;
      if (["NAME", "OP", "NM"].includes(bare)) free = 1;
      else if (bare === "QTH") free = 3;
    }
    return known * 2 >= words.length;
  }

  /** Whether `word` is one the station knows. Lenient, words run together
   *  count when they split into known words, or hold a call. */
  private knows(word: string): boolean {
    if (word.includes(UNKNOWN)) return false;
    if (word === "" || KNOWN.has(word) || isCall(word) || REPORT_RE.test(word)) return true;
    // Prosigns, and words with a digit: a rig, a power, a time.
    if (/^<[A-Z]+>$/.test(word) || /\d/.test(word)) return true;
    if (!this.ear.lenient) return false;
    if (/[A-Z0-9]?[A-Z]\d[A-Z]{1,3}/.test(word)) return true;
    // Split into known words, shortest pieces first.
    const ok = new Array<boolean>(word.length + 1).fill(false);
    ok[0] = true;
    for (let i = 1; i <= word.length; i++) {
      for (let j = Math.max(0, i - 7); j < i && !ok[i]; j++) {
        if (ok[j] && KNOWN.has(word.slice(j, i))) ok[i] = true;
      }
    }
    return ok[word.length]!;
  }

  /** Whether it holds a report. */
  hasReport(): boolean {
    return this.words.some((w) => REPORT_RE.test(w));
  }

  /** Whether it asks if `call` is right: the call with a ? on it or right
   *  after it, and no report. A HW? at the end of an exchange is not it. */
  asksAbout(call: string): boolean {
    if (this.hasReport()) return false;
    const { words, ear } = this;
    const i = words.findIndex((w) => {
      const bare = w.endsWith("?") ? w.slice(0, -1) : w;
      return bare === call || (ear.lenient && nearly(bare, call));
    });
    if (i >= 0) return words[i]!.endsWith("?") || words[i + 1] === "?";
    return ear.lenient && this.joined.includes(`${call}?`);
  }

  yourName(): string {
    const name = this.after(["NAME", "NM", "OP"]);
    return name && /^[A-Z]{2,}$/.test(name) ? name : "";
  }

}

/** The pieces of its exchange the station has sent so far. */
function sentPieces(qso: Qso): readonly wording.Piece[] {
  if (qso.stage === "pieces") return wording.PIECES.slice(0, qso.piece);
  return qso.stage === "exchanged" ? wording.PIECES : [];
}

function say(qso: Qso, reply: string, stage: Stage = qso.stage): Turn {
  return { qso: { ...qso, stage, last: reply }, reply, ended: false };
}

function end(qso: Qso, reply: string): Turn {
  return { qso: { ...qso, last: reply }, reply, ended: true };
}

/** The station's answer to one over you sent. */
export function answer(qso: Qso, heard: string, context: Context = {}): Turn {
  const {
    ear = STRICT,
    rand = Math.random,
    hour = new Date().getHours(),
    length = "full",
  } = context;
  const over = new Over(heard, ear);
  const { them } = qso;
  // HW? asks how you copied, so it is not a request to send again.
  const again = over.has("AGN") || over.words.some((w) => ["?", "AGN?", "QRZ?"].includes(w));
  const voice = (q: Qso): wording.Say => ({
    them,
    you: q.you,
    name: q.yourName,
    rand,
    hour,
    length,
  });

  // Your call after DE, once the station has one, replaces it.
  const fixed = qso.stage === "cq" || qso.stage === "asking" ? null : over.deCall(them.call);
  if (fixed) qso = { ...qso, you: fixed };

  // QRS or QRQ, once the station has sent something. QRS, or a request with
  // nothing else in it, gets the last over again at the new speed. QRQ with
  // more in the over is answered as usual, faster.
  const ask = qso.last ? over.speedAsk() : null;
  if (ask) {
    const moved =
      ask.wpm !== undefined
        ? { speed: setTo(qso.speed, ask.wpm), search: NO_SEARCH }
        : ask.slower
          ? qrs(qso.speed, qso.search)
          : qrq(qso.speed, qso.search);
    const stuck =
      moved.speed.charWpm === qso.speed.charWpm &&
      moved.speed.farnsworthWpm === qso.speed.farnsworthWpm;
    qso = { ...qso, ...moved };
    // At the top or bottom step, a request alone gets SRI, not the same over.
    if (stuck && over.onlyAsks()) {
      return { qso, reply: wording.cannotChange(voice(qso), ask.slower), ended: false };
    }
    if (ask.slower || over.onlyAsks()) return { qso, reply: qso.last, ended: false };
  }

  if (qso.stage !== "cq" && qso.stage !== "asking") {
    // Your name, and each piece of your exchange, whenever you send them.
    const name = over.yourName();
    if (name) qso = { ...qso, yourName: name };
    const got = over.pieces().filter((p) => !qso.got.includes(p));
    if (got.length) qso = { ...qso, got: [...qso.got, ...got] };
    // A question about one thing gets that thing. Not kept as the last over,
    // so AGN after it still means the over before.
    const asked = over.questions(them.call);
    if (asked.length) return { qso, reply: wording.answers(voice(qso), asked), ended: false };
  }

  switch (qso.stage) {
    case "cq":
    case "asking": {
      // Nobody answers an over that is not a CQ, until the station has asked.
      if (qso.stage === "cq" && !over.has("CQ")) return { qso, reply: null, ended: false };
      const you = over.yourCall(them.call);
      if (!you) return say(qso, wording.askCall(voice(qso)), "asking");
      const next = { ...qso, you };
      return say(next, wording.callBack(voice(next)), "called");
    }

    case "called": {
      // Its call confirmed at your asking: from here you are working it, and
      // your next over need not carry its call.
      if (over.asksAbout(them.call)) {
        return say({ ...qso, working: true }, wording.confirmCall(voice(qso)));
      }
      // Its call one character off: it puts you right, and waits.
      const heard = over.hasExactly(them.call);
      if (!heard && !qso.working && over.has(them.call)) {
        return say(qso, wording.correctCall(voice(qso)));
      }
      // Your report, name or QTH, begun or sent, with no other station named:
      // nobody else is on the frequency, so you are working this one.
      const exchanging =
        (over.pieces().length > 0 || over.botched().length > 0) &&
        !over.namesOther(them.call, qso.you);
      if (heard || qso.working || exchanging) {
        qso = { ...qso, working: true };
        // AGN alone. With its call and more, the over is your exchange.
        if (again && !heard) return say(qso, qso.last);
        // Sent without its call, it has to be an over it can read.
        if (!heard && !over.readable(them)) return say(qso, wording.askAgain(voice(qso)));
        const botched = over.botched().filter((p) => !qso.got.includes(p));
        if (botched.length) return say(qso, wording.askFor(voice(qso), botched));
        // Thanks for your report, sent in this over or one before it.
        const reply = wording.exchange(voice(qso), qso.got.includes("report"));
        if (length === "pieces") return say({ ...qso, piece: 1 }, reply, "pieces");
        return say(qso, reply, "exchanged");
      }
      return say(qso, wording.callAgain(voice(qso)));
    }

    case "pieces":
    case "exchanged": {
      if (over.closing()) return end(qso, wording.signOff(voice(qso)));
      // The current part again, for AGN or a question it cannot place.
      if (again || over.puzzles()) return say(qso, qso.last);
      // Neither of these is kept as the last over, so AGN after one still
      // means the part it is on.
      const hold = (reply: string): Turn => ({ qso, reply, ended: false });
      if (!over.readable(them)) return hold(wording.askAgain(voice(qso)));
      const missing = sentPieces(qso).filter((p) => !qso.got.includes(p));
      if (missing.length) {
        return hold(wording.askFor(voice(qso), qso.stage === "pieces" ? missing.slice(0, 1) : missing));
      }
      if (qso.stage === "pieces" && qso.piece < wording.PIECES.length) {
        const open = over.pieces().length || over.acknowledges() ? wording.gotPiece(voice(qso)) : "";
        return say({ ...qso, piece: qso.piece + 1 }, wording.piece(voice(qso), qso.piece, open));
      }
      return say(qso, wording.signFirst(voice(qso)), "signing");
    }

    case "signing":
      if (again && !over.closing()) return say(qso, qso.last);
      return end(qso, wording.lastDits(voice(qso)));
  }
}
