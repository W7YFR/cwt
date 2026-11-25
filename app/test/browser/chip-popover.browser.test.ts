/* A quick setting's popover stays in the window when its chip moves.
 *
 * A change made in the popover changes the chip's value, and so its width.
 * At the end of a full line the chip then wraps to the next line, or comes
 * back up. The popover moves with the chip. Placed only when it opened, it
 * kept its old offset and ran off the left or the right edge.
 *
 * At the right end of a line, a chip that gets narrower moves right in
 * place. The popover moves into the window's scrollbar gutter, which the
 * window counts as in view.
 *
 * Geometry, so a real browser: jsdom has no layout and no intersections.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@/ui/base.css";
import { QuickChip, Toolbar } from "@/ui/Toolbar";

const SHORT = "Off";
const LONG = "A much longer value";

let host: HTMLElement;
let root: Root;
let line: HTMLStyleElement;

beforeEach(async () => {
  await page.viewport(700, 600);
  host = document.createElement("div");
  host.style.padding = "0 16px";
  /* The chips on a line of their own, as on the QSO page. */
  line = document.createElement("style");
  line.textContent = ".toolchips { flex-basis: 100%; }";
  document.head.append(line);
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  line.remove();
});

/** A filler as wide as `filler()` says, then the chip under test, whose
 *  popover has one button to switch its value. */
function Bar({ start, filler, to }: { start: string; filler: () => number; to?: string }): React.ReactElement {
  const [value, setValue] = useState(start);
  return createElement(Toolbar, {
    actions: null,
    chips: [
      createElement("div", { key: "filler", "data-testid": "filler", style: { width: filler(), height: 1 } }),
      createElement(QuickChip, {
        key: "chip",
        id: "test",
        label: "Test",
        value,
        tab: "page",
        children: createElement(
          "button",
          { type: "button", "data-testid": "switch", onClick: () => setValue((v) => to ?? (v === SHORT ? LONG : SHORT)) },
          "Switch",
        ),
      }),
    ],
  });
}

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** The filler that leaves room on the first line for the chip with SHORT,
 *  and not with LONG. */
async function fillerWidth(): Promise<number> {
  let w = 0;
  await act(async () => root.render(createElement(Bar, { start: SHORT, filler: () => w })));
  const line = $<HTMLElement>(".toolchips").clientWidth;
  const chip = $<HTMLElement>("[data-testid='chip-test']").offsetWidth;
  w = line - chip - 6 - 2;
  await act(async () => root.unmount());
  root = createRoot(host);
  return w;
}

async function popoverAfterSwitch(start: string): Promise<{ moved: boolean; left: number; right: number; window: number }> {
  const w = await fillerWidth();
  await act(async () => root.render(createElement(Bar, { start, filler: () => w })));
  const chip = $<HTMLElement>("[data-testid='chip-test']");
  await act(async () => chip.click());
  const top = chip.getBoundingClientRect().top;
  await act(async () => $<HTMLElement>("[data-testid='switch']").click());
  await frames();
  const pop = $<HTMLElement>("[data-testid='pop-test']").getBoundingClientRect();
  return { moved: chip.getBoundingClientRect().top !== top, left: pop.left, right: pop.right, window: document.documentElement.clientWidth };
}

describe("a quick setting's popover", () => {
  it("stays in the window when its chip wraps to the next line", async () => {
    const r = await popoverAfterSwitch(SHORT);
    expect(r.moved, "the chip wrapped").toBe(true);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(r.window);
  });

  it("stays in the window when its chip comes back to the line above", async () => {
    const r = await popoverAfterSwitch(LONG);
    expect(r.moved, "the chip moved up").toBe(true);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(r.window);
  });

  it("stays in from the edge when its chip gets narrower at the right end of a line", async () => {
    line.remove();
    await act(async () => root.render(createElement(Bar, { start: "Paced", to: "Zen", filler: () => 0 })));
    const chip = $<HTMLElement>("[data-testid='chip-test']");
    await act(async () => chip.click());
    const left = chip.getBoundingClientRect().left;
    await act(async () => $<HTMLElement>("[data-testid='switch']").click());
    await frames();
    const pop = $<HTMLElement>("[data-testid='pop-test']").getBoundingClientRect();
    expect(chip.getBoundingClientRect().left, "the chip moved right").toBeGreaterThan(left);
    expect(pop.right).toBeLessThanOrEqual(document.documentElement.clientWidth - 16);
  });
});
