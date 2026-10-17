/* What the QSO page shows of an over: part of it as it is sent, and your
 * copy of it, graded.
 *
 * Pure. The page draws what these return.
 */

import { CHAR_TO_MORSE, SYMBOL_RE } from "@/morse";
import { graded, keyedSymbols } from "@/timing/live";

/** How the station's overs show. */
export type TheirText = "before" | "sent" | "hidden" | "copy" | "none";

/** How your own overs show. */
export type YourText = "sent" | "hidden" | "none";

/** The first `n` characters of `text` that can be keyed, with the spaces
 *  between them. A prosign counts as one. */
export function revealed(text: string, n: number): string {
  let out = "";
  let count = 0;
  for (const token of text.toUpperCase().match(SYMBOL_RE) ?? []) {
    if (!(token in CHAR_TO_MORSE)) {
      if (count > 0) out += token;
      continue;
    }
    if (count === n) break;
    out += token;
    count++;
  }
  return out.trimEnd();
}

/** One part of an over as graded: a character with its verdict, or the
 *  space between words with none. */
export interface Mark {
  readonly text: string;
  readonly ok: boolean | null;
}

export interface Grade {
  readonly marks: readonly Mark[];
  /** Characters copied right. */
  readonly right: number;
  /** Characters sent. */
  readonly total: number;
}

/** Your copy of `sent`, graded character by character, the way the practice
 *  page grades your sending. A character you left out or got wrong is wrong.
 *  So is every character after the last one you copied. */
export function gradeCopy(sent: string, typed: string): Grade {
  const target = keyedSymbols(sent);
  const verdicts = graded(target, keyedSymbols(typed));
  const marks: Mark[] = [];
  let at = 0;
  for (const token of sent.toUpperCase().match(SYMBOL_RE) ?? []) {
    if (token in CHAR_TO_MORSE) {
      marks.push({ text: token, ok: verdicts[at] ?? false });
      at++;
    } else marks.push({ text: token, ok: null });
  }
  return { marks, right: verdicts.filter(Boolean).length, total: target.length };
}
