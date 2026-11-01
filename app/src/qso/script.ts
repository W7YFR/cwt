/* A QSO from a script you give: both sides, line by line.
 *
 * The station sends its lines word for word. Your lines are what it waits
 * for. When your over is your next line, it sends its next one. When it is
 * not, it asks again. Strict copy needs every word of your line, in order.
 * Lenient copy needs both calls, and most of the rest: words run together
 * or keyed apart count.
 *
 * Lines in a row from one side go as one over. AGN or ? gets the station's
 * last over again, and QRS and QRQ work as in a standard QSO. The QSO ends
 * on the last line, yours or the station's.
 *
 * Who sends each line, and the notes in it, come from copy/text.ts, as on
 * the Copy page's Script.
 *
 * Pure.
 */

import { fillText, guessStations, linesOf, stationsOf } from "@/copy/text";
import type { UserInfo } from "@/io/storage";
import { Over, STRICT, isCall, pace, wordsOf, type Context } from "./cq";
import { NO_SEARCH, type Search, type Speed } from "./speed";
import { pick, type Station } from "./station";

/** One line of the script: yours, or the station's, with the notes filled
 *  in that can be. */
export interface ScriptLine {
  readonly you: boolean;
  readonly text: string;
}

export interface ScriptQso {
  readonly script: true;
  /** "script" while the lines go on, "done" once the last has gone. */
  readonly stage: "script" | "done";
  readonly lines: readonly ScriptLine[];
  /** The next line to send, yours or the station's. */
  readonly at: number;
  readonly them: Station;
  /** Your call, from the script. Empty when it has none. */
  readonly you: string;
  /** The station's last over, for AGN. */
  readonly last: string;
  readonly speed: Speed;
  readonly search: Search;
  /** What it sent to ask you again, which is not kept as `last`. Empty when
   *  its last over was not that. */
  readonly asked: string;
  /** What you sent in place of each note not filled in, as (YOUR NAME): the
   *  station uses it in its own lines, and your later lines need it. */
  readonly heard: Readonly<Record<string, string>>;
}

export function isScript(qso: object): qso is ScriptQso {
  return "script" in qso;
}

export interface ScriptTurn {
  readonly qso: ScriptQso;
  readonly reply: string | null;
  readonly ended: boolean;
}

/** The station's tone, as a generated QSO's first station. */
const TONE_HZ = 600;

/** A script QSO from `text`, with you as station `you` (0 or 1) and each
 *  line's station as `picks` sets it. Null when it has no line to send. */
export function newScript(
  text: string,
  options: { picks: readonly (number | null)[]; you: 0 | 1; user: UserInfo; speed: Speed },
): ScriptQso | null {
  const raw = linesOf(text);
  if (raw.length === 0) return null;
  const stations = stationsOf(raw, options.picks);
  const { calls } = guessStations(raw);
  const callOf = (s: number) => {
    const call = fillText(calls[s] ?? "", options.user);
    return call.includes("(") ? "" : call;
  };
  const other = options.you === 0 ? 1 : 0;
  return {
    script: true,
    stage: "script",
    lines: raw.map((l, i) => ({ you: stations[i] === options.you, text: fillText(l, options.user) })),
    at: 0,
    them: { call: callOf(other), name: "", qth: "", rst: "599", toneHz: TONE_HZ },
    you: callOf(options.you),
    last: "",
    asked: "",
    heard: {},
    speed: options.speed,
    search: NO_SEARCH,
  };
}

/** Which station is you, as the text says: the one whose call is `call` or
 *  the note (your call). With neither, the one that does not send first. */
export function youIn(text: string, call: string): 0 | 1 {
  const lines = linesOf(text);
  const { stations, calls } = guessStations(lines);
  const mine = calls.findIndex((c) => c === "(YOUR CALL)" || (call !== "" && c === call.toUpperCase()));
  if (mine === 0 || mine === 1) return mine;
  return stations[0] === 0 ? 1 : 0;
}

/** The lines from `at` on that one side sends in a row, as one over, and
 *  where the next side's begin. */
function overAt(qso: ScriptQso, at: number): { text: string; next: number } {
  const you = qso.lines[at]?.you;
  let next = at;
  while (next < qso.lines.length && qso.lines[next]!.you === you) next++;
  return { text: qso.lines.slice(at, next).map((l) => l.text).join(" "), next };
}

/** Whether the station sends next: at the start, when its line comes
 *  first. */
export function stationFirst(qso: ScriptQso): boolean {
  return qso.stage === "script" && qso.lines[qso.at]?.you === false;
}

/** A note in brackets, as (YOUR NAME). */
const NOTE_RE = /\([^)]*\)/g;

/** `text` with each note you have sent filled in, and the rest left. */
function withHeard(text: string, heard: Readonly<Record<string, string>>): string {
  return text.replace(NOTE_RE, (note) => heard[note] ?? note);
}

/** Your next over, as the script has it, or null when the station sends
 *  next or the script is done. */
export function yourLine(qso: ScriptQso): string | null {
  if (qso.stage !== "script" || !qso.lines[qso.at]?.you) return null;
  return withHeard(overAt(qso, qso.at).text, qso.heard);
}

/** The station sends its lines from where the script is. A note in them is
 *  what you sent in its place, or left out: it never keys a note. */
function sendTheirs(qso: ScriptQso): ScriptTurn {
  const over = overAt(qso, qso.at);
  const next = over.next;
  const text = withHeard(over.text, qso.heard).replace(NOTE_RE, "").split(/\s+/).filter(Boolean).join(" ");
  const done = next >= qso.lines.length;
  return {
    qso: { ...qso, at: next, last: text, asked: "", stage: done ? "done" : "script" },
    reply: text,
    ended: done,
  };
}

/** The station opens the QSO, when the script starts with its line. */
export function openScript(qso: ScriptQso): ScriptTurn {
  return sendTheirs(qso);
}

/** Words as compared: prosigns as their letters, and a ? on its own word
 *  joined to the word before. A note not filled in, as (YOUR QTH), stands
 *  for whatever you send there. */
function compared(text: string): string[] {
  const words = wordsOf(text.replace(/\s+\?/g, "?")).map((w) => w.replace(/[<>]/g, ""));
  return words;
}

/** A word of your line, or a note not filled in, which stands for whatever
 *  you send there. */
type Want = string | { readonly note: string };

/** Your line's words and notes. A note twice in a row, as (YOUR CALL)
 *  (YOUR CALL), is one. */
function expected(line: string): Want[] {
  const out: Want[] = [];
  for (const piece of line.match(/\([^)]*\)|[^\s(]+/g) ?? []) {
    if (piece.startsWith("(")) {
      const last = out.at(-1);
      if (typeof last !== "object" || last.note !== piece) out.push({ note: piece });
    } else out.push(...compared(piece));
  }
  return out;
}

const wordsIn = (want: readonly Want[]): string[] => want.filter((w): w is string => typeof w === "string");

/** What you sent in place of each note of your line: the words up to the
 *  next word of the line, three at most. For (YOUR CALL), the call. A note
 *  sent twice, as BOISE ID BOISE ID, once. */
function notesIn(want: readonly Want[], sent: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let j = 0;
  want.forEach((w, k) => {
    if (typeof w === "string") {
      const at = sent.indexOf(w, j);
      if (at >= 0) j = at + 1;
      return;
    }
    const after = want.slice(k + 1).find((x): x is string => typeof x === "string");
    const end = after === undefined ? sent.length : sent.indexOf(after, j);
    let words = sent.slice(j, end < 0 ? j + 1 : end);
    if (w.note === "(YOUR CALL)") words = words.filter(isCall).slice(0, 1);
    const half = words.length / 2;
    if (half >= 1 && Number.isInteger(half) && words.slice(0, half).join(" ") === words.slice(half).join(" ")) {
      words = words.slice(0, half);
    }
    words = words.slice(0, 3);
    if (words.length) out[w.note] = words.join(" ");
    j += words.length;
  });
  return out;
}

/** Strict: every word of your line, in order. Other words between them, as
 *  an error sign, are let go. */
function strictMatch(want: readonly Want[], sent: readonly string[]): boolean {
  let j = 0;
  for (const w of wordsIn(want)) {
    while (j < sent.length && sent[j] !== w) j++;
    if (j === sent.length) return false;
    j++;
  }
  return true;
}

/** The longest run of characters `a` and `b` share in order. */
function common(a: string, b: string): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
      diag = up;
    }
  }
  return row[b.length]!;
}

/** How much of your line Lenient copy needs, by its characters in order. */
const ENOUGH = 0.75;

/** Lenient: each call of your line, sent whole or run into other words,
 *  and most of its characters, in order. Spaces do not count. */
function lenientMatch(want: readonly Want[], sent: readonly string[]): boolean {
  const joined = sent.join("");
  const calls = wordsIn(want).filter(isCall);
  if (!calls.every((c) => joined.includes(c))) return false;
  const all = wordsIn(want).join("");
  if (all.length === 0) return true;
  return common(all, joined) / all.length >= ENOUGH;
}

/** Whether `over` asks for the last over again: AGN, ? or AGN?, and not
 *  your line. */
function asksAgain(over: Over): boolean {
  return over.has("AGN") || over.words.some((w) => ["?", "AGN?", "QRZ?"].includes(w));
}

/** What the station sends when your over is not your line. Never the same
 *  twice running. */
const ASK_AGAIN = ["AGN?", "PSE AGN", "?", "AGN AGN?"];

/** The station's answer to one over you sent. */
export function answerScript(qso: ScriptQso, heard: string, context: Context = {}): ScriptTurn {
  const { ear = STRICT, rand = Math.random } = context;
  const over = new Over(heard, ear);
  if (qso.stage === "done") return { qso, reply: null, ended: true };

  const paced = pace(qso, over, (slower) => `SRI NO ${slower ? "QRS" : "QRQ"}`);
  if (paced?.reply) return { qso: paced.qso, reply: paced.reply, ended: false };
  if (paced) qso = paced.qso;

  const mine = yourLine(qso);
  // The station's turn, as when a reload came back before it sent: it
  // sends now.
  if (mine === null) return sendTheirs(qso);

  const want = expected(mine);
  const sent = compared(heard);
  const right = ear.lenient ? lenientMatch(want, sent) : strictMatch(want, sent);
  if (!right) {
    if (asksAgain(over) && qso.last) return { qso: { ...qso, asked: "" }, reply: qso.last, ended: false };
    const ask = pick(rand, ASK_AGAIN.filter((a) => a !== qso.asked));
    return { qso: { ...qso, asked: ask }, reply: ask, ended: false };
  }

  const { next } = overAt(qso, qso.at);
  const notes = { ...qso.heard, ...notesIn(want, sent) };
  const moved = { ...qso, at: next, asked: "", heard: notes, you: qso.you || (notes["(YOUR CALL)"] ?? "") };
  if (next >= qso.lines.length) return { qso: { ...moved, stage: "done" }, reply: null, ended: true };
  return sendTheirs(moved);
}
