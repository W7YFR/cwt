/* Rebuild the raster icons from favicon.svg.
 *
 * The shape is written down once, in app/public/favicon.svg. Everything else
 * the page asks for is a rasterisation of it, and before this script those
 * rasterisations were committed binaries with nothing tying them to the
 * source: edit the SVG and the PNGs kept the old drawing, silently, on every
 * surface that does not use the SVG — which is every installed icon and every
 * browser tab that prefers the .ico.
 *
 * Two families come out of the one file:
 *
 *   favicon.ico          transparent, the light-scheme ink, at 16/32/48.
 *                        Rendered from favicon.svg directly — rsvg resolves
 *                        `currentColor` from the stylesheet's `color`, so the
 *                        default rule is what lands.
 *   the PNG tiles        a dark ground with the dark-scheme ink, at the sizes
 *                        the manifest and iOS ask for. A platform composites a
 *                        transparent icon onto whatever it likes, so these
 *                        bring their own background.
 *
 * The tiles are the same file with two edits made in memory: a ground behind
 * the mark, and the ink forced to the dark-scheme colour. Both anchors are
 * asserted rather than assumed — a silent no-match here would ship the light
 * ink on a dark tile, which is nearly invisible and easy to miss in a diff.
 *
 * Needs `rsvg-convert` (librsvg) and `magick` (ImageMagick) on PATH. Neither is
 * a dependency of the app; this runs when the drawing changes, which is rarely.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "app", "public");
const SOURCE = join(PUBLIC, "favicon.svg");

/** The tile's ground, and the ink that shows up on it. Both are the app's own
 *  tokens: `--bg` and the dark-scheme `--you` from ui/base.css. */
const GROUND = "#12151a";
const DARK_INK = "#6aa9ff";
/** In a 48-unit viewBox — the radius the tiles have always had. */
const TILE_RADIUS = 9;

/** @param {string} tool */
function need(tool) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    console.error(
      `✗ ${tool} is not on PATH.\n` +
        "  This target rasterises an SVG and packs an .ico, which needs\n" +
        "  librsvg and ImageMagick:  brew install librsvg imagemagick",
    );
    process.exit(1);
  }
}

/** The same drawing, on a ground, in the ink a dark tile needs.
 *  @param {string} svg
 *  @returns {string} */
function tileSource(svg) {
  const open = svg.match(/<svg\b[^>]*>/);
  if (!open) throw new Error("favicon.svg has no <svg> tag to insert a ground after");
  const ground =
    `<rect width="48" height="48" rx="${TILE_RADIUS}" fill="${GROUND}"/>`;
  let out = svg.replace(open[0], `${open[0]}\n  ${ground}`);

  /* An inline style rather than an edit to the stylesheet: it beats the class
     rule and the media query both, so the result does not depend on what
     colour scheme the renderer decides it is in. */
  const marked = '<g class="mark">';
  if (!out.includes(marked)) throw new Error(`favicon.svg has no ${marked} to re-ink`);
  out = out.replace(marked, `<g class="mark" style="color: ${DARK_INK}">`);
  return out;
}

/** @param {string} src @param {number} size @param {string} out */
function render(src, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), src, "-o", out]);
}

need("rsvg-convert");
need("magick");

const work = mkdtempSync(join(tmpdir(), "cwt-icons-"));
try {
  const svg = readFileSync(SOURCE, "utf8");

  // The .ico carries three sizes. Each is rendered from the vector rather than
  // downscaled from the largest, so the small ones get their own hinting-free
  // but correctly-sampled pass instead of a blur of the big one.
  const icoParts = [16, 32, 48].map((/** @type {number} */ size) => {
    const out = join(work, `ico-${size}.png`);
    render(SOURCE, size, out);
    return out;
  });
  execFileSync("magick", [...icoParts, join(PUBLIC, "favicon.ico")]);

  const tile = join(work, "tile.svg");
  writeFileSync(tile, tileSource(svg));
  /* Named rather than a tuple: a mixed array infers as (string | number)[],
     and unpacking it hands `render` a size that might be a filename. */
  const tiles = [
    { size: 180, name: "apple-touch-icon.png" },
    { size: 192, name: "icon-192.png" },
    { size: 512, name: "icon-512.png" },
  ];
  for (const { size, name } of tiles) render(tile, size, join(PUBLIC, name));

  console.log("✓ favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png");
  console.log("  from app/public/favicon.svg — review the diff, it is what users see.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
