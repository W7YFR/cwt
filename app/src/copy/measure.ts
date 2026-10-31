/* The speed a recording is sent at, measured from what the decoder read.
 *
 * Each character's length is a count of units, from its pattern: a dit is
 * one, a dah three, and one between each two. Its length over its units is
 * the unit, and the character speed comes from the middle unit of a
 * station's characters. The overall speed is the one at which each line,
 * sent at that character speed, takes as long as it took, again from the
 * middle line. So a station that spaces its characters out reads as
 * Farnsworth.
 *
 * Pure.
 */

import { patternOf, UNKNOWN } from "@/morse";
import type { Speed } from "@/qso/speed";
import { idealTimeline, targetTiming } from "@/timing";
import type { Over, Recording } from "./decode";

/** The slowest speed this measures, in words per minute. */
const SLOWEST_WPM = 5;

/** An overall speed this close to the character speed is the same speed. */
const SAME_WPM = 1;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The units in `pattern`: a dit one, a dah three, one between each two. */
function unitsOf(pattern: string): number {
  let units = pattern.length - 1;
  for (const e of pattern) units += e === "." ? 1 : 3;
  return units;
}

/** The overall speed at which `over` takes as long as it took, sent at
 *  `charWpm`, or null when it is one word or holds a character not read. */
function overallOf(over: Over, charWpm: number): number | null {
  if (over.words.length < 2 || over.text.includes(UNKNOWN)) return null;
  const chars = over.words.flatMap((w) => w.chars);
  const took = chars.at(-1)!.t1 - chars[0]!.t0;
  const at = (wpm: number) => idealTimeline(over.text, targetTiming(charWpm, wpm)).duration;
  if (took <= at(charWpm)) return charWpm;
  // Slower overall speeds take longer: the nearest whole speed.
  let best = charWpm;
  for (let wpm = charWpm; wpm >= SLOWEST_WPM; wpm--) {
    if (Math.abs(at(wpm) - took) < Math.abs(at(best) - took)) best = wpm;
  }
  return best;
}

/** The speed of the lines of `overs`, or null when none can be measured. */
export function speedOf(overs: readonly Over[]): Speed | null {
  const units: number[] = [];
  for (const over of overs) {
    for (const w of over.words) {
      for (const c of w.chars) {
        const pattern = patternOf(c.char);
        if (pattern && c.t1 > c.t0) units.push((c.t1 - c.t0) / unitsOf(pattern));
      }
    }
  }
  const unit = median(units);
  if (unit === null) return null;
  const charWpm = Math.max(SLOWEST_WPM, Math.round(1.2 / unit));
  const overall = median(overs.map((o) => overallOf(o, charWpm)).filter((w): w is number => w !== null));
  const farnsworthWpm = overall === null || charWpm - overall <= SAME_WPM ? charWpm : Math.round(overall);
  return { charWpm, farnsworthWpm };
}

/** The speed of each station in `rec`, in the order of its senders: null
 *  for one that cannot be measured. */
export function speedsOf(rec: Recording): (Speed | null)[] {
  return rec.senders.map((_, s) => speedOf(rec.overs.filter((o) => o.sender === s)));
}
