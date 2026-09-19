/* The wordmarks, rendered against the real stylesheet.
 *
 * ASCII art can be broken in ways a structural assertion cannot see. Art built
 * from slashes and underscores assumes a terminal cell that a glyph fills edge
 * to edge; in a browser's monospace face those glyphs do not touch, and the
 * letters render as a field of disconnected strokes while every check for a
 * labeled element still passes.
 *
 * So these check the properties the picture actually depends on, for every
 * drawing rather than for one. Most of them are CSS, which is why this runs in
 * a browser: jsdom applies no stylesheet and would report the defaults.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Brandmark, Wordmark } from "@/ui/Wordmark";
import { WORDMARKS, pickWordmark, wordmarkById, wordmarkCols } from "@/ui/wordmarks";
import "@/ui/base.css";

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement("div");
  // The rules are scoped to the landing screen, which is where the big form
  // appears.
  host.className = "landing";
  document.body.appendChild(host);
});

afterEach(() => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  host.remove();
});

async function draw(index: number): Promise<HTMLElement> {
  /* One root for the host, re-rendered — not a fresh root per drawing. The
     catalog test draws all of them in a loop, and a second createRoot() on a
     container that already has one is React telling you it will not do what
     you meant: forty-five of those, and the measurements after the first were
     of a root nobody was updating. */
  root ??= createRoot(host);
  const r = root;
  await act(async () => {
    r.render(createElement(Wordmark, { art: WORDMARKS[index]! }));
  });
  return host.querySelector<HTMLElement>(".wordmark .art")!;
}

describe("the wordmark catalog", () => {
  it("has every drawing as a rectangle of equal-length rows", () => {
    expect(WORDMARKS.length).toBeGreaterThan(1);
    for (const art of WORDMARKS) {
      // A row short by one character shifts every letter to its right, and the
      // only way to notice that by eye is to already know what it should be.
      const widths = new Set(art.rows.map((r) => r.length));
      expect(widths, `${art.id} has ragged rows`).toHaveLength(1);
      expect(art.rows.length).toBeGreaterThan(2);
      expect(wordmarkCols(art)).toBe(art.rows[0]!.length);
    }
  });

  it("gives every drawing a distinct id and a name to pick it by", () => {
    const ids = new Set(WORDMARKS.map((w) => w.id));
    // Ids are what a saved preference stores, so a duplicate would silently
    // resolve to whichever came first.
    expect(ids.size).toBe(WORDMARKS.length);
    for (const art of WORDMARKS) {
      expect(art.name.trim()).not.toBe("");
      expect(wordmarkById(art.id)).toBe(art);
    }
    expect(wordmarkById("no-such-drawing")).toBeNull();
  });

  it("can reach every drawing at random, and never lands outside the list", () => {
    const seen = new Set<string>();
    for (let i = 0; i < WORDMARKS.length; i++) {
      // Sample the middle of each slot, plus the two ends of the range — 1.0
      // is what would index one past the last.
      seen.add(pickWordmark(() => (i + 0.5) / WORDMARKS.length).id);
    }
    expect(seen.size).toBe(WORDMARKS.length);
    expect(pickWordmark(() => 0)).toBe(WORDMARKS[0]);
    expect(pickWordmark(() => 0.999999)).toBe(WORDMARKS[WORDMARKS.length - 1]);
    expect(pickWordmark(() => 1)).toBe(WORDMARKS[WORDMARKS.length - 1]);
  });
});

describe("a wordmark on the page", () => {
  it("draws each one at its full size, without wrapping a row", async () => {
    for (let i = 0; i < WORDMARKS.length; i++) {
      const art = WORDMARKS[i]!;
      const el = await draw(i);
      const size = parseFloat(getComputedStyle(el).fontSize);
      const box = el.getBoundingClientRect();
      // Rows drawn as rows. Wrapping — which is what happens the moment
      // `white-space: pre` is lost — would make this taller.
      expect(box.height, `${art.id} wrapped`).toBeCloseTo(art.rows.length * size, 0);
      act(() => root!.unmount());
      root = null;
    }
  });

  it("takes up the same room whichever one it is", async () => {
    /* The drawings are 4 to 11 rows tall and the hero fills the page width, so
       the natural height swings by about 200 pixels. Without a reserve, every
       reload shoves the whole page up or down — a strange thing for a random
       logo to do to everything below it. */
    const heights = new Set<string>();
    for (let i = 0; i < WORDMARKS.length; i++) {
      await draw(i);
      const h1 = host.querySelector<HTMLElement>(".wordmark")!;
      // Sub-pixel: a min-height on the heading left a one-pixel wobble,
      // because the drawing's own height is rows times a fractional font size
      // and could round up past the reserve.
      heights.add(h1.getBoundingClientRect().height.toFixed(2));
      act(() => root!.unmount());
      root = null;
    }
    expect(heights.size, `heights seen: ${[...heights].join(", ")}`).toBe(1);
  });

  it("keeps the keyed line with the drawing, not at the foot of the reserve", async () => {
    // The drawing and the keyed line center together inside the reserve. As
    // siblings the line sat at the bottom of the box, a long way adrift from a
    // short drawing.
    for (const i of [0, WORDMARKS.length - 1]) {
      const art = await draw(i);
      const morse = host.querySelector<HTMLElement>(".morse")!;
      const gap = morse.getBoundingClientRect().top - art.getBoundingClientRect().bottom;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap, `${WORDMARKS[i]!.id} left the keyed line adrift`).toBeLessThan(40);
      act(() => root!.unmount());
      root = null;
    }
  });

  it("stacks the rows edge to edge, so the strokes join up", async () => {
    const style = getComputedStyle(await draw(0));
    // A line-height over 1 lays a stripe of background between every row and
    // the letters come apart. This is the difference between a wordmark and a
    // pile of fragments.
    expect(parseFloat(style.lineHeight)).toBeCloseTo(parseFloat(style.fontSize), 1);
    expect(style.whiteSpace).toBe("pre");
    // A monospace face is the other half of it: in a proportional one the
    // columns do not line up at all.
    expect(style.fontFamily).toMatch(/mono/i);
  });

  it("scales each drawing to fill the room it is given", async () => {
    /* The catalog runs from 20 to 68 columns and 4 to 11 rows, so one font
       size would leave some of them unreadably small and push others off the
       page. Each is scaled to whichever bound runs out first, which means two
       things worth holding: none overflows its box, and none rattles around
       inside it — whichever dimension binds is filled. */
    for (let i = 0; i < WORDMARKS.length; i++) {
      const art = await draw(i);
      const box = host.querySelector<HTMLElement>(".artbox")!.getBoundingClientRect();
      const drawn = art.getBoundingClientRect();
      const id = WORDMARKS[i]!.id;

      expect(drawn.width, `${id} is wider than the page`).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      expect(drawn.height, `${id} overflows its box`).toBeLessThanOrEqual(box.height + 1);

      // One of the two is filled to within a cell, or the drawing is smaller
      // than it needs to be.
      const fillsHeight = drawn.height > box.height * 0.75;
      const fillsWidth = drawn.width > host.getBoundingClientRect().width * 0.75;
      expect(fillsHeight || fillsWidth, `${id} rattles around in its box`).toBe(true);
    }
  });

  it("fits any drawing into the header's row, whatever its shape", async () => {
    // The header has a row height to fit and the drawings are 4 to 11 rows
    // tall, so this is sized by rows where the hero is sized by columns. A
    // shared font size would make the short ones tiny and push the tall ones
    // out of the row.
    const heights = new Set<number>();
    for (const art of WORDMARKS) {
      root = createRoot(host);
      const r = root;
      await act(async () => {
        r.render(
          createElement("span", { className: "brandmark" }, createElement(Brandmark, { art })),
        );
      });
      heights.add(Math.round(host.querySelector(".art")!.getBoundingClientRect().height));
      act(() => r.unmount());
      root = null;
    }
    // Every one of them the same height, which is what "fits the row" means.
    expect(heights.size).toBe(1);
  });

  it("says its name to a screen reader instead of spelling out the drawing", async () => {
    const el = await draw(0);
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toMatch(/CWT/);
    // The keyed version underneath is decoration on top of the same name.
    expect(host.querySelector(".morse")!.getAttribute("aria-hidden")).toBe("true");
  });
});
