/* The sender's speed, from the latest marks and gaps, and the characters it
 * reads them as.
 *
 * No set speed is used. The marks fall into dits and dahs, and the dit is the
 * unit. The gaps then fall into three kinds by that unit: inside a character,
 * between characters, and between words. A bug's long dahs and a straight
 * key's heavy weight move the cuts, so each cut sits between the kinds this
 * sender actually keys, within limits.
 *
 * Pure.
 */

import { MORSE_TO_CHAR, UNKNOWN } from "@/morse";
import type { Run } from "./channel";

/** A sender's timing, measured. All in seconds. */
export interface Pace {
  /** The dit. */
  readonly unit: number;
  /** A mark longer than this is a dah. */
  readonly dahOver: number;
  /** A gap longer than this ends the character. */
  readonly charOver: number;
  /** A gap longer than this ends the word. */
  readonly wordOver: number;
  /** Character speed, WPM. */
  readonly wpm: number;
}

/** The fastest and slowest dits read, seconds: 60 and 5 WPM. */
const MIN_UNIT = 0.02;
const MAX_UNIT = 0.24;
/** A dah is at least this many dits long. Closer than this, the marks are
 *  all one kind. */
const MIN_DAH_RATIO = 1.9;
/** A mark shorter than this share of the typical mark is a glitch. */
const GLITCH_SHARE = 0.25;
/** A mark shorter than this share of a dit is a glitch. */
const GLITCH_UNITS = 0.3;
/** Letter gaps and word gaps are two kinds when the longer are at least
 *  this many times the shorter. */
const WORD_RATIO = 1.6;
/** With one kind, a word gap is at least this many times a letter gap. */
const WORD_OVER_LETTER = 1.4;
/** Marks the measure looks back over. */
export const PACE_MARKS = 40;

/** Two means of `values` in the log domain: the short kind and the long. */
export function twoKinds(values: readonly number[]): [number, number] {
  const logs = values.map((v) => Math.log(v));
  let lo = Math.min(...logs);
  let hi = Math.max(...logs);
  for (let iter = 0; iter < 20; iter++) {
    const cut = (lo + hi) / 2;
    let sl = 0;
    let nl = 0;
    let sh = 0;
    let nh = 0;
    for (const v of logs) {
      if (v <= cut) {
        sl += v;
        nl++;
      } else {
        sh += v;
        nh++;
      }
    }
    const nlo = nl ? sl / nl : lo;
    const nhi = nh ? sh / nh : hi;
    if (nlo === lo && nhi === hi) break;
    lo = nlo;
    hi = nhi;
  }
  return [Math.exp(lo), Math.exp(hi)];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Whether the marks hold both dits and dahs. */
export function bothKinds(marks: readonly number[]): boolean {
  if (marks.length < 2) return false;
  const [dit, dah] = twoKinds(marks);
  return dah / dit >= MIN_DAH_RATIO;
}

/** The timing that `marks` and `gaps` were keyed at, or null with no marks.
 *
 * With marks all of one kind, `prior` says which kind they are. With no
 * prior, the shortest gaps do: a gap inside a character is one dit. */
export function paceOf(marks: readonly number[], gaps: readonly number[], prior?: Pace | null): Pace | null {
  const recent = marks.slice(-PACE_MARKS).filter((v) => v > 0);
  // A mark far shorter than the rest is a glitch, not a dit.
  const typical = median(recent);
  const m = recent.filter((v) => v >= GLITCH_SHARE * typical);
  if (m.length === 0) return prior ?? null;
  let unit: number;
  let dahOver: number;
  const [dit, dah] = twoKinds(m);
  if (m.length >= 2 && dah / dit >= MIN_DAH_RATIO) {
    unit = (dit + dah / 3) / 2;
    dahOver = Math.sqrt(dit * dah);
  } else {
    const mean = median(m);
    if (prior) unit = prior.unit;
    else {
      const g = gaps.length ? Math.min(...gaps.filter((v) => v > 0)) : NaN;
      unit = Number.isFinite(g) ? (mean < 2 * g ? (mean + g) / 2 : (mean / 3 + g) / 2) : mean < 0.12 ? mean : mean / 3;
    }
    unit = clamp(unit, MIN_UNIT, MAX_UNIT);
    dahOver = 2 * unit;
  }
  unit = clamp(unit, MIN_UNIT, MAX_UNIT);

  const g = gaps.slice(-PACE_MARKS).filter((v) => v > 0);
  const inside = median(g.filter((v) => v < 2 * unit));
  const between = median(g.filter((v) => v >= 2 * unit && v < 5 * unit));
  const charOver = clamp(
    Math.sqrt((Number.isFinite(inside) ? inside : unit) * (Number.isFinite(between) ? between : 3 * unit)),
    1.6 * unit,
    2.6 * unit,
  );
  // The gaps past a character gap are letter gaps and word gaps. Two clear
  // kinds: the cut is between them. One kind: they are letter gaps, as
  // letters come more often than words, and a word gap is well past them.
  const past = g.filter((v) => v > charOver && v < 15 * unit);
  let wordOver = 5 * unit;
  if (past.length >= 3) {
    const [short, long] = twoKinds(past);
    wordOver =
      long / short >= WORD_RATIO
        ? clamp(Math.sqrt(short * long), 3.5 * unit, 9 * unit)
        : clamp(WORD_OVER_LETTER * median(past), 5 * unit, 9 * unit);
  }
  // A mark and the gap after it together are not moved by where the
  // threshold sits, so the speed comes from them when it can.
  const speedUnit =
    Number.isFinite(inside) && m.length >= 2 && dah / dit >= MIN_DAH_RATIO
      ? clamp(((dit + inside) / 2 + (dah + inside) / 4) / 2, MIN_UNIT, MAX_UNIT)
      : unit;
  return { unit, dahOver, charOver, wordOver, wpm: 1.2 / speedUnit };
}

/** The pace of `runs`: their marks and the gaps between them. */
export function paceOfRuns(runs: readonly Run[], prior?: Pace | null): Pace | null {
  const marks: number[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.on) marks.push(r.dur);
    else if (i > 0 && i < runs.length - 1) gaps.push(r.dur);
  }
  return paceOf(marks, gaps, prior);
}

/** A word read from the runs. */
export interface Word {
  readonly text: string;
  /** Its first mark's start and its last mark's end, seconds. */
  readonly t0: number;
  readonly t1: number;
}

export interface Reading {
  readonly words: Word[];
  /** The elements of a character still being keyed, or null. */
  readonly keying: string | null;
}

/** The character `pattern` keys, or the box. */
function charOf(pattern: string): string {
  return MORSE_TO_CHAR[pattern] ?? UNKNOWN;
}

/** Read `runs` as words at `pace`. A last character with less than a
 *  character gap after it is still being keyed: it is `keying`, not text. */
export function readRuns(runs: readonly Run[], pace: Pace): Reading {
  const words: Word[] = [];
  let text = "";
  let pattern = "";
  let w0 = NaN;
  let w1 = NaN;
  const endChar = () => {
    if (!pattern) return;
    text += charOf(pattern);
    pattern = "";
  };
  const endWord = () => {
    endChar();
    if (text) words.push({ text, t0: w0, t1: w1 });
    text = "";
    w0 = NaN;
  };
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.on && r.dur < GLITCH_UNITS * pace.unit && i < runs.length - 1) continue;
    if (r.on) {
      if (Number.isNaN(w0)) w0 = r.t;
      w1 = r.t + r.dur;
      pattern += r.dur > pace.dahOver ? "-" : ".";
      continue;
    }
    if (!pattern && !text) continue;
    if (r.dur > pace.wordOver) endWord();
    else if (r.dur > pace.charOver) endChar();
  }
  // A run in progress is the last one: a mark still keyed, or a gap too
  // short yet to end the character.
  const last = runs[runs.length - 1];
  const open = last && (last.on || last.dur <= pace.charOver) ? pattern : "";
  if (open) pattern = "";
  endWord();
  return { words, keying: open || null };
}
