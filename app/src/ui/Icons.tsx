/* The app's icons, drawn rather than typed.
 *
 * These were characters: ⚙ for configuration, ● for record, ↑ and ↓ on the
 * buttons that move a file, ▶ and ■ on the sound-path preview. A character is
 * whatever the system's font decides it is — ⚙ in particular is inside the
 * emoji block, so it arrives as a flat outline on one machine and a shaded
 * color pictogram on the next, and neither is the size or the ink the button
 * around it was designed for. Half of them are not in every font at all, and
 * the fallback for a missing glyph is a box.
 *
 * So: one path each, in `currentColor`, sized in `em`.
 *
 * `currentColor` matters more than it looks — every rule that colors these
 * buttons already exists and goes on working untouched: the record dot is
 * `var(--bad)` from `.recdot`, a disabled button drops its icon to
 * `--ink-faint`, and the cog dims with the corner it sits in. An icon with a
 * color of its own would have needed all of that written a second time.
 *
 * `1em` rather than pixels for the same reason: `.iconbtn` sets a font size
 * and these follow it, so nothing downstream has to know an icon stopped being
 * a character.
 *
 * All on a 16-unit grid, which is what keeps them looking like one set — the
 * same stroke weight, the same optical size, the same distance from the edge.
 */

/** Shared frame. `aria-hidden` throughout: every one of these sits inside a
 *  control that already carries its own name, and an icon that announced
 *  itself would say it twice. `data-icon` is the anchor to assert against —
 *  a name rather than a glyph, so a redrawing is not a test change. */
function Icon({
  name,
  children,
  stroke = false,
}: {
  name: string;
  children: React.ReactNode;
  /** Outlined rather than solid. The arrows and the chevron are strokes; the
   *  gear, the dot, the triangle and the square are shapes. */
  stroke?: boolean;
}): React.ReactElement {
  return (
    <svg
      className="icon"
      data-icon={name}
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      {...(stroke
        ? {
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round" as const,
            strokeLinejoin: "round" as const,
          }
        : { fill: "currentColor" })}
    >
      {children}
    </svg>
  );
}

/* Eight teeth, evenly spaced, with the hole punched by `evenodd` rather than
   by painting a second circle in the background color — the background under
   this button is not one color, and on the landing screen it is not the same
   color it is in the header. Generated from the geometry rather than typed:
   teeth drawn by hand are never quite the same size as each other, and at this
   size that reads as a smudge rather than as a mistake.
   
   Drawn a size down from the rest of the set, not up. A gear is a disc with
   spikes on it — it fills its corner of the grid in every direction at once,
   where an arrow is a line and a triangle is mostly the empty half of its box.
   Given the same room it reads as the biggest thing on the screen, which is
   what it did: teeth to within half a unit of the edge while everything beside
   it sat a comfortable two units inside. */
const GEAR =
  "M6.68 1.64A6.5 6.5 0 0 1 9.32 1.64L9.37 3.29A4.9 4.9 0 0 1 10.36 3.71" +
  "L11.57 2.57A6.5 6.5 0 0 1 13.43 4.43L12.29 5.64A4.9 4.9 0 0 1 12.71 6.63" +
  "L14.36 6.68A6.5 6.5 0 0 1 14.36 9.32L12.71 9.37A4.9 4.9 0 0 1 12.29 10.36" +
  "L13.43 11.57A6.5 6.5 0 0 1 11.57 13.43L10.36 12.29A4.9 4.9 0 0 1 9.37 12.71" +
  "L9.32 14.36A6.5 6.5 0 0 1 6.68 14.36L6.63 12.71A4.9 4.9 0 0 1 5.64 12.29" +
  "L4.43 13.43A6.5 6.5 0 0 1 2.57 11.57L3.71 10.36A4.9 4.9 0 0 1 3.29 9.37" +
  "L1.64 9.32A6.5 6.5 0 0 1 1.64 6.68L3.29 6.63A4.9 4.9 0 0 1 3.71 5.64" +
  "L2.57 4.43A6.5 6.5 0 0 1 4.43 2.57L5.64 3.71A4.9 4.9 0 0 1 6.63 3.29Z" +
  // The hole. A second subpath, so one fill rule makes it a hole.
  "M10.05 8A2.05 2.05 0 1 0 5.95 8A2.05 2.05 0 1 0 10.05 8Z";

export function IconCog(): React.ReactElement {
  return (
    <Icon name="cog">
      <path d={GEAR} fillRule="evenodd" />
    </Icon>
  );
}

/** The record dot. Colored by `.recdot` around it, like the character was. */
export function IconRecord(): React.ReactElement {
  return (
    <Icon name="record">
      <circle cx="8" cy="8" r="5.2" />
    </Icon>
  );
}

/* The two file arrows share a baseline, so they read as one pair pointing
   opposite ways rather than as two unrelated arrows. */
export function IconUpload(): React.ReactElement {
  return (
    <Icon name="upload" stroke>
      <path d="M8 11.9V2.8" />
      <path d="M4.6 6.2 8 2.8l3.4 3.4" />
      <path d="M2.6 13.6h10.8" />
    </Icon>
  );
}

export function IconDownload(): React.ReactElement {
  return (
    <Icon name="download" stroke>
      <path d="M8 2.8v9.1" />
      <path d="M4.6 8.5 8 11.9l3.4-3.4" />
      <path d="M2.6 13.6h10.8" />
    </Icon>
  );
}

export function IconPlay(): React.ReactElement {
  return (
    <Icon name="play">
      <path d="M5 2.9 13 8l-8 5.1Z" />
    </Icon>
  );
}

/* Bigger than the triangle's bounding box, not the same, because a square and
   a triangle of equal measurements do not look equal — the triangle is read by
   its point and the square by its whole area. Matched by eye at the size these
   are actually used at, which is 12px beside a word. */
export function IconStop(): React.ReactElement {
  return (
    <Icon name="stop">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" />
    </Icon>
  );
}

/** Which way the readout folds. The only icon with a direction to be told. */
export function IconChevron({ up = false }: { up?: boolean }): React.ReactElement {
  return (
    <Icon name={up ? "chevron-up" : "chevron-down"} stroke>
      <path d={up ? "M4 9.9 8 5.9l4 4" : "M4 6.1 8 10.1l4-4"} />
    </Icon>
  );
}
