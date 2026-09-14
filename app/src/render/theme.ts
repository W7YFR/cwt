/* The palette, read from CSS rather than duplicated in JavaScript.
 *
 * The stylesheet owns the colors — including the light/dark swap — and the
 * canvas asks it what they are. Two copies of a palette diverge the first time
 * someone adjusts one of them, and a canvas that ignores the page's theme is
 * the most obvious way for that to show.
 */

export const PALETTE_KEYS = [
  "ink",
  "ink-dim",
  "ink-faint",
  "line",
  "panel",
  "panel-2",
  "you",
  "tgt",
  "ok",
  "warn",
  "bad",
  "ghost",
  "rest",
  "mono",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Record<PaletteKey, string>;

/** Used when there is no document to ask — the pure test tier, and the first
 *  frame before styles resolve. Values mirror the dark theme in style.css. */
export const FALLBACK_PALETTE: Palette = {
  ink: "#e6eaf0",
  "ink-dim": "#97a3b6",
  "ink-faint": "#66708a",
  line: "#2e3644",
  panel: "#1a1f27",
  "panel-2": "#222937",
  you: "#6aa9ff",
  tgt: "#8b95a7",
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f4564a",
  ghost: "#4b5566",
  rest: "#a371f7",
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** Read the live palette off an element's computed style. */
export function readPalette(from?: Element | null): Palette {
  if (typeof getComputedStyle !== "function" || !from) return FALLBACK_PALETTE;
  const cs = getComputedStyle(from);
  const out = { ...FALLBACK_PALETTE };
  for (const key of PALETTE_KEYS) {
    const v = cs.getPropertyValue(`--${key}`).trim();
    if (v) out[key] = v;
  }
  return out;
}
