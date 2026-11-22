/* Where one station stops and the next starts, on one signal.
 *
 * The two sides of a QSO are most often on the same pitch, so the pitch
 * cannot tell them apart. What can, best effort:
 *
 *   - a long silence;
 *   - a word that hands the turn over (K, KN, BK, SK, a question), then a
 *     pause;
 *   - a CQ that ends with a call, then a pause: the answer comes next;
 *   - a change of strength, or of speed, across a pause. Two stations seldom
 *     arrive at the same strength and the same speed.
 *
 * The pauses checked are longer than a character gap. A word gap is enough
 * when the strength or the speed changes across it.
 *
 * Pure.
 */

import type { Run } from "./channel";
import { bothKinds, paceOfRuns, readRuns, twoKinds, type Pace, type Word } from "./adapt";

/** A silence this long always ends a turn: this many seconds, or this many
 *  dits, whichever is longer. */
const HARD_SEC = 2.5;
const HARD_UNITS = 20;
/** The pause after a turn word, a CQ or a call that ends a turn. Short:
 *  in a contest the answer comes at once. */
const TURN_SEC = 0.35;
const TURN_UNITS = 6;
/** The least pause a change of strength or speed ends a turn across. */
const CHANGE_SEC = 0.25;
const CHANGE_UNITS = 4.5;
/** The pause after a turn word, a CQ or a call is at least this many times
 *  the sender's own word gap. */
const WORD_GAP_TIMES = 1.4;
/** The pause after a CQ, a call or TU that ends with a call is at least
 *  this many times the word gap: a call is often sent twice. */
const CALL_GAP_TIMES = 1.6;
/** A change of strength between two stations, dB. */
const LEVEL_DB = 5;
/** A change of speed between two stations: the faster dit is this many
 *  times shorter. */
const SPEED_RATIO = 1.35;
/** Marks a turn needs, dits and dahs both, to be read at its own speed. */
const OWN_PACE_MARKS = 6;
/** Marks either side of a pause that its strength is judged from, and the
 *  least that will do. */
const LEVEL_MARKS = 8;
const LEVEL_MIN_MARKS = 3;
/** Marks either side that its speed is judged from, and the least. */
const SPEED_MARKS = 14;
const SPEED_MIN_MARKS = 8;

/** Words that hand the turn to the other station. */
export const TURN_WORDS = new Set(["K", "KN", "<KN>", "BK", "<BK>", "SK", "<SK>", "E E", "EE"]);

/** A call sign: an optional prefix and slash, a prefix, a digit, a suffix,
 *  an optional slash and portable. */
export const CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?(?:[A-Z]{1,2}|\d[A-Z]|[A-Z]\d)\d{1,2}[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;

export function isCall(word: string): boolean {
  return CALL_RE.test(word);
}

/** One station's turn, read. */
export interface TurnRead {
  readonly runs: readonly Run[];
  readonly text: string;
  /** Its words, each with its first mark's start and last mark's end. */
  readonly words: readonly Word[];
  readonly keying: string | null;
  readonly pace: Pace | null;
  /** Mean mark level, dB. */
  readonly db: number;
  /** First mark's start and last mark's end, seconds. */
  readonly t0: number;
  readonly t1: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The marks of `runs` from index `from`, going `dir`, at most `count`, up
 *  to index `stop` (exclusive) or a gap of `pause` or longer: the pause
 *  being judged, or a longer one, ends what is compared across it. */
function marksFrom(runs: readonly Run[], from: number, dir: 1 | -1, count: number, stop: number, pause: number): Run[] {
  const out: Run[] = [];
  for (let i = from; dir > 0 ? i < stop : i > stop; i += dir) {
    const r = runs[i]!;
    if (!r.on && r.dur >= pause) break;
    if (r.on) {
      out.push(r);
      if (out.length >= count) break;
    }
  }
  return out;
}

/** Whether two runs of marks were keyed at different speeds: both their
 *  dits and their dahs differ, the same way, by `SPEED_RATIO` or more. */
function newSpeed(a: readonly Run[], b: readonly Run[]): boolean {
  const ka = twoKinds(a.map((m) => m.dur));
  const kb = twoKinds(b.map((m) => m.dur));
  const dit = ka[0] / kb[0];
  const dah = ka[1] / kb[1];
  return (dit >= SPEED_RATIO && dah >= SPEED_RATIO) || (dit <= 1 / SPEED_RATIO && dah <= 1 / SPEED_RATIO);
}

/** The sender's typical word gap in `runs` from `from` to `to`: the median
 *  gap longer than a character gap and shorter than a pause. 7 dits when
 *  there is none. */
function wordGap(runs: readonly Run[], from: number, to: number, unit: number): number {
  const gaps: number[] = [];
  for (let i = from + 1; i < to; i++) {
    const r = runs[i]!;
    if (!r.on && r.dur > 4.5 * unit && r.dur < Math.max(HARD_SEC, HARD_UNITS * unit)) gaps.push(r.dur);
  }
  return gaps.length ? median(gaps) : 7 * unit;
}

/** The words a turn is read by meaning with. */
export interface Words {
  readonly known: ReadonlySet<string>;
  /** Calls read in earlier turns, not yet known. */
  readonly heard: ReadonlySet<string>;
}

/** Read `runs` as one turn, by meaning with `words`. With `fixed`, at that
 *  pace rather than its own: the rest of a turn whose start is read. */
export function readTurn(runs: readonly Run[], fallback: Pace | null, words?: Words, fixed?: Pace | null): TurnRead {
  const known = words?.known;
  const marks = runs.filter((r) => r.on);
  const own = !fixed && marks.length >= OWN_PACE_MARKS && bothKinds(marks.map((m) => m.dur)) ? paceOfRuns(runs, fallback) : null;
  const pace = fixed ?? own ?? fallback ?? paceOfRuns(runs);
  let read = pace ? readRuns(runs, pace, known) : { words: [], keying: null };
  // A call read twice is known for the rest of the turn: CQ K7ABC K7ABC,
  // then K7ABC once more with a wide gap, is not K7A BC. A reading in an
  // earlier turn counts, and so does a call with more stuck on its end:
  // K7ABCK is K7ABC K.
  if (pace && known) {
    const calls = read.words.map((w) => w.text).filter(isCall);
    const heard = words.heard;
    const more = [...new Set([...calls, ...heard])].filter(
      (c) => !known.has(c) && calls.filter((w) => w.startsWith(c)).length + (heard.has(c) ? 1 : 0) >= 2,
    );
    if (more.length) read = readRuns(runs, pace, new Set([...known, ...more]));
  }
  const first = marks[0];
  const last = marks[marks.length - 1];
  return {
    runs,
    text: read.words.map((w) => w.text).join(" "),
    words: read.words,
    keying: read.keying,
    pace,
    db: marks.length ? marks.reduce((a, m) => a + m.db, 0) / marks.length : 0,
    t0: first ? first.t : runs[0]?.t ?? 0,
    t1: last ? last.t + last.dur : runs[0]?.t ?? 0,
  };
}

/** Split `runs`, which start with a mark, into turns. `pace` is the
 *  signal's timing lately, for reading pauses before a turn has enough
 *  marks of its own. The last turn may still be going on. `known` holds
 *  the words to read by meaning. */
export function splitTurns(runs: readonly Run[], pace: Pace | null, known?: Words): TurnRead[] {
  const unit = pace?.unit ?? 0.06;
  // The last run may still be going on: a mark half keyed says nothing yet
  // about strength or speed.
  const settled = runs.length - 1;
  const breaks: number[] = [];
  let since = 0;
  for (let i = 1; i < runs.length - 1; i++) {
    const gap = runs[i]!;
    if (gap.on) continue;
    const g = gap.dur;
    if (g < Math.max(CHANGE_SEC, CHANGE_UNITS * unit)) continue;
    let cut = g >= Math.max(HARD_SEC, HARD_UNITS * unit);

    const word = wordGap(runs, since, i, unit);
    if (!cut && g >= Math.max(TURN_SEC, TURN_UNITS * unit, WORD_GAP_TIMES * word)) {
      const before = readTurn(runs.slice(since, i + 1).concat(farGap(runs[i]!)), pace, known);
      const words = before.text.split(" ");
      const lastWord = words[words.length - 1] ?? "";
      const lastTwo = words.slice(-2).join(" ");
      const handsOver =
        words.length >= 2 && (TURN_WORDS.has(lastWord) || TURN_WORDS.has(lastTwo) || lastWord.endsWith("?"));
      const signs =
        g >= CALL_GAP_TIMES * word &&
        CALL_RE.test(lastWord) &&
        (words[0] === "CQ" || words[0] === "TU" || words.every((w) => CALL_RE.test(w) || w === "DE"));
      if (handsOver || signs) cut = true;
    }

    if (!cut) {
      const a = marksFrom(runs, i - 1, -1, LEVEL_MARKS, since - 1, g);
      const b = marksFrom(runs, i + 1, 1, LEVEL_MARKS, settled, g);
      if (a.length >= LEVEL_MIN_MARKS && b.length >= LEVEL_MIN_MARKS) {
        const da = median(a.map((m) => m.db));
        const dbb = median(b.map((m) => m.db));
        if (Math.abs(da - dbb) >= LEVEL_DB) cut = true;
      }
    }

    if (!cut) {
      const a = marksFrom(runs, i - 1, -1, SPEED_MARKS, since - 1, g);
      const b = marksFrom(runs, i + 1, 1, SPEED_MARKS, settled, g);
      if (
        a.length >= SPEED_MIN_MARKS &&
        b.length >= SPEED_MIN_MARKS &&
        bothKinds(a.map((m) => m.dur)) &&
        bothKinds(b.map((m) => m.dur)) &&
        newSpeed(a, b)
      )
        cut = true;
    }

    if (cut) {
      breaks.push(i);
      since = i + 1;
    }
  }

  const turns: TurnRead[] = [];
  let from = 0;
  for (const b of breaks) {
    turns.push(readTurn(runs.slice(from, b).concat(farGap(runs[b]!)), pace, known));
    from = b + 1;
  }
  turns.push(readTurn(runs.slice(from), pace, known));
  return turns.filter((t) => t.runs.some((r) => r.on));
}

/** A gap long enough to end any word, in place of the pause after a turn,
 *  so its last character is read. */
function farGap(gap: Run): Run {
  return { on: false, t: gap.t, dur: Math.max(gap.dur, 10), db: 0 };
}
