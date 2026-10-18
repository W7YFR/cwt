/* What the QSO page shows of an over: part of it as it is sent, and your
 * copy of it, graded.
 *
 * Pure. The page draws what these return.
 */

import { CHAR_TO_MORSE, SYMBOL_RE, canonicalChar } from "@/morse";

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

/** What a locked copy shows before the QSO ends. */
export type LockedShows = "nothing" | "grade" | "right";

/** One part of a line as graded: a character with its verdict, or a space
 *  or a gap with none. */
export interface Mark {
  readonly text: string;
  readonly ok: boolean | null;
}

export interface Grade {
  /** What you typed, each character right, or wrong or extra. */
  readonly yours: readonly Mark[];
  /** What the station sent, each character copied or missed. */
  readonly sent: readonly Mark[];
  /** Characters of the station's you copied right. */
  readonly right: number;
  /** Characters the station sent. */
  readonly total: number;
}

/** A run of dots you type for a part you did not copy: two or more full
 *  stops, or an ellipsis. Kept as typed, and not graded. */
const GAP_RE = /\.{2,}|\u2026/g;

interface Token {
  readonly text: string;
  /** The character it keys as, or null for a space or a gap. */
  readonly key: string | null;
}

function tokens(text: string, gaps: boolean): Token[] {
  const out: Token[] = [];
  const upper = text.toUpperCase();
  const parts = gaps ? upper.split(/(\.{2,}|\u2026)/) : [upper];
  for (const part of parts) {
    if (gaps && GAP_RE.test(part)) {
      GAP_RE.lastIndex = 0;
      out.push({ text: part, key: null });
      continue;
    }
    for (const t of part.match(SYMBOL_RE) ?? []) {
      out.push({ text: t, key: t in CHAR_TO_MORSE ? canonicalChar(t) : null });
    }
  }
  return out;
}

/** Your copy of `sent`, graded both ways.
 *
 * The two are lined up by edit distance: the fewest characters changed,
 * dropped or added to turn one into the other. So the parts you copied are
 * found wherever they are, even with a gap or a mistake before them: from
 * `W7YFR DE N1AK ... 479 479 KN`, the calls and the reports are right, and
 * what you left out is missed. Characters are compared by their Morse, as
 * the practice page compares them. */
export function gradeCopy(sent: string, typed: string): Grade {
  const a = tokens(sent, false);
  const b = tokens(typed, true);
  const ai = a.flatMap((t, i) => (t.key === null ? [] : [i]));
  const bi = b.flatMap((t, i) => (t.key === null ? [] : [i]));
  const n = ai.length;
  const m = bi.length;
  const key = (t: Token) => t.key!;
  const same = (i: number, j: number) => key(a[ai[i]!]!) === key(b[bi[j]!]!);

  // d[i][j]: the edits to line up the first i sent with the first j typed.
  const w = m + 1;
  const d = new Int32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * w + j - 1]! + (same(i - 1, j - 1) ? 0 : 1);
      d[i * w + j] = Math.min(sub, d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1);
    }
  }

  const sentOk = new Array<boolean>(n).fill(false);
  const typedOk = new Array<boolean>(m).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = d[i * w + j]!;
    const match = same(i - 1, j - 1);
    if (here === d[(i - 1) * w + j - 1]! + (match ? 0 : 1)) {
      if (match) {
        sentOk[i - 1] = true;
        typedOk[j - 1] = true;
      }
      i--;
      j--;
    } else if (here === d[(i - 1) * w + j]! + 1) i--;
    else j--;
  }

  const marks = (toks: Token[], index: number[], ok: boolean[]): Mark[] => {
    const at = new Map(index.map((tokenAt, k) => [tokenAt, ok[k]!]));
    return toks.map((t, k) => ({ text: t.text, ok: at.has(k) ? at.get(k)! : null }));
  };
  return {
    yours: marks(b, bi, typedOk),
    sent: marks(a, ai, sentOk),
    right: sentOk.filter(Boolean).length,
    total: n,
  };
}
