/* The link preview: the card a chat app or a social site draws for a shared
 * address.
 *
 * Its tags hold absolute URLs, because a crawler resolves nothing relative —
 * which also puts them out of reach of the icon test, which checks local paths
 * only. And it fails the same quiet way a favicon does: a missing image is a
 * card with no picture, seen by somebody else, on another site, long after the
 * deploy. So the page's own markup is read, and the image it names has to be
 * in app/public, at the size the tags claim.
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
/** Where the site is served. Every absolute URL in the tags is under it. */
const SITE = "https://www.w7yfr.com/cwt/";

function meta(property: string): string | undefined {
  const m = HTML.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`));
  return m?.[1];
}

/** Width and height out of a PNG's IHDR chunk, which is always first. */
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe("the link preview", () => {
  it("names a title, a description and an image", () => {
    for (const p of ["og:title", "og:description", "og:image", "og:url", "twitter:card"]) {
      expect(meta(p), p).toBeTruthy();
    }
  });

  it("points at the live site, absolutely", () => {
    expect(meta("og:url")).toBe(SITE);
    expect(meta("og:image")?.startsWith(SITE)).toBe(true);
  });

  it("has the image it names, at the size it says", () => {
    const file = join(PUBLIC, meta("og:image")!.slice(SITE.length));
    expect(existsSync(file), file).toBe(true);
    expect(pngSize(file)).toEqual({
      width: Number(meta("og:image:width")),
      height: Number(meta("og:image:height")),
    });
  });
});
