/* Your copy of a recording, line by line, and the moves around it.
 *
 * Pure. The Copy page holds what these return.
 */

import { canonicalChar, keyableSymbols, patternOf } from "@/morse";
import { gradeCopy } from "@/qso/show";
import { idealTimeline, targetTiming } from "@/timing";
import type { Over, RecChar, Recording } from "./decode";

/** How you copy: in one box per line, or in a slot per character. */
export type CopyInput = "text" | "slots";

/** Your copy of one line. */
export interface LineCopy {
  /** What you typed in the box. */
  readonly typed: string;
  /** What you typed in each slot, one per character of the line. */
  readonly slots: readonly string[];
  /** Your copy can no longer change. */
  readonly locked: boolean;
  /** The slots right in the attempt before, which stay as they are. */
  readonly kept: readonly boolean[] | null;
}

/** One try at the whole recording: your copy of each line, and how you
 *  copied it. */
export interface Attempt {
  readonly input: CopyInput;
  readonly lines: readonly LineCopy[];
}

/** A line not yet copied. */
export function emptyCopy(over: Over): LineCopy {
  return { typed: "", slots: charsOf(over).map(() => ""), locked: false, kept: null };
}

/** A line sent from `text`, as an over, with each character where it falls
 *  when sent at `charWpm` and `farnsworthWpm`. The QSO page's station sends
 *  from text, so its lines have no decode. */
export function overOfText(text: string, charWpm: number, farnsworthWpm: number): Over {
  const timeline = idealTimeline(text, targetTiming(charWpm, farnsworthWpm));
  let k = 0;
  const words = timeline.text
    .split(" ")
    .filter(Boolean)
    .map((word) => ({
      chars: keyableSymbols(word).map(() => {
        const c = timeline.chars[k++]!;
        return { char: c.char, t0: c.t0, t1: c.t1 };
      }),
    }))
    .filter((w) => w.chars.length > 0);
  return { sender: 0, words, text: words.map((w) => w.chars.map((c) => c.char).join("")).join(" "), t0: 0, t1: timeline.duration };
}

/** Every character of `over`, in order. */
export function charsOf(over: Over): RecChar[] {
  return over.words.flatMap((w) => w.chars);
}

/** Prosigns as their letters: <KN> as KN. A box takes either, and this page
 *  grades both as letters. */
export function plain(text: string): string {
  return text.toUpperCase().replace(/<([A-Z]+)>/g, "$1");
}

/** What `over` sent, as a box is graded against it. */
export function sentText(over: Over): string {
  return plain(over.text);
}

/** The character behind each character a box's grade counts, in order. A
 *  prosign stands behind each of its letters. */
export function keyedOf(over: Over): RecChar[] {
  return charsOf(over).flatMap((c) =>
    patternOf(c.char) ? Array.from(slotText(c.char), () => c) : [],
  );
}

/** What a slot wants typed: the character, or a prosign's letters. */
export function slotText(char: string): string {
  return char.replace(/[<>]/g, "");
}

/** Whether `typed` in a slot is `char`. Letters typed in one slot are a
 *  prosign, so any spelling that keys the same is right: IG for <UN>. */
export function slotRight(char: string, typed: string): boolean {
  const t = typed.trim().toUpperCase();
  if (!t) return false;
  if (t === slotText(char)) return true;
  return canonicalChar(/^[A-Z]{2,}$/.test(t) ? `<${t}>` : t) === canonicalChar(char);
}

export interface LineGrade {
  readonly right: number;
  readonly total: number;
}

/** How much of `over` your copy has right. */
export function gradeLine(over: Over, copy: LineCopy, input: CopyInput): LineGrade {
  if (input === "slots") {
    const chars = charsOf(over);
    const keyed = chars.filter((c) => patternOf(c.char));
    const right = chars.filter((c, i) => patternOf(c.char) && slotRight(c.char, copy.slots[i] ?? "")).length;
    return { right, total: keyed.length };
  }
  const g = gradeCopy(sentText(over), plain(copy.typed));
  return { right: g.right, total: g.total };
}

/** What you typed in the box, put in slots: each character you typed in the
 *  slot of the character sent it lines up with, as the grade lines them up.
 *  A prosign's slot takes the letters typed for each of its letters. A slot
 *  nothing lines up with stays empty. */
export function slotsOfTyped(over: Over, typed: string): string[] {
  const chars = charsOf(over);
  const slotOf = keyedOf(over).map((c) => chars.indexOf(c));
  const slots = chars.map(() => "");
  let k = 0;
  for (const col of gradeCopy(sentText(over), plain(typed)).columns) {
    const sent = col.sent.filter((m) => m.ok !== null);
    const yours = col.yours.filter((m) => m.ok !== null);
    if (sent.length === 1 && yours.length === 1) {
      const i = slotOf[k];
      if (i !== undefined && i >= 0) slots[i] += yours[0]!.text;
    }
    k += sent.length;
  }
  return slots;
}

/** Your copy as text: the box, or the slots with a space between words and
 *  a gap for each run of empty slots. */
export function copyText(over: Over, copy: LineCopy, input: CopyInput): string {
  if (input === "text") return copy.typed;
  let k = 0;
  return over.words
    .map((w) =>
      w.chars
        .map(() => copy.slots[k++]?.trim().toUpperCase() || "..")
        .join("")
        .replace(/(\.\.)+/g, ".."),
    )
    .join(" ");
}

/** The line in your next attempt. From your last copy, it starts with what
 *  you typed, and in slots with the slots you got right, which stay. A line
 *  of slots all right is done, and locked. Clean, it starts empty. */
export function nextCopy(over: Over, last: LineCopy, fromLast: boolean): LineCopy {
  if (!fromLast) return emptyCopy(over);
  const kept = charsOf(over).map((c, i) => slotRight(c.char, last.slots[i] ?? ""));
  return {
    typed: last.typed,
    slots: last.slots.map((s, i) => (kept[i] ? s : "")),
    locked: kept.every(Boolean),
    kept,
  };
}

/** Whether you have copied `call`: the call whole, as a word of any line. */
export function heard(call: string, copies: readonly string[]): boolean {
  return copies.some((t) => t.toUpperCase().split(/\s+/).includes(call));
}

/* ---- moving through the recording ---------------------------------------- */

/** A skip back to a word's start goes to the word before when it is already
 *  this close to the start of this one, so a press always moves. */
const RESTART_SEC = 0.4;

/** A skip to a word or a line lands this long before it, so its first
 *  character is heard whole. */
export const LEAD_SEC = 0.25;

/** Where each word starts and ends, in order. */
export function wordSpans(rec: Recording): [number, number][] {
  return rec.overs.flatMap((o) => o.words.map((w): [number, number] => [w.chars[0]!.t0, w.chars.at(-1)!.t1]));
}

/** Where each line starts and ends, in order. */
export function overSpans(rec: Recording): [number, number][] {
  return rec.overs.map((o): [number, number] => [o.t0, o.t1]);
}

/** Where a skip from `at` lands: to the start of the span it is in, or the
 *  one before, going back; to the start of the next, going on. Null where
 *  there is none. `landed` is where the last skip back landed: still in
 *  that span, a skip back goes to the one before. */
export function skipSpan(
  spans: readonly [number, number][],
  at: number,
  dir: -1 | 1,
  landed: number | null = null,
): number | null {
  // In the lead-in before a span, a skip is from the span's start.
  const next = spans.find(([t0]) => t0 > at);
  if (next && at >= next[0] - LEAD_SEC - 0.01) at = next[0];
  if (dir > 0) return spans.find(([t0]) => t0 > at + 0.01)?.[0] ?? null;
  let i = -1;
  for (let k = 0; k < spans.length; k++) if (spans[k]![0] <= at) i = k;
  if (i < 0) return null;
  const again = landed !== null && Math.abs(spans[i]![0] - landed) < 0.01 && at <= spans[i]![1];
  if (!again && at - spans[i]![0] > RESTART_SEC) return spans[i]![0];
  return i > 0 ? spans[i - 1]![0] : spans[0]![0];
}

/** Where to play from for the span that starts at `t`: the lead-in before
 *  it, but not into the span before. */
export function leadIn(spans: readonly [number, number][], t: number): number {
  let before = 0;
  for (const [t0, t1] of spans) if (t0 < t && t1 <= t) before = Math.max(before, t1);
  return Math.max(before, t - LEAD_SEC, 0);
}

/** The word at `t`, or the nearest one after it. */
export function wordAt(rec: Recording, t: number): [number, number] | null {
  const spans = wordSpans(rec);
  return spans.find(([, t1]) => t1 >= t) ?? null;
}

/** m:ss, for the time on the page. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
