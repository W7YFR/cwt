/* The name, in one place.
 *
 * Two forms of it: a big drawing on the landing screen, and the small word in
 * the page header that takes you back. Both come from here so they can never
 * drift apart, and so the name lives somewhere other than inside a heading in
 * the middle of a screen.
 *
 * The drawing is one of sixteen, picked at random on each visit — see
 * wordmarks.ts for the catalog and for the roll. Nothing here assumes a size,
 * because they range from 20 to 68 columns and from 4 to 11 rows. All this
 * passes on is the shape; the CSS scales each drawing to fit the room it has,
 * which is a page-width box in the hero and a row height in the header.
 *
 * Two rules in the CSS are what make the art art, and it falls apart without
 * either: `white-space: pre`, and `line-height: 1` so consecutive rows touch
 * instead of being separated by a stripe of background. Screen readers get the
 * name, not the picture — `role="img"` with a label keeps a drawing from being
 * read out one character at a time.
 */

import type { WordmarkArt } from "./wordmarks";
import { visitWordmark, wordmarkCols, wordmarkText } from "./wordmarks";

export const APP_NAME = "CWT";
export const APP_LONG_NAME = "CW Trainer";

/** The name in running text. Always in the blue of your sending, so it reads
 *  as the app's name wherever it appears. */
export function AppName(): React.ReactElement {
  return <span className="appname">{APP_NAME}</span>;
}

/** Morse for C, W and T — the letters above, keyed. */
export const APP_MORSE = "-.-.  .--  -";

/** The size calcs in the CSS need the drawing's shape. Custom properties
 *  rather than a computed pixel size, so the hero still shrinks with the
 *  viewport and the header version still fits its row.
 *
 *  The two are constrained differently, which is why both numbers go out: the
 *  hero is as wide as the page allows and however tall that makes it, while
 *  the header has a row height to fit and however wide that makes it. */
function sizing(art: WordmarkArt): React.CSSProperties {
  return {
    "--cols": String(wordmarkCols(art)),
    "--rows": String(art.rows.length),
  } as React.CSSProperties;
}

export function Wordmark({ art }: { art: WordmarkArt }): React.ReactElement {
  return (
    <h1 className="wordmark">
      <span className="artbox">
        <span
          className="art"
          role="img"
          aria-label={`${APP_NAME} — ${APP_LONG_NAME}`}
          data-art={art.id}
          style={sizing(art)}
        >
          {wordmarkText(art)}
        </span>
        {/* Inside the box with the drawing, so the two center as one unit. As
            a sibling it would sit at the foot of the reserve instead, a
            hundred pixels adrift from a short drawing. */}
        <span className="morse" aria-hidden="true">
          {APP_MORSE}
        </span>
      </span>
    </h1>
  );
}

/** The same drawing at header size.
 *
 * Scaled to fit the header's row height rather than to a font size, because
 * the drawings are 4 to 11 rows tall: one font size would make the short ones
 * tiny and push the tall ones out of the row.
 *
 * Hidden from screen readers — the button around it carries the name, and two
 * labels for one control is one too many. */
export function Brandmark({ art }: { art: WordmarkArt }): React.ReactElement {
  return (
    <span className="art" aria-hidden="true" data-art={art.id} style={sizing(art)}>
      {wordmarkText(art)}
    </span>
  );
}

/** The name in a page header: the way back to the start screen.
 *
 * The same drawing the landing screen showed: the roll is per visit, not per
 * mount, so arriving on a page does not quietly change the logo. */
export function HomeButton({ onHome, disabled }: { onHome(): void; disabled?: boolean }): React.ReactElement {
  return (
    <h1 className="brand">
      <button
        className="brandmark"
        onClick={onHome}
        disabled={disabled}
        title={`Back to the ${APP_NAME} start screen`}
        // The drawing is decoration; the name is what this control is called,
        // and it has to survive being unreadable at this size.
        aria-label={APP_NAME}
      >
        <Brandmark art={visitWordmark()} />
      </button>
    </h1>
  );
}
