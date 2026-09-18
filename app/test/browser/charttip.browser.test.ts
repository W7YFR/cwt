/* The chart's hover tooltip, in a real browser.
 *
 * Here rather than in the pure tier because what is under test is what reaches
 * the DOM, and only a real parser can answer that. The tooltip used to be
 * assembled as a string of HTML and handed to `dangerouslySetInnerHTML`. The
 * morse table writes prosigns in angle brackets — `<AR>`, `<BT>`, `<SK>` — so
 * interpolating one into that string produced `<b><AR></b>`, which parses as an
 * unknown element: the single piece of information the tooltip exists to give
 * disappeared, leaving a heading-less box of numbers. Nothing upstream could
 * see it. The decode was right, the layout was right, the hit test was right,
 * and the name still never made it to the screen.
 *
 * So this hovers a real prosign and reads the rendered text back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartView, type ChartHandle } from "@/ui/Chart";
import { buildLayout } from "@/render/layout";
import { trackBands } from "@/render/scene";
import { GUTTER } from "@/render/geometry";
import { caseNamed, reviewFrom } from "../fixture";
import "@/ui/base.css";

const PROSIGNS = caseNamed("synth-prosigns");

const WIDTH = 900;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = `${WIDTH}px`;
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

/** Mount the chart, then drag the pointer the whole way along the "yours" row
 *  and collect the heading of every tooltip that appears.
 *
 * A sweep rather than one computed pixel, because the two marker modes lay the
 * row out differently and a single coordinate that lands on a prosign in one of
 * them lands on its neighbour in the other. Sweeping asks the question the
 * tooltip actually has to answer — hover anywhere, get the right name — and
 * needs to know nothing about where a character ended up. */
function headingsAlongRow(charMarkers: boolean): {
  headings: Set<string>;
  tags: Set<string>;
} {
  const { review, settings: base } = reviewFrom(PROSIGNS);

  // Zoomed out far enough that the whole message is on screen at once, so the
  // sweep sees the prosign at the end as well as the one at the start.
  const probe = buildLayout(review, {
    view: base.view,
    ppu: base.ppu,
    durationSec: review.take.durationSec,
  });
  const ppu = Math.max(1, (base.ppu * (WIDTH - 2 * GUTTER)) / probe.width);
  const settings = { ...base, charMarkers, ppu };
  const handle: ChartHandle = { chart: null };

  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(ChartView, { review, settings, focus: null, playhead: null, handle }),
    );
  });

  const canvas = container.querySelector("canvas")!;
  handle.chart!.scrollTo(0);
  const rect = canvas.getBoundingClientRect();
  const band = trackBands(settings.view).you;
  const y = rect.top + (band[0] + band[1]) / 2;

  const headings = new Set<string>();
  const tags = new Set<string>();
  for (let x = GUTTER; x < WIDTH - GUTTER; x += 2) {
    act(() => {
      canvas.dispatchEvent(
        new MouseEvent("mousemove", { clientX: rect.left + x, clientY: y, bubbles: true }),
      );
    });
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    if (!tip) continue;
    const head = tip.querySelector("b")?.textContent;
    if (head) headings.add(head);
    for (const el of tip.querySelectorAll("*")) tags.add(el.tagName.toLowerCase());
  }
  return { headings, tags };
}

describe("the chart tooltip", () => {
  /** Every prosign the decoder actually read out of the fixture. */
  const expected = [
    ...new Set(
      reviewFrom(PROSIGNS)
        .review.actual.chars.map((c) => c.char)
        .filter((c) => c.startsWith("<")),
    ),
  ];

  it("decodes prosigns at all, or the rest of this file proves nothing", () => {
    expect(expected.length).toBeGreaterThan(0);
  });

  // Both builders put the character in the heading, and which one runs is a
  // setting away, so neither is allowed to lose it.
  it.each([
    ["per element", false],
    ["per character", true],
  ])("names every prosign it is hovering (%s)", (_label, charMarkers) => {
    const { headings, tags } = headingsAlongRow(charMarkers as boolean);

    expect(headings.size, "the sweep produced no tooltips at all").toBeGreaterThan(0);
    // Angle brackets have to survive as text: read back, `<BT>` is four
    // characters rather than a tag that swallowed the heading.
    for (const name of expected) expect([...headings]).toContain(name);

    // And nothing was parsed into elements of its own — the exact failure this
    // file exists for. A tooltip is a <b> and some <br>s, and nothing else.
    expect(tags).toEqual(new Set(["b", "br"]));
  });
});
