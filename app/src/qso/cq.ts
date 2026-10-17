/* A QSO that starts with your CQ, run as a script.
 *
 * You call CQ, a station answers, you send the exchange, it sends its own,
 * and you sign. Each over you send is read as copied, and the station answers
 * what it heard. A mistake never ends the QSO. The station asks again, the
 * way an operator would:
 *
 *   - a CQ with no call it can read gets CALL?;
 *   - its call with a question mark gets its call confirmed;
 *   - an over without its call gets its call again;
 *   - your call after DE replaces the one it copied before;
 *   - part of its call with a ?, as in N1?, gets its call. NAME?, QTH?, RST?
 *     and CALL? get that one thing. None of these moves the QSO on;
 *   - QRS gets its last over again, slower, and QRQ makes it faster (see
 *     speed.ts). The new speed holds until you ask again;
 *   - AGN or ? gets its last over again;
 *   - an exchange it cannot read gets PSE AGN;
 *   - an exchange with no 73 gets its own 73, and the QSO ends on yours.
 *
 * Strict copy reads the words as they were spaced and needs each call sent
 * exactly. Lenient copy also finds words run together, takes a call one
 * character off as the call, and knows your call from Configuration.
 *
 * Piece by piece, the exchange comes one item per over: report, name, QTH.
 * It moves on after any over from you, and starts with R, TNX or FB when
 * your over held a piece of your own exchange.
 *
 * It thanks you for a report only when your over held one. What it says is
 * worded in wording.ts, a little differently each time.
 *
 * Pure. The page plays the replies and reads your overs.
 */

import { UNKNOWN } from "@/morse";
import { faster, setTo, slower, type Speed } from "./speed";
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
  /** Piece by piece: the next piece of `PIECES` to send. */
  readonly piece: number;
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

/** The words of an over with each error sign applied: the sign and the word
 *  before it are gone. */
export function erased(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (isErrorSign(w)) out.pop();
    else out.push(w);
  }
  return out;
}

const CLOSING = ["73", "<SK>", "SK", "CUL", "CUAGN", "GB"];

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
    piece: 0,
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

/** One over, as the station reads it. */
class Over {
  readonly words: string[];
  /** The over with its spaces taken out. */
  readonly joined: string;

  constructor(
    heard: string,
    private readonly ear: Ear,
  ) {
    this.words = erased(wordsOf(heard));
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

  /** Whether the over signs off. Run together, only 73 counts: SK or GB
   *  turn up inside other words. */
  closing(): boolean {
    return this.words.some((w) => CLOSING.includes(w)) || (this.ear.lenient && this.joined.includes("73"));
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
   *  W7YFR gives it twice. Run-together ones too, when lenient. */
  private deCalls(them: string): string[] {
    const { words } = this;
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== "DE") continue;
      for (let j = i + 1; j < words.length && isCall(words[j]!); j++) {
        if (!this.isThem(words[j]!, them)) out.push(words[j]!);
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

  /** Whether it holds a piece of your own exchange: a report, a name or a
   *  QTH. */
  holdsPiece(): boolean {
    return this.hasReport() || this.yourName() !== "" || this.words.includes("QTH");
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

  /** Nothing in it, or most of its words hold a character that read as
   *  nothing. */
  garbled(): boolean {
    const bad = this.words.filter((w) => w.includes(UNKNOWN)).length;
    return this.words.length === 0 || bad * 2 >= this.words.length;
  }
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
    const speed =
      ask.wpm !== undefined
        ? setTo(qso.speed, ask.wpm)
        : ask.slower
          ? slower(qso.speed)
          : faster(qso.speed);
    qso = { ...qso, speed };
    if (ask.slower || over.onlyAsks()) return { qso, reply: qso.last, ended: false };
  }

  if (qso.stage !== "cq" && qso.stage !== "asking") {
    // Your name, whenever you send it.
    const name = over.yourName();
    if (name) qso = { ...qso, yourName: name };
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
      if (over.asksAbout(them.call)) return say(qso, wording.confirmCall(voice(qso)));
      if (over.has(them.call)) {
        const reply = wording.exchange(voice(qso), over.hasReport());
        if (length === "pieces") return say({ ...qso, piece: 1 }, reply, "pieces");
        return say(qso, reply, "exchanged");
      }
      return say(qso, wording.callAgain(voice(qso)));
    }

    case "pieces": {
      if (over.closing()) return end(qso, wording.signOff(voice(qso)));
      if (again) return say(qso, qso.last);
      if (over.garbled()) return { qso, reply: wording.askAgain(voice(qso)), ended: false };
      const open = over.holdsPiece() ? wording.gotPiece(voice(qso)) : "";
      const next = { ...qso, piece: qso.piece + 1 };
      const done = next.piece >= wording.PIECES.length;
      return say(next, wording.piece(voice(qso), qso.piece, open), done ? "exchanged" : "pieces");
    }

    case "exchanged": {
      if (over.closing()) return end(qso, wording.signOff(voice(qso)));
      if (again) return say(qso, qso.last);
      // Not kept as the last over: AGN after it still means the exchange.
      if (over.garbled()) return { qso, reply: wording.askAgain(voice(qso)), ended: false };
      return say(qso, wording.signFirst(voice(qso)), "signing");
    }

    case "signing":
      if (again && !over.closing()) return say(qso, qso.last);
      return end(qso, wording.lastDits(voice(qso)));
  }
}
