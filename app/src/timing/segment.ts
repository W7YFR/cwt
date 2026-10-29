/* Where the words break in an over, read by meaning as well as by timing.
 *
 * A sender's gaps do not always sort cleanly. Some leave wide gaps between
 * letters and short ones between words, so a letter gap and a word gap can be
 * the same length: TU W7YFR with a short word gap reads as TUW7YFR, and a
 * pause inside AK3SD reads as AK 3SD. No one cut on the gap reads both right.
 * A person copying reads them by what makes words, and so does this.
 *
 * A gap well short of the cut joins its letters, and one well past it breaks
 * the word, as the timing says. A gap near the cut can go either way. Of the
 * ways to read the over, the one that makes the most of words it knows wins:
 * words from the QSO, calls, numbers, states, names. A long word it knows
 * counts for more than two short ones, so W A is WA. Where it knows none of
 * the readings, the timing decides, as before.
 *
 * Pure.
 */

/** One character of the over, with the gap before it. */
export interface Spaced {
  readonly char: string;
  /** The gap before it, as a share of the cut between a letter gap and a
   *  word gap: below 1 reads as a letter gap. Null for the first, and
   *  Infinity for a pause. */
  readonly gap: number | null;
}

/** Below this share of the cut, a gap joins its letters, whatever the words. */
export const SURE_JOIN = 0.7;
/** Above this share of the cut, a gap breaks the word, whatever the words.
 *  A textbook word gap is 1.4 of the cut, so it is always a break. */
export const SURE_BREAK = 1.3;

/** What the gap's timing says, against what the words say: the most a gap
 *  near the cut can cost the reading that goes against it. */
const GAP_WEIGHT = 3;

/** The longest word read. */
const MAX_WORD = 12;

/** A call: an optional letter or digit, a letter, a digit, then letters. */
const CALL_RE = /^(?:[A-Z0-9]?[A-Z])\d[A-Z]{1,4}$/;

/** A number, with cut digits (T for 0, N for 9), or a report. */
const NUMBER_RE = /^(?=.*\d)[0-9TN]+$/;

/** How much a word is worth to a reading: a word it knows, more the longer
 *  it is; one with the shape of a call or a number, its length, so the
 *  timing decides between two such readings; anything else, less than
 *  nothing. */
function worth(word: string, known: ReadonlySet<string>): number {
  const n = word.length;
  if (known.has(word)) return n * n;
  if (/^<[A-Z]+>$/.test(word)) return 1;
  if (CALL_RE.test(word) || NUMBER_RE.test(word)) return n;
  return -n;
}

type Gap = "join" | "break" | "either";

function kindOf(gap: number | null): Gap {
  if (gap === null || gap < SURE_JOIN) return "join";
  if (gap > SURE_BREAK) return "break";
  return "either";
}

/** For a gap near the cut, the cost of reading it as a break, and as a join:
 *  the nearer the cut from below, the cheaper a break. */
function costs(gap: number): { brk: number; join: number } {
  const p = Math.min(1, Math.max(0, (gap - SURE_JOIN) / (SURE_BREAK - SURE_JOIN)));
  return { brk: (1 - p) * GAP_WEIGHT, join: p * GAP_WEIGHT };
}

/** The over as words: each gap near the cut read as whichever makes the best
 *  words of `known`. */
export function readWords(chars: readonly Spaced[], known: ReadonlySet<string>): string {
  const n = chars.length;
  if (n === 0) return "";
  const kinds = chars.map((c) => kindOf(c.gap));
  // best[i]: the best reading of the first i characters, ending with a word.
  const best = new Array<number>(n + 1).fill(-Infinity);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    // The word ends before character i: it must be able to break there.
    if (i < n && kinds[i] === "join") continue;
    let inside = 0;
    for (let j = i - 1; j >= 0 && i - j <= MAX_WORD; j--) {
      // Character j starts the word: the gap before it must break, or be first.
      if (j > 0 && kinds[j] !== "join" && best[j]! > -Infinity) {
        const brk = kinds[j] === "either" ? costs(chars[j]!.gap!).brk : 0;
        const word = chars
          .slice(j, i)
          .map((c) => c.char)
          .join("");
        const score = best[j]! + worth(word, known) - brk - inside;
        if (score > best[i]!) {
          best[i] = score;
          from[i] = j;
        }
      } else if (j === 0) {
        const word = chars
          .slice(0, i)
          .map((c) => c.char)
          .join("");
        const score = worth(word, known) - inside;
        if (score > best[i]!) {
          best[i] = score;
          from[i] = 0;
        }
      }
      // Going on to j - 1 puts the gap before j inside the word.
      if (j > 0) {
        if (kinds[j] === "break") break;
        if (kinds[j] === "either") inside += costs(chars[j]!.gap!).join;
      }
    }
  }
  if (best[n] === -Infinity) return chars.map((c) => c.char).join("");
  const words: string[] = [];
  for (let i = n; i > 0; i = from[i]!) {
    words.unshift(
      chars
        .slice(from[i]!, i)
        .map((c) => c.char)
        .join(""),
    );
  }
  return words.join(" ");
}
