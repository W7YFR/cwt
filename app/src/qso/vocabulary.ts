/* The words a QSO is made of, for reading your sending by meaning.
 *
 * Lenient copy reads a gap near the cut between letters and words as
 * whichever makes words (see timing/segment.ts). These are the words: what
 * the station knows, states, names, the formats, and what is yours and the
 * station's in this QSO.
 */

import { KNOWN, TURN_WORDS } from "./cq";
import { FORMATS, REGIONS } from "./formats";
import { AROUND } from "./run";
import { NAMES } from "./station";

/** The words of a QSO, with `extra`: your call, name and QTH, the station's
 *  call and name. Each word of `extra` on its own. */
export function vocabulary(extra: readonly string[]): string[] {
  const words = new Set<string>([
    ...KNOWN,
    ...TURN_WORDS,
    ...AROUND,
    ...REGIONS,
    ...NAMES,
    ...Object.values(FORMATS).map((f) => f.word),
  ]);
  for (const e of extra) for (const w of e.toUpperCase().split(/\s+/)) if (w) words.add(w);
  return [...words];
}
