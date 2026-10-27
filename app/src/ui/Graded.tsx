/* Your copy of a line, marked and graded. The QSO page and the Copy page both
 * draw these. */

import { gradeCopy, type Column, type Mark } from "@/qso/show";

/** Attributes for the `k`th character sent, counted from 0, so a page can say
 *  where each one is in its audio. */
export type SentAttrs = (k: number) => Record<string, string | number>;

/** Marked characters: a dot under each one `dot` picks, blue if right, red
 *  if not. Spaces, gaps and the characters it does not pick have none.
 *  `attrs` takes each character's place in the line, from `first`, or with
 *  `at`, the place of the character sent that each mark lines up with. */
export function Marked({
  marks,
  dot,
  attrs,
  first = 0,
  at,
}: {
  marks: readonly Mark[];
  dot(ok: boolean): boolean;
  attrs?: SentAttrs | undefined;
  first?: number;
  at?: readonly (number | null)[] | undefined;
}): React.ReactElement {
  let k = first;
  const attrsOf = (m: Mark, i: number) => {
    if (!attrs) return {};
    if (at) return at[i] == null ? {} : attrs(at[i]!);
    return m.ok !== null ? attrs(k++) : {};
  };
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={m.ok === null || !dot(m.ok) ? undefined : m.ok ? "cright" : "cwrong"}
          {...attrsOf(m, i)}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}

/** Your copy, with a blue dot under each character you got right and a red
 *  one under each you got wrong. A character you left out is a blank with a
 *  red dot, so a copy short of the line does not look whole. The sent
 *  characters are not shown, so nothing says what you missed. */
export function RightOnly({
  sent,
  typed,
  attrs,
  testId = "qso-right-only",
}: {
  sent: string;
  typed: string;
  attrs?: SentAttrs | undefined;
  testId?: string;
}): React.ReactElement {
  const grade = gradeCopy(sent, typed);
  if (!typed.trim()) {
    return (
      <span className="text rightonly" data-testid={testId}>
        (nothing copied)
      </span>
    );
  }
  const places = columnPlaces(grade.columns);
  const marks: Mark[] = [];
  const at: (number | null)[] = [];
  grade.columns.forEach((col, c) => {
    const more =
      col.yours.length > 0
        ? col.yours
        : col.sent.filter((m) => m.ok === false).map((): Mark => ({ text: " ", ok: false }));
    for (const m of more) {
      marks.push(m);
      at.push(m.text === " " && m.ok === null ? null : places[c]!);
    }
  });
  return (
    <span className="text rightonly" data-testid={testId}>
      <Marked marks={marks} dot={() => true} attrs={attrs} at={at} />
    </span>
  );
}

/** Your copy exactly as you typed it, a dot under each character: blue if
 *  right, red if not. Nothing is added for what you missed, so it lines up
 *  with the same copy in a box. */
export function YourMarks({
  sent,
  typed,
  attrs,
  testId,
}: {
  sent: string;
  typed: string;
  attrs?: SentAttrs | undefined;
  testId?: string;
}): React.ReactElement {
  if (!typed.trim()) {
    return (
      <span className="text yourmarks" data-testid={testId}>
        (nothing copied)
      </span>
    );
  }
  const grade = gradeCopy(sent, typed);
  return (
    <span className="text yourmarks" data-testid={testId}>
      <Marked marks={grade.yours} dot={() => true} attrs={attrs} at={grade.yourSent} />
    </span>
  );
}

/** Your copy exactly as you typed it, with no marks. */
export function YourCopy({
  sent,
  typed,
  attrs,
  testId,
}: {
  sent: string;
  typed: string;
  attrs?: SentAttrs | undefined;
  testId?: string;
}): React.ReactElement {
  if (!typed.trim()) {
    return (
      <span className="text locked" data-testid={testId}>
        (nothing copied)
      </span>
    );
  }
  const grade = gradeCopy(sent, typed);
  return (
    <span className="text locked" data-testid={testId}>
      <Marked marks={grade.yours} dot={() => false} attrs={attrs} at={grade.yourSent} />
    </span>
  );
}

/** What was sent, a red dot under each character your copy missed. A row of
 *  its own, under your copy as it already shows. */
export function SentMarks({
  sent,
  typed,
  attrs,
}: {
  sent: string;
  typed: string;
  attrs?: SentAttrs | undefined;
}): React.ReactElement {
  return (
    <span className="text sentmarks" data-testid="copy-answer">
      <Marked marks={gradeCopy(sent, typed).sent} dot={(ok) => !ok} attrs={attrs} />
    </span>
  );
}

/** Columns split at the spaces between the words sent: a word keeps its
 *  columns on one line, and a long line breaks between words. A space you
 *  typed where none was sent is left out, so the sent row shows no gap
 *  that was not sent. */
function wordsOf(columns: readonly Column[]): Column[][] {
  const words: Column[][] = [[]];
  for (const col of columns) {
    if (col.sent[0]?.text === " ") words.push([]);
    else if (col.sent.length === 0 && col.yours.every((m) => m.text === " ")) continue;
    else words[words.length - 1]!.push(col);
  }
  return words.filter((w) => w.length > 0);
}

/** How many of `marks` are characters rather than spaces or gaps. */
function count(marks: readonly Mark[]): number {
  return marks.filter((m) => m.ok !== null).length;
}

/** For each column, the place of the character sent that it lines up with,
 *  counted from 0. A column with nothing sent takes the place before it, or
 *  the first. A space between words has none. */
function columnPlaces(columns: readonly Column[]): (number | null)[] {
  let k = 0;
  return columns.map((col) => {
    const n = count(col.sent);
    if (n === 0 && col.yours.every((m) => m.text === " ")) return null;
    const place = n > 0 ? k : Math.max(0, k - 1);
    k += n;
    return place;
  });
}

/** Your copy, graded: what you typed over what was sent, lined up character
 *  by character. Blue under each character you got right, red under each you
 *  got wrong and under each you missed. Then the count. */
export function Graded({
  sent,
  typed,
  attrs,
  showCount = true,
}: {
  sent: string;
  typed: string;
  attrs?: SentAttrs | undefined;
  /** The count under it. Off where the page shows the score itself. */
  showCount?: boolean;
}): React.ReactElement {
  const grade = gradeCopy(sent, typed);
  // Nothing copied: the sent line alone, every character missed.
  if (!typed.trim()) {
    return (
      <span className="text graded">
        <span className="sentcopy" data-testid="qso-aligned">
          <Marked marks={grade.sent} dot={(ok) => !ok} attrs={attrs} />
        </span>
        {showCount && (
          <span className="copied">
            Nothing copied. {grade.right} of {grade.total} copied
          </span>
        )}
      </span>
    );
  }
  let k = 0;
  const placeList = columnPlaces(grade.columns);
  const places = new Map(grade.columns.map((col, c) => [col, placeList[c]!]));
  return (
    <span className="text graded">
      <span className="aligned" data-testid="qso-aligned">
        {wordsOf(grade.columns).map((word, w) => (
          <span key={w} className="cword">
            {word.map((col, c) => {
              const first = k;
              k += count(col.sent);
              return (
                <span key={c} className="ccol">
                  <span className="yourcopy">
                    <Marked
                      marks={col.yours}
                      dot={() => true}
                      attrs={attrs}
                      at={col.yours.map(() => places.get(col) ?? null)}
                    />
                  </span>
                  <span className="sentcopy">
                    <Marked marks={col.sent} dot={(ok) => !ok} attrs={attrs} first={first} />
                  </span>
                </span>
              );
            })}
          </span>
        ))}
      </span>
      {showCount && (
        <span className="copied">
          {grade.right} of {grade.total} copied
        </span>
      )}
    </span>
  );
}
