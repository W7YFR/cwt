/* A QSO from text you give the Copy page: pasted, typed or opened from a file.
 *
 * Each line of text is a line on the page. Blank lines only space the text
 * out. Which station sends each line comes from the text itself:
 *
 * - A line with `DE <call>` is sent by that call.
 * - Any other line is sent by the station of the line before, unless that
 *   line ended its turn, with K, KN, BK, SK, AR, a `?` or `E E`. Then the
 *   other station sends it.
 *
 * You can change the station of any line. Two lines in a row from one
 * station play with a short pause between them, not the gap between turns.
 *
 * Notes in brackets, such as "(your call)", and slots, such as `{name}`, fill
 * from the user's details, as drills do.
 *
 * Pure.
 */

import { slotsForNote, SLOTS, type Slot } from "@/drills";
import type { UserInfo } from "@/io/storage";
import { CHAR_TO_MORSE, tokenize } from "@/morse";
import type { Speed } from "@/qso/speed";
import type { Script } from "./generate";

/** The pitches of the two stations, in Hz. */
const TONES_HZ: readonly [number, number] = [600, 700];

/** The lines of `text` to send, each upper case with single spaces. A line
 *  with no Morse in it is left out. */
export function linesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.toUpperCase().trim().split(/\s+/).join(" "))
    .filter((l) => tokenize(l).some((t) => t in CHAR_TO_MORSE));
}

/** The station a line names after DE: a call, or a note such as
 *  "(YOUR CALL)". */
const DE_RE = /(?:^|\s)DE (\([^)]*\)|[A-Z0-9/]+)/;

/** A line that ends its station's turn. */
const ENDS_TURN_RE = /(?:\?|(?:^|\s)(?:K|KN|BK|SK|AR|<SK>|<KN>|<AR>|<BK>|E E))$/;

/** Who sends each line, as the text says, and the call of each station
 *  where a line names it. */
export function guessStations(lines: readonly string[]): { stations: (0 | 1)[]; calls: [string, string] } {
  const calls: [string, string] = ["", ""];
  const stations: (0 | 1)[] = [];
  lines.forEach((line, i) => {
    const prev = stations[i - 1] ?? 0;
    const next: 0 | 1 = i > 0 && ENDS_TURN_RE.test(lines[i - 1]!) ? (prev === 0 ? 1 : 0) : prev;
    const call = DE_RE.exec(line)?.[1];
    let at = next;
    if (call) {
      const known = calls.indexOf(call);
      if (known >= 0) at = known as 0 | 1;
      else if (!calls[next]) calls[next] = call;
      else if (!calls[next === 0 ? 1 : 0]) calls[(at = next === 0 ? 1 : 0)] = call;
    }
    stations.push(at);
  });
  return { stations, calls };
}

/** Who sends each line: as you set it, or as the text says. */
export function stationsOf(lines: readonly string[], picks: readonly (number | null)[] = []): (0 | 1)[] {
  const guess = guessStations(lines).stations;
  return guess.map((s, i) => (picks[i] === 0 || picks[i] === 1 ? picks[i] : s));
}

const NOTE_RE = /\(([^()\n]*)\)/g;
const SLOT_RE = /\{([a-z_]+)\}/gi;

const isSlot = (s: string): s is Slot => Object.hasOwn(SLOTS, s);

/** `text` with each note and slot that names a set user detail replaced by
 *  its value. One with no value stays as it is. Line breaks stay. */
export function fillText(text: string, user: UserInfo): string {
  const value = (slots: readonly Slot[]): string | null => {
    const values = slots.map((s) => user[SLOTS[s]].trim());
    return values.every(Boolean) ? values.join(" ") : null;
  };
  return text
    .replace(NOTE_RE, (whole, note: string) => {
      const slots = slotsForNote(note);
      return (slots && value(slots)) ?? whole;
    })
    .replace(SLOT_RE, (whole, name: string) => {
      const slot = name.toLowerCase();
      return (isSlot(slot) && value([slot])) || whole;
    });
}

/** The symbols in `text` with no Morse, each once. They are left out when
 *  it is sent. */
export function unkeyable(text: string): string[] {
  return [...new Set(tokenize(text).filter((t) => t !== " " && !(t in CHAR_TO_MORSE)))];
}

export interface TextOptions {
  /** What the page calls it: the file's name, or a word for pasted text. */
  readonly title: string;
  /** The station you set for each line of `linesOf(text)`, or null where the
   *  text says. */
  readonly picks: readonly (number | null)[];
  readonly speed: Speed;
  readonly user: UserInfo;
}

/** A script of `text`, as typed, or null when it has nothing to send. */
export function textScript(text: string, options: TextOptions): Script | null {
  const lines = linesOf(text);
  if (lines.length === 0) return null;
  const stations = stationsOf(lines, options.picks);
  const n = stations.includes(1) ? 2 : 1;
  const { calls } = guessStations(lines);
  // A call only once its note is filled in: a note in brackets is no call.
  const callOf = (s: number) => {
    const call = fillText(calls[s]!, options.user);
    return call.includes("(") ? "" : call;
  };
  return {
    kind: "text",
    title: options.title,
    source: text,
    picks: options.picks,
    stations: TONES_HZ.slice(0, n).map((toneHz, s) => ({ call: callOf(s), toneHz, speed: options.speed })),
    lines: lines.map((l, i) => ({ station: stations[i]!, text: fillText(l, options.user) })),
  };
}
