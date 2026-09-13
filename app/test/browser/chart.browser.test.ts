/* The canvas, in a real browser.
 *
 * Everything here needs something jsdom does not have: a 2D context that
 * actually rasterizes, a devicePixelRatio, real element boxes, and real event
 * dispatch through the listeners the chart attached itself.
 *
 * What is NOT here is anything the recording context can already answer —
 * layout, hit testing, what gets drawn where. Those live in the pure tier, run
 * in milliseconds, and say far more when they fail.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createChart, type Chart } from "@/render/canvas";
import { HEIGHT, GUTTER, ZOOM_MIN } from "@/render/geometry";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

const { review, settings } = reviewFrom(caseNamed(SLOPPY));

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;
let chart: Chart;

function mount(width = 900) {
  host = document.createElement("div");
  host.style.width = `${width}px`;
  canvas = document.createElement("canvas");
  host.appendChild(canvas);
  document.body.appendChild(host);
  return createChart(host, canvas);
}

/** Is anything actually painted? Reads real pixels, which is the one question
 *  only a real canvas can answer. */
function paintedPixels(): number {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit++;
  return lit;
}

beforeEach(() => {
  chart = mount();
});

afterEach(() => {
  chart.destroy();
  host.remove();
});

describe("the chart in a browser", () => {
  it("sizes itself in device pixels and paints", () => {
    chart.update({ review, settings, focus: null });
    const dpr = window.devicePixelRatio || 1;
    expect(canvas.width).toBe(Math.round(host.clientWidth * dpr));
    expect(canvas.height).toBe(Math.round(HEIGHT * dpr));
    // The CSS size stays in layout pixels, or everything would be drawn at
    // twice the size on a retina display.
    expect(canvas.style.height).toBe(`${HEIGHT}px`);
    expect(paintedPixels()).toBeGreaterThan(1000);
  });

  it("repaints when the settings change", () => {
    chart.update({ review, settings, focus: null });
    const before = paintedPixels();
    chart.update({ review, settings: { ...settings, ppu: settings.ppu * 3 }, focus: null });
    expect(paintedPixels()).not.toBe(before);
  });

  it("zooms about the pointer on a wheel, and tells the caller", () => {
    const onZoom = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onZoom });
    chart.update({ review, settings, focus: null });

    canvas.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -240, clientX: 400, clientY: 60, bubbles: true }),
    );
    expect(onZoom).toHaveBeenCalled();
    const zoomedIn = onZoom.mock.calls.at(-1)![0] as number;
    expect(zoomedIn).toBeGreaterThan(settings.ppu);

    // And back out again, symmetrically.
    chart.update({ review, settings: { ...settings, ppu: zoomedIn }, focus: null });
    canvas.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 240, clientX: 400, clientY: 60, bubbles: true }),
    );
    const zoomedOut = onZoom.mock.calls.at(-1)![0] as number;
    expect(zoomedOut).toBeLessThan(zoomedIn);
    expect(zoomedOut).toBeCloseTo(settings.ppu, 0);
  });

  it("pans on a shift-wheel instead of zooming", () => {
    const onZoom = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onZoom });
    // Zoomed well in, so there is somewhere to scroll to.
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });
    const before = paintedPixels();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 300,
        shiftKey: true,
        clientX: 400,
        clientY: 60,
        bubbles: true,
      }),
    );
    expect(onZoom).not.toHaveBeenCalled();
    expect(paintedPixels()).not.toBe(before);
  });

  it("treats a drag as a pan and not as a click", () => {
    const onPlayChar = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onPlayChar });
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });

    const at = (type: string, x: number, target: EventTarget) =>
      target.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: 80, bubbles: true }),
      );

    at("mousedown", 400, canvas);
    at("mousemove", 300, window);
    at("mouseup", 300, window);
    at("click", 300, canvas);
    // A press that turned into a pan is not a click; without this every drag
    // across the chart would fire off a burst of audio.
    expect(onPlayChar).not.toHaveBeenCalled();
  });

  it("reports a pan, so a second chart can follow it", () => {
    /* What makes two charts of the same recording comparable: they move
       together. The contract is narrow and one half of it is the important
       half — see the test below. */
    const onScroll = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onScroll });
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });

    const at = (type: string, x: number, target: EventTarget) =>
      target.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: 80, bubbles: true }),
      );
    at("mousedown", 400, canvas);
    at("mousemove", 300, window);
    at("mouseup", 300, window);

    expect(onScroll).toHaveBeenCalled();
    expect(onScroll.mock.calls.at(-1)![0]).toBeGreaterThan(0);
  });

  it("stays quiet when it is scrolled from outside", () => {
    /* The half that matters. `scrollTo` is how one chart is driven by another,
       so reporting it would have each telling the other about a move the other
       just asked for — forever, on the first drag. */
    const onScroll = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onScroll });
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });

    chart.scrollTo(120);
    expect(onScroll).not.toHaveBeenCalled();
  });

  it("reports the view moving when a wheel zoom slides it", () => {
    /* Zooming is not only a scale change: it holds one moment under the
       pointer still and everything else slides past. A follower told only
       about the new zoom would land somewhere else entirely. */
    const onScroll = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onScroll });
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });

    canvas.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -240, clientX: 600, clientY: 60, bubbles: true }),
    );
    expect(onScroll).toHaveBeenCalled();
  });

  it("plays a character when one is clicked without dragging", () => {
    const onPlayChar = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onPlayChar });
    chart.update({ review, settings: { ...settings, ppu: 30 }, focus: null });

    // Somewhere inside the first character's marks, on the "yours" row.
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + GUTTER + 30,
        clientY: rect.top + 52,
        bubbles: true,
      }),
    );
    expect(onPlayChar).toHaveBeenCalled();
    const [side, from, to] = onPlayChar.mock.calls[0]!;
    expect(side).toBe("you");
    expect(to).toBeGreaterThan(from);
  });

  it("seeks when the ruler is clicked", () => {
    const onSeek = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onSeek });
    chart.update({ review, settings, focus: null });
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + GUTTER + 200,
        clientY: rect.top + 6,
        bubbles: true,
      }),
    );
    expect(onSeek).toHaveBeenCalled();
    expect(onSeek.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
  });

  it("fits the session to the real width of its container", () => {
    chart.update({ review, settings: { ...settings, ppu: ZOOM_MIN }, focus: null });
    const ppu = chart.fit();
    expect(ppu).toBeGreaterThanOrEqual(ZOOM_MIN);
    chart.update({ review, settings: { ...settings, ppu }, focus: null });
    // At the fitted zoom there is nothing left to scroll: that is what fitting
    // means, and it is only checkable against a container with a real width.
    expect(paintedPixels()).toBeGreaterThan(1000);
  });

  it("exports the whole analysis, not the visible slice", () => {
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });
    const { canvas: png } = chart.exportImage();
    expect(png.width).toBeGreaterThan(canvas.width);
    // Opaque ground: a PNG has no page behind it to supply a background.
    const ctx = png.getContext("2d")!;
    const corner = ctx.getImageData(1, 1, 1, 1).data;
    expect(corner[3]).toBe(255);
  });

  it("stops listening once destroyed", () => {
    const onZoom = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onZoom });
    chart.update({ review, settings, focus: null });
    chart.destroy();
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
    expect(onZoom).not.toHaveBeenCalled();
    // Re-created in afterEach's place so the teardown has something to destroy.
    chart = createChart(host, canvas);
  });
});
