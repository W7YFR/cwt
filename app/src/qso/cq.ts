/* A QSO that starts with your CQ, run as a script.
 *
 * You call CQ, a station answers, you send the exchange, it sends its own,
 * and you sign. Each over you send is read as copied, and the station answers
 * what it heard. A mistake never ends the QSO. The station asks again, the
 * way an operator would:
 *
 *   - a CQ with no call it can read gets CALL?;
 *   - an over without its call gets its call again;
 *   - AGN or ? gets its last over again;
 *   - an exchange it cannot read gets PSE AGN;
 *   - an exchange with no 73 gets its own 73, and the QSO ends on yours.
 *
 * Strict copy reads the words as they were spaced and needs each call sent
 * exactly. Lenient copy also finds words run together, takes a call one
 * character off as the call, and knows your call from Configuration.
 *
 * Pure. The page plays the replies and reads your overs.
 */

import { UNKNOWN } from "@/morse";
import { randomStation, type Rand, type Station } from "./station";

export type Stage = "cq" | "asking" | "called" | "exchanged" | "signing";

export interface Qso {
  readonly stage: Stage;
  readonly them: Station;
  /** Your call, as the station copied it. Empty until it has. */
  readonly you: string;
  /** Your name, as the station copied it. Empty until it has. */
  readonly yourName: string;
  /** The station's last over, for AGN. */
  readonly last: string;
}

/** How the station reads your overs. */
export interface Ear {
  readonly lenient: boolean;
  /** Your call from Configuration, or empty. Lenient copy only. */
  readonly saved: string;
}

export const STRICT: Ear = { lenient: false, saved: "" };

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
const RUN_DE_RE = /DE([A-Z0-9]?[A-Z]\d[A-Z]{1,3})/;

const CLOSING = ["73", "<SK>", "SK", "CUL", "CUAGN", "GB"];

/** Words that sit between a label and its value: NAME HR IS BOB. */
const FILLER = new Set(["HR", "IS", "ES", "=", "<BT>"]);

export function newQso(rand: Rand, not = ""): Qso {
  return { stage: "cq", them: randomStation(rand, not), you: "", yourName: "", last: "" };
}

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
    this.words = wordsOf(heard);
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

  /** The call you sent as your own, not `them`. */
  yourCall(them: string): string | null {
    const de = this.after(["DE"]);
    if (de && isCall(de) && !this.isThem(de, them)) return de;
    const word = this.words.find((w) => isCall(w) && !this.isThem(w, them));
    if (word) return word;
    if (!this.ear.lenient) return null;
    if (this.ear.saved && this.joined.includes(this.ear.saved)) return this.ear.saved;
    const run = RUN_DE_RE.exec(this.joined)?.[1];
    return run && !this.isThem(run, them) ? run : null;
  }

  private isThem(word: string, them: string): boolean {
    return word === them || (this.ear.lenient && nearly(word, them));
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

function exchange(q: Qso): string {
  const { them, you, yourName: name } = q;
  const to = name ? ` ${name}` : "";
  return (
    `${you} DE ${them.call} R TNX FER RPT${to} UR RST ${them.rst} ${them.rst} ` +
    `NAME ${them.name} ${them.name} QTH ${them.qth} ${them.qth} HW? ${you} DE ${them.call} KN`
  );
}

function say(qso: Qso, reply: string, stage: Stage = qso.stage): Turn {
  return { qso: { ...qso, stage, last: reply }, reply, ended: false };
}

function end(qso: Qso, reply: string): Turn {
  return { qso: { ...qso, last: reply }, reply, ended: true };
}

/** The station's answer to one over you sent. */
export function answer(qso: Qso, heard: string, ear: Ear = STRICT): Turn {
  const over = new Over(heard, ear);
  const { them } = qso;
  const again = over.has("AGN") || over.words.some((w) => /^[A-Z]*\?$/.test(w));

  switch (qso.stage) {
    case "cq":
    case "asking": {
      // Nobody answers an over that is not a CQ, until the station has asked.
      if (qso.stage === "cq" && !over.has("CQ")) return { qso, reply: null, ended: false };
      const you = over.yourCall(them.call);
      if (!you) return say(qso, `CALL? DE ${them.call} K`, "asking");
      return say({ ...qso, you }, `${you} DE ${them.call} ${them.call} K`, "called");
    }

    case "called": {
      if (over.has(them.call)) {
        const next = { ...qso, yourName: over.yourName() || qso.yourName };
        return say(next, exchange(next), "exchanged");
      }
      return say(qso, `DE ${them.call} ${them.call} K`);
    }

    case "exchanged": {
      if (over.closing()) {
        const to = qso.yourName ? ` ${qso.yourName}` : "";
        return end(qso, `TU${to} 73 GL ${qso.you} DE ${them.call} <SK> E E`);
      }
      if (again) return say(qso, qso.last);
      // Not kept as the last over: AGN after it still means the exchange.
      if (over.garbled()) {
        return { qso, reply: `PSE AGN ${qso.you} DE ${them.call} KN`, ended: false };
      }
      const to = qso.yourName ? ` ${qso.yourName}` : "";
      return say(
        qso,
        `R R FB${to} TNX FER QSO HPE CUAGN 73 ${qso.you} DE ${them.call} <SK>`,
        "signing",
      );
    }

    case "signing":
      if (again && !over.closing()) return say(qso, qso.last);
      return end(qso, "E E");
  }
}
