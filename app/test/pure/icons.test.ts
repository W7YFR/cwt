/* The icons the page asks for, and whether they are there.
 *
 * A missing favicon is the quietest failure in the app: the browser asks, gets
 * a 404, and shows its own blank page glyph. Nothing is logged where anyone
 * would see it, and the only symptom is a tab that looks like every other tab.
 * So the page's own markup is read, and every local file it names has to
 * exist.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findUp(rel: string): string {
  let at = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(at, rel);
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return join(resolve(process.cwd()), rel);
}

const HTML = readFileSync(findUp("app/index.html"), "utf8");
const PUBLIC = findUp("app/public");

/** Every local file the page names in a href or src. */
function referenced(): string[] {
  return [...HTML.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((h) => !/^(https?:)?\/\//.test(h) && !h.startsWith("/src/"));
}

describe("the icons the page asks for", () => {
  it("names some", () => {
    // Otherwise the check below passes by having nothing to check.
    expect(referenced().length).toBeGreaterThan(3);
  });

  it("has a file for every one of them", () => {
    for (const href of referenced()) {
      expect(existsSync(join(PUBLIC, href)), href).toBe(true);
    }
  });

  it("asks for them relatively, so a project subpath still finds them", () => {
    /* Pages serves a project site from /<repo>/. A root-absolute icon would be
       looked for on the domain root and quietly 404 there while working
       perfectly in development — see the base in vite.config.ts. */
    for (const href of referenced()) {
      expect(href.startsWith("/"), href).toBe(false);
    }
  });

  it("offers both a scalable icon and one for what cannot scale", () => {
    expect(HTML).toMatch(/rel="icon"[^>]*favicon\.svg/);
    expect(HTML).toMatch(/favicon\.ico/);
    expect(HTML).toMatch(/rel="apple-touch-icon"/);
  });

  it("ships a manifest that names icons it actually has", () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC, "site.webmanifest"), "utf8"));
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(existsSync(join(PUBLIC, icon.src)), icon.src).toBe(true);
    }
  });
});
