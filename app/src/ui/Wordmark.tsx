/* The name, in one place.
 *
 * Two forms of it: a big drawing on the landing screen, and the small word in
 * the review header that takes you back. Both come from here so they can never
 * drift apart, and so the name lives somewhere other than inside a heading in
 * the middle of a screen.
 *
 * The drawing is one of sixteen, picked at random on each visit — see
 * wordmarks.ts for the catalog and for the roll. Nothing here assumes a size,
 * because they range from 20 to 68 columns and from 4 to 11 rows; the CSS
 * derives the font size from the shape this passes it, so a wide drawing and a
 * narrow one land at about the same width in the hero, and all of them fit the
 * same row in the header.
 *
 * Two rules in the CSS are what make the art art, and it falls apart without
 * either: `white-space: pre`, and `line-height: 1` so consecutive rows touch
 * instead of being separated by a stripe of background. Screen readers get the
 * name, not the picture — `role="img"` with a label keeps a drawing from being
 * read out one character at a time.
 */

import type { WordmarkArt } from "./wordmarks";
import { HERO_RESERVE, wordmarkCols, wordmarkText } from "./wordmarks";

export const APP_NAME = "CWT";
export const APP_LONG_NAME = "CW Trainer";

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
    /* The reserve box holds open the height of the tallest drawing, so that
       reloading the page does not shove everything below the wordmark up and
       down as the roll changes. See HERO_RESERVE for how the height is
       arrived at. */
    <h1 className="wordmark" style={{ "--wm-reserve": HERO_RESERVE } as React.CSSProperties}>
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
        {/* Inside the box with the drawing, so the two centre as one unit. As
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
