/* Rebuild the raster icons from favicon.svg.
 *
 * The shape is written down once, in app/public/favicon.svg. Everything else
 * the page asks for is a rasterisation of it, and before this script those
 * rasterisations were committed binaries with nothing tying them to the
 * source: edit the SVG and the PNGs kept the old drawing, silently, on every
 * surface that does not use the SVG — which is every installed icon and every
 * browser tab that prefers the .ico.
 *
 * Everything is a straight rasterisation of that one file, at the sizes the
 * page, the manifest and iOS ask for. That is worth saying because it was not
 * always true: the favicon used to be transparent and pick its ink from
 * `prefers-color-scheme`, so the tiles had to be built by editing the drawing
 * in memory — a ground rammed in behind it and the ink forced to one colour.
 * Now the ground is in the drawing, and this script only changes the size.
 *
 * The .ico carries three sizes and each is rendered from the vector rather
 * than downscaled from the largest, so the small ones get a correctly-sampled
 * pass of their own instead of a blur of the big one.
 *
 * Needs `rsvg-convert` (librsvg) and `magick` (ImageMagick) on PATH. Neither is
 * a dependency of the app; this runs when the drawing changes, which is rarely.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "app", "public");
const SOURCE = join(PUBLIC, "favicon.svg");

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

/** @param {string} src @param {number} size @param {string} out */
function render(src, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), src, "-o", out]);
}

need("rsvg-convert");
need("magick");

const work = mkdtempSync(join(tmpdir(), "cwt-icons-"));
try {
  const icoParts = [16, 32, 48].map((/** @type {number} */ size) => {
    const out = join(work, `ico-${size}.png`);
    render(SOURCE, size, out);
    return out;
  });
  execFileSync("magick", [...icoParts, join(PUBLIC, "favicon.ico")]);

  /* Named rather than a tuple: a mixed array infers as (string | number)[],
     and unpacking it hands `render` a size that might be a filename. */
  const tiles = [
    { size: 180, name: "apple-touch-icon.png" },
    { size: 192, name: "icon-192.png" },
    { size: 512, name: "icon-512.png" },
  ];
  for (const { size, name } of tiles) render(SOURCE, size, join(PUBLIC, name));

  console.log("✓ favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png");
  console.log("  from app/public/favicon.svg — review the diff, it is what users see.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
