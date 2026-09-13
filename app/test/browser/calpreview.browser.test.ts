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
    root!.render(createElement(CalPreview, { clip: c, run: runOver(c.samples, offsetSec), expected }));
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

  it("shows one chart when there is nothing to correct with", () => {
    // A refused calibration has no profile to apply, and a second chart
    // identical to the first would imply it did.
    const c = clip();
    const run = { ...runOver(c.samples, 0), usable: false, calibration: null };
    root = createRoot(container);
    act(() => {
      root!.render(createElement(CalPreview, { clip: c, run, expected: TEXT }));
    });
    expect(container.querySelectorAll("[data-testid='calchart']")).toHaveLength(1);
  });
});
