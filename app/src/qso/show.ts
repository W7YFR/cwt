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

/** One column of a copy lined up with what was sent: what you typed over
 *  what the station sent there. Either side can be empty. A gap you typed is
 *  one column, over all the characters it stands for. */
export interface Column {
  readonly yours: readonly Mark[];
  readonly sent: readonly Mark[];
}

export interface Grade {
  /** What you typed, each character right, or wrong or extra. */
  readonly yours: readonly Mark[];
  /** What the station sent, each character copied or missed. */
  readonly sent: readonly Mark[];
  /** The two lined up, column by column, for drawing one over the other. A
   *  space between words is a column of its own, with the space on each side
   *  that had one. */
  readonly columns: readonly Column[];
  /** For each of `yours`, the station's character it lines up with, counted
   *  from 0 among the characters sent. A character you added takes the one
   *  before it, or the first. Null for a space or a gap. */
  readonly yourSent: readonly (number | null)[];
  /** Characters of the station's you copied right. */
  readonly right: number;
  /** Characters the station sent. */
  readonly total: number;
}

/** A run of dots you type for a part you did not copy: two or more full
 *  stops, or an ellipsis. Kept as typed, and not graded. */
const GAP_RE = /^(\.{2,}|\u2026)$/;

interface Token {
  readonly text: string;
  /** The character it keys as, or null for a space or a gap. */
  readonly key: string | null;
  readonly gap: boolean;
}

function tokens(text: string, gaps: boolean): Token[] {
  const out: Token[] = [];
  const upper = text.toUpperCase();
  const parts = gaps ? upper.split(/(\.{2,}|\u2026)/) : [upper];
  for (const part of parts) {
    if (gaps && GAP_RE.test(part)) {
      out.push({ text: part, key: null, gap: true });
      continue;
    }
    for (const t of part.match(SYMBOL_RE) ?? []) {
      out.push({ text: t, key: t in CHAR_TO_MORSE ? canonicalChar(t) : null, gap: false });
    }
  }
  return out;
}

const SPACE: Column = { yours: [{ text: " ", ok: null }], sent: [{ text: " ", ok: null }] };

/** Your copy of `sent`, graded both ways.
 *
 * The two are lined up by edit distance: the fewest characters changed,
 * dropped or added to turn one into the other. So the parts you copied are
 * found wherever they are, even with a gap or a mistake before them: from
 * `W7YFR DE N1AK ... 479 479 KN`, the calls and the reports are right, and
 * what you left out is missed. A gap you typed stands for any number of the
 * station's characters, so what it leaves out costs nothing there, and the
 * characters around it line up with the ones they were sent next to. Of two
 * equal ways to line up, the one that matches earlier wins. Characters are
 * compared by their Morse, as the practice page compares them. */
export function gradeCopy(sent: string, typed: string): Grade {
  const a = tokens(sent, false);
  const b = tokens(typed, true);
  // The station's characters, and yours with your gaps among them.
  const ai = a.flatMap((t, i) => (t.key === null ? [] : [i]));
  const bi = b.flatMap((t, i) => (t.key === null && !t.gap ? [] : [i]));
  const n = ai.length;
  const m = bi.length;
  const gapAt = (j: number) => b[bi[j]!]!.gap;
  const same = (i: number, j: number) => a[ai[i]!]!.key === b[bi[j]!]!.key;

  // s[i][j]: the edits to line up the station's characters from i on with
  // yours from j on. Worked from the end, so the walk from the start can
  // take the earliest match.
  const w = m + 1;
  const s = new Int32Array((n + 1) * w);
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      const at = i * w + j;
      if (i === n && j === m) s[at] = 0;
      else if (j === m) s[at] = n - i;
      else if (gapAt(j)) s[at] = i === n ? s[at + 1]! : Math.min(s[at + 1]!, s[at + w]!);
      else if (i === n) s[at] = s[at + 1]! + 1;
      else {
        s[at] = Math.min(
          s[at + w + 1]! + (same(i, j) ? 0 : 1),
          s[at + w]! + 1,
          s[at + 1]! + 1,
        );
      }
    }
  }

  const sentOk = new Array<boolean>(n).fill(false);
  const typedOk = new Array<boolean>(m).fill(false);
  const yourSent = new Array<number | null>(b.length).fill(null);
  const columns: Column[] = [];
  /* A space goes in before a column when either side had one before the
     characters the column takes. */
  let lastA = -1;
  let lastB = -1;
  const spaced = (toks: Token[], from: number, to: number) => {
    for (let k = from + 1; k < to; k++) if (toks[k]!.key === null && !toks[k]!.gap) return true;
    return false;
  };
  const push = (col: Column, takeA: number | null, takeB: number | null) => {
    const sentSpace = takeA !== null && lastA >= 0 && spaced(a, lastA, takeA);
    const typedSpace = takeB !== null && lastB >= 0 && spaced(b, lastB, takeB);
    // A space on one side only is a column with the space on that side.
    if ((sentSpace || typedSpace) && columns.length > 0) {
      columns.push(
        sentSpace && typedSpace
          ? SPACE
          : { yours: typedSpace ? SPACE.yours : [], sent: sentSpace ? SPACE.sent : [] },
      );
    }
    if (takeA !== null) lastA = takeA;
    if (takeB !== null) lastB = takeB;
    columns.push(col);
  };
  const sentMark = (i: number, ok: boolean): Mark => ({ text: a[ai[i]!]!.text, ok });
  const typedMark = (j: number, ok: boolean | null): Mark => ({ text: b[bi[j]!]!.text, ok });

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const here = s[i * w + j]!;
    if (j < m && gapAt(j)) {
      // The gap takes the station's characters until what follows lines up.
      const under: Mark[] = [];
      const first = i;
      while (i < n && here !== s[i * w + j + 1]!) {
        if (i > first && spaced(a, ai[i - 1]!, ai[i]!)) under.push({ text: " ", ok: null });
        under.push(sentMark(i, false));
        i++;
      }
      push({ yours: [typedMark(j, null)], sent: under }, i > first ? ai[first]! : null, bi[j]!);
      if (i > first) lastA = ai[i - 1]!;
      j++;
    } else if (i < n && j < m && here === s[(i + 1) * w + j + 1]! + (same(i, j) ? 0 : 1)) {
      const ok = same(i, j);
      sentOk[i] = ok;
      typedOk[j] = ok;
      yourSent[bi[j]!] = i;
      push({ yours: [typedMark(j, ok)], sent: [sentMark(i, ok)] }, ai[i]!, bi[j]!);
      i++;
      j++;
    } else if (i < n && here === s[(i + 1) * w + j]! + 1) {
      push({ yours: [], sent: [sentMark(i, false)] }, ai[i]!, null);
      i++;
    } else {
      push({ yours: [typedMark(j, false)], sent: [] }, null, bi[j]!);
      if (n > 0) yourSent[bi[j]!] = Math.max(0, Math.min(n - 1, i - 1));
      j++;
    }
  }

  const marks = (toks: Token[], index: number[], ok: boolean[]): Mark[] => {
    const at = new Map(index.map((tokenAt, k) => [tokenAt, ok[k]!]));
    return toks.map((t, k) => ({ text: t.text, ok: t.gap || !at.has(k) ? null : at.get(k)! }));
  };
  return {
    yours: marks(b, bi, typedOk),
    sent: marks(a, ai, sentOk),
    columns,
    yourSent,
    right: sentOk.filter(Boolean).length,
    total: n,
  };
}
