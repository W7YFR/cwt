/* The calibration preview, drawn.
 *
 * The wizard's DOM test stubs this component, and has to: it is a canvas, and
 * jsdom has no 2D context. So the seam that makes the rest of that screen
 * testable leaves exactly one thing uncovered — whether the preview actually
 * draws — and this is where that is answered.
 *
 * What it holds is narrow on purpose. That a calibration corrects what it
 * claims to is settled in the pure tier against real recordings; that the
 * result screen hands the preview the right recording is settled in the DOM
 * tier. This asks the one question neither can: given a run, do two charts
 * appear on screen with pixels in them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalPreview } from "@/ui/CalPreview";
import { splitSections } from "@/dsp";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import type { CalibrationRun } from "@/io/calibration";
import "@/ui/base.css";

const RATE = 8000;
const TEXT = "CQ DE W7YFR";

function clip() {
  const { samples } = synthesize(TEXT, targetTiming(15, 15), { rate: RATE });
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return { samples, rate: RATE, peak };
}

/* A run over that audio. The sections are found by the real splitter; only the
   measurement around them is assembled here, because what is under test is the
   drawing and not the arithmetic. */
function runOver(samples: Float32Array, offsetSec: number): CalibrationRun {
  return {
    sections: splitSections(samples, RATE),
    calibration: { wpm: 15, releaseOffsetSec: offsetSec, spreadSec: 0.0004, elements: 90 },
    quality: {
      decaySec: 0.03,
      ditSec: 0.08,
      ratio: 0.37,
      releases: 6,
      verdict: "good",
      maxWpm: 30,
    },
    usable: true,
    nothingToCorrect: false,
    drillsAgreed: true,
    reason: null,
    problem: null,
    advice: "",
    readback: { text: TEXT, charWpm: 15 },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  // The charts size themselves to their host, and a zero-width host draws
  // nothing — which would pass every "did it render" check and no real one.
  container.style.width = "900px";
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  container.remove();
});

function mount(expected: string, offsetSec = 0.008) {
  const c = clip();
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(CalPreview, {
        clip: c,
        run: runOver(c.samples, offsetSec),
        expected,
        wpm: 15,
      }),
    );
  });
}

/** Pixels actually painted, which is the one question only a real canvas
 *  answers. An empty chart and a drawn one are the same DOM. */
function painted(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit++;
  return lit;
}

describe("the calibration preview", () => {
  it("draws the recording both ways, so the correction can be seen", () => {
    mount(TEXT);
    const charts = [...container.querySelectorAll("[data-testid='calchart']")];
    expect(charts.map((c) => (c as HTMLElement).dataset.variant)).toEqual([
      "raw",
      "calibrated",
    ]);
    for (const chart of charts) {
      const canvas = chart.querySelector("canvas")!;
      expect(painted(canvas)).toBeGreaterThan(100);
    }
  });

  it("draws without an intended message, which the drill never asked for", () => {
    /* The closing drill is "send anything you like", so most of the time
       nothing says what was meant. The chart still has to show the element
       lengths — graded against its own decode instead of against a target. */
    mount("");
    expect(container.querySelectorAll("[data-testid='calchart']")).toHaveLength(2);
    const canvas = container.querySelector("canvas")!;
    expect(painted(canvas)).toBeGreaterThan(100);
  });

  it("grades both against the stated keyer speed, not against themselves", () => {
    /* The bug this replaced, and it made the preview worse than useless.
       `defaultSettings` takes its target from the take, and for a take with no
       stated speed that target is whatever the estimator measured off it — so
       the raw recording was being compared against its own idea of the right
       speed and came out flawless no matter what was wrong with it. Every
       correction could then only move away from flawless, and the chart said
       calibration makes things worse whatever the calibration did.

       Stated here as 25 against audio keyed at 15, so the two cannot be
       confused for one another. */
    mount(TEXT, 0.008);
    const charts = [...container.querySelectorAll("[data-testid='calchart']")];
    expect(charts).toHaveLength(2);
    for (const c of charts) {
      const el = c as HTMLElement;
      expect(Number(el.dataset.target)).toBe(15);
      // And the reading is still the recording's own, not the target handed
      // to it — otherwise the caption would just echo the question.
      expect(Math.abs(Number(el.dataset.reads) - 15)).toBeLessThan(3);
    }
  });

  it("puts the correction where the correction went", () => {
    /* Marks shorter, gaps longer, by the offset — which is what applying one
       does. Graded against a fixed external speed, so the two charts are
       reading the same yardstick and the difference between them is the
       correction alone. */
    mount(TEXT, 0.008);
    const [raw, cal] = [...container.querySelectorAll("[data-testid='calchart']")].map(
      (c) => Number((c as HTMLElement).dataset.reads),
    );
    // Taking time off every mark makes the estimator read a shorter dit, and
    // a shorter dit is a higher speed. A correction that moved nothing would
    // leave these identical.
    expect(cal).toBeGreaterThan(raw!);
  });

  it("zooms and scrolls the two charts as one", () => {
    /* Reading one against the other is the entire point of showing both, and
       two charts of the same ten seconds at different zooms and different
       scroll positions are two charts of nothing in particular.

       Matched in pixels rather than in seconds, deliberately: both are laid
       out per character from the same message, so the same scroll puts the
       same character under the same point of the screen. Matching by time
       would slide them apart by exactly the correction being examined. */
    mount(TEXT, 0.008);
    const preview = container.querySelector<HTMLElement>("[data-testid='calpreview']")!;
    const canvases = [...container.querySelectorAll("canvas")];
    expect(canvases).toHaveLength(2);

    const before = preview.dataset.ppu;
    /* Wrapped, because the zoom comes back out of the chart as a React state
       update and the attribute below is rendered from it. The scroll does not
       need this — it is written straight onto the element, for the same reason
       the chart keeps it out of React in the first place. */
    act(() => {
      canvases[0]!.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -240, clientX: 500, clientY: 60, bubbles: true }),
      );
    });
    // One zoom for the pair, not one each.
    expect(preview.dataset.ppu).not.toBe(before);

    /* Coordinates are taken from each canvas's own box. The second chart sits
       a few hundred pixels down the page, and a drag aimed at the first one's
       y lands outside it — which reads as "the link is broken" when what is
       broken is the test. */
    const drag = (canvas: HTMLCanvasElement, fromX: number, toX: number) => {
      const r = canvas.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const send = (type: string, x: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, { clientX: r.left + x, clientY: y, bubbles: true }),
        );
      send("mousedown", fromX, canvas);
      send("mousemove", toX, window);
      send("mouseup", toX, window);
    };

    drag(canvases[0]!, 700, 400);
    expect(Number(preview.dataset.scroll)).toBeGreaterThan(0);

    /* And the second chart drives the first just as well — a link that only
       runs one way is the easier one to write and the one that reads as
       broken the moment somebody grabs the lower chart. */
    const moved = Number(preview.dataset.scroll);
    drag(canvases[1]!, 400, 700);
    expect(Number(preview.dataset.scroll)).toBeLessThan(moved);
  });

  it("shows one chart when there is nothing to correct with", () => {
    // A refused calibration has no profile to apply, and a second chart
    // identical to the first would imply it did.
    const c = clip();
    const run = { ...runOver(c.samples, 0), usable: false, calibration: null };
    root = createRoot(container);
    act(() => {
      root!.render(createElement(CalPreview, { clip: c, run, expected: TEXT, wpm: 15 }));
    });
    expect(container.querySelectorAll("[data-testid='calchart']")).toHaveLength(1);
  });
});
