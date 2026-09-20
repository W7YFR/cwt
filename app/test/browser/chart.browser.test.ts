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
import { createChart, type Chart, type ChartCallbacks } from "@/render/canvas";
import { buildLayout, timeToX } from "@/render/layout";
import { trackBands } from "@/render/scene";
import { contextWindow } from "@/render/focus";
import { HEIGHT, GUTTER, PAD_R, ZOOM_MIN, rowsFor } from "@/render/geometry";
import type { BlockKind } from "@/types";
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

/** One pointer's worth of gesture, from whatever kind of pointer you like.
 *
 * The chart takes mouse, touch and pen through one path, so the only thing
 * that changes between them is `pointerType` — which is exactly what these
 * tests want to vary. */
function gesture(type: string, pointerType: string, opts: {
  x: number;
  y?: number;
  id?: number;
  primary?: boolean;
  target?: EventTarget;
}) {
  (opts.target ?? canvas).dispatchEvent(
    new PointerEvent(type, {
      clientX: opts.x,
      clientY: opts.y ?? 80,
      pointerId: opts.id ?? 1,
      // The constructor defaults this to false, and the chart ignores
      // non-primary pointers on purpose — so leaving it out is a test that
      // silently does nothing.
      isPrimary: opts.primary ?? true,
      pointerType,
      bubbles: true,
    }),
  );
}

/* A finger, which is the case that was missing entirely.
 *
 * A tap always worked, because the browser synthesises a click from one, so
 * every other thing this canvas does responded to touch and only the drag did
 * not — it was listening for `mousedown`, which a finger never sends. That is
 * a gap it is easy to look straight past, so it gets its own tests rather than
 * a `pointerType` argument bolted onto the mouse ones. */
describe("the chart under a finger", () => {
  function panning(): ReturnType<typeof vi.fn> {
    const onScroll = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onScroll });
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });
    return onScroll;
  }

  it("pans from a drag, the way a mouse does", () => {
    const onScroll = panning();
    gesture("pointerdown", "touch", { x: 400 });
    gesture("pointermove", "touch", { x: 300, target: window });
    gesture("pointerup", "touch", { x: 300, target: window });

    expect(onScroll).toHaveBeenCalled();
    expect(onScroll.mock.calls.at(-1)![0]).toBeGreaterThan(0);
  });

  it("does not let a second finger take the gesture over", () => {
    /* The second finger of a pinch lands wherever it lands, and a drag that
       re-anchored on it would jump the chart to somewhere nobody dragged. */
    const onScroll = panning();
    gesture("pointerdown", "touch", { x: 400, id: 1 });
    gesture("pointerdown", "touch", { x: 100, id: 2, primary: false });
    gesture("pointermove", "touch", { x: 90, id: 2, target: window });
    expect(onScroll).not.toHaveBeenCalled();

    // And the first finger still owns it.
    gesture("pointermove", "touch", { x: 300, id: 1, target: window });
    expect(onScroll).toHaveBeenCalled();
  });

  it("lets go when the browser takes the gesture away", () => {
    /* A page scroll or an edge swipe ends in `pointercancel` and no
       `pointerup` at all. A drag left standing after one would pan on the next
       unrelated move — which is a chart that slides when you are not touching
       it. */
    const onScroll = panning();
    gesture("pointerdown", "touch", { x: 400 });
    gesture("pointercancel", "touch", { x: 400, target: window });
    gesture("pointermove", "touch", { x: 200, target: window });
    expect(onScroll).not.toHaveBeenCalled();
  });

  it("draws no tooltip from a finger", () => {
    /* Hovering is a state you are in while pointing at something without
       committing to it, and a finger has no such state. Driven from touch
       moves, the tooltip would follow the finger through a pan and then sit
       where it was lifted, describing whatever happened to be under it. */
    const onHover = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onHover });
    chart.update({ review, settings, focus: null });

    gesture("pointermove", "touch", { x: 400 });
    expect(onHover).not.toHaveBeenCalled();

    // The same move from a mouse is a hover, and still reported.
    gesture("pointermove", "mouse", { x: 400 });
    expect(onHover).toHaveBeenCalled();
  });
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

    /* Pointer events, because that is what the chart listens for — one path
       for mouse, touch and pen. A `MouseEvent("mousedown")` is not a
       `pointerdown` and the chart would never see it.

       `isPrimary` matters: the constructor defaults it to false, and a
       non-primary pointer is the second finger of a pinch, which the chart
       deliberately ignores. */
    const at = (type: string, x: number, target: EventTarget) =>
      target.dispatchEvent(
        type === "click"
          ? new MouseEvent(type, { clientX: x, clientY: 80, bubbles: true })
          : new PointerEvent(type, {
              clientX: x,
              clientY: 80,
              pointerId: 1,
              isPrimary: true,
              pointerType: "mouse",
              bubbles: true,
            }),
      );

    at("pointerdown", 400, canvas);
    at("pointermove", 300, window);
    at("pointerup", 300, window);
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
        new PointerEvent(type, {
          clientX: x,
          clientY: 80,
          pointerId: 1,
          isPrimary: true,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    at("pointerdown", 400, canvas);
    at("pointermove", 300, window);
    at("pointerup", 300, window);

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

    /* Somewhere inside the first character's marks, on the "yours" row —
       located from the bands rather than from a pixel, so re-ordering the rows
       moves the click with them instead of quietly aiming it at the other
       track. */
    const rect = canvas.getBoundingClientRect();
    const band = trackBands(settings.view).you;
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: rect.left + GUTTER + 30,
        clientY: rect.top + (band[0] + band[1]) / 2,
        bubbles: true,
      }),
    );
    expect(onPlayChar).toHaveBeenCalled();
    const [side, from, to] = onPlayChar.mock.calls[0]!;
    expect(side).toBe("you");
    expect(to).toBeGreaterThan(from);
  });

  describe("clicking a gap", () => {
    /* A mark is its own context; a gap is not. A silence played on its own is
       silence, and what a spacing fault sounds like is only audible against
       what sits either side of it.
       
       What these hold is that the chart and the deviation table answer with
       the SAME window, from the same function — two paths to the same audio
       that disagree is a bug nobody would ever notice. */
    const PPU = 30;

    /** Where the lead gap of slot `i` sits, in screen coordinates. Read off a
     *  layout built the same way the chart builds its own, rather than guessed
     *  at in pixels. */
    function gapAt(i: number) {
      const layout = buildLayout(review, {
        view: settings.view,
        ppu: PPU,
        durationSec: review.take.durationSec,
      });
      const it = layout.items[i]!;
      return it.x! + it.youGapW / 2;
    }

    /** The first slot whose lead gap is graded as `kind`. */
    function slotWithGap(kind: BlockKind): number {
      return review.slots.findIndex(
        (s) => s.actual?.leadGap?.targetKind === kind,
      );
    }

    // The callback's own type, not the mock's. A spy is assignable to it, so
    // callers still pass a vi.fn() and keep their `.mock` on it.
    function clickAt(
      contentX: number,
      onPlayChar: NonNullable<ChartCallbacks["onPlayChar"]>,
    ) {
      chart.destroy();
      chart = createChart(host, canvas, { onPlayChar });
      chart.update({ review, settings: { ...settings, ppu: PPU }, focus: null });
      chart.scrollTo(0);
      const rect = canvas.getBoundingClientRect();
      const band = trackBands(settings.view).you;
      canvas.dispatchEvent(
        new MouseEvent("click", {
          clientX: rect.left + GUTTER + contentX,
          clientY: rect.top + (band[0] + band[1]) / 2,
          bubbles: true,
        }),
      );
    }

    it.each(["char-gap", "word-gap"] as const)(
      "plays a %s with what it separates",
      (kind) => {
        const i = slotWithGap(kind);
        expect(i, `no ${kind} in the fixture`).toBeGreaterThan(0);

        const onPlayChar = vi.fn();
        clickAt(gapAt(i), onPlayChar);

        expect(onPlayChar).toHaveBeenCalled();
        const [side, from, to] = onPlayChar.mock.calls[0]!;
        const want = contextWindow(review.slots, "you", i, kind)!;
        expect(side).toBe("you");
        expect(from).toBeCloseTo(want[0], 6);
        expect(to).toBeCloseTo(want[1], 6);

        // And it really does reach past the gap itself, or none of this
        // would have been worth doing.
        const gap = review.slots[i]!.actual!.leadGap!;
        expect(from).toBeLessThan(gap.t0);
        expect(to).toBeGreaterThan(gap.t1);
      },
    );

    it("gives a word gap more room than a letter gap", () => {
      /* A letter gap takes the character either side; a word gap takes the
         whole word, because half a word does not read as one. */
      const ci = slotWithGap("char-gap");
      const wi = slotWithGap("word-gap");
      const span = (i: number, kind: BlockKind) => {
        const w = contextWindow(review.slots, "you", i, kind)!;
        return w[1] - w[0];
      };
      expect(span(wi, "word-gap")).toBeGreaterThan(span(ci, "char-gap"));
    });

    it("still plays just the character when a mark is clicked", () => {
      /* The other half of the rule. A dit's length means something on its own
         and the elements around it are already in the same character; opening
         the window would bury a 23 ms fault in a second and a half of audio. */
      const i = review.slots.findIndex((s) => (s.actual?.blocks.length ?? 0) > 0);
      const layout = buildLayout(review, {
        view: settings.view,
        ppu: PPU,
        durationSec: review.take.durationSec,
      });
      const it = layout.items[i]!;
      const onPlayChar = vi.fn();
      clickAt(it.x! + it.gapW + 2, onPlayChar);

      const [, from, to] = onPlayChar.mock.calls[0]!;
      const ch = review.slots[i]!.actual!;
      expect(from).toBeCloseTo(Math.max(ch.t0 - 0.08, 0), 6);
      expect(to).toBeCloseTo(ch.t1 + 0.08, 6);
    });
  });

  it("makes room for a count-in and puts it back", () => {
    /* The chart is told about the count-in imperatively, like the playhead and
       for the same reason: it belongs to a recording in progress, not to the
       settings the review is being read at, and it must not go through a
       re-render of the page. */
    chart.update({ review, settings: { ...settings, ppu: 30 }, focus: null });
    chart.scrollTo(500);
    const before = paintedPixels();

    chart.setLead(2);
    // Back to the start, because the room was reserved for something to come
    // in from the left and it cannot do that from halfway along.
    expect(paintedPixels()).not.toBe(before);

    chart.setLead(0);
    // And it is undone, not merely covered over.
    chart.scrollTo(500);
    expect(paintedPixels()).toBe(before);
  });

  it("slides the view under a running playhead instead of throwing it forward", () => {
    /* It used to page-jump: leave the view alone until the playhead ran off
       the right, then move it most of a screen. Predictable on paper, and very
       hard to follow — the thing you are watching teleports and you have to
       find it again in a chart that has just changed underneath you. Worse
       while pacing a recording, where losing the cursor is losing your place
       in the message. */
    chart.update({ review, settings: { ...settings, ppu: 40 }, focus: null });
    chart.scrollTo(0);

    // The scroll position is private, so the picture stands in for it: a view
    // that has moved paints a different number of pixels.
    const at = (t: number) => {
      chart.setPlayhead({ t, side: "you" });
      return paintedPixels();
    };

    /* Sampled closely: under a page-jump the view is identical between hops
       and then changes all at once, so consecutive samples come back equal.
       Sliding, every sample differs from the last. */
    const seen: number[] = [];
    const end = review.take.durationSec;
    for (let i = 1; i <= 8; i++) seen.push(at((end * i) / 10));
    const changes = seen.filter((v, i) => i === 0 || v !== seen[i - 1]!).length;
    expect(changes, `only ${changes} of ${seen.length} samples moved`).toBe(seen.length);
  });

  describe("following a playhead", () => {
    /* Two modes, and the difference is what the view is for. Playing back, the
       ends of the recording are worth seeing properly. Pacing a recording, the
       card above holds your eye at the middle of the screen and the mark you
       are about to make has to be in the same place every time — so the
       content moves and the cursor does not. */
    const PPU = 40;
    const AT = [0, 0.25, 0.5, 0.75, 1];

    function set(mode: "clamped" | "centered") {
      chart.destroy();
      chart = createChart(host, canvas);
      chart.update({ review, settings: { ...settings, ppu: PPU }, focus: null });
      chart.setFollow(mode);
      const layout = buildLayout(review, {
        view: settings.view,
        ppu: PPU,
        durationSec: review.take.durationSec,
      });
      const trackW = host.clientWidth - GUTTER - PAD_R;
      return { layout, trackW, maxScroll: Math.max(0, layout.width - trackW) };
    }

    it("holds the playhead at the middle of the track, at both ends too", () => {
      const { layout, trackW, maxScroll } = set("centered");
      const end = review.take.durationSec;

      for (const f of AT) {
        const t = end * f;
        chart.setPlayhead({ t, side: "you" });
        expect(chart.scrollAt(), `at ${(f * 100).toFixed(0)}%`).toBeCloseTo(
          timeToX(layout, t, "you") - trackW / 2,
          1,
        );
      }

      /* Which means overscrolling both ends — the content sitting off to the
         right before the first mark, and carrying on past the left after the
         last. A clamp would park the view and let the cursor drift across it,
         which is the behavior this replaced. */
      chart.setPlayhead({ t: 0, side: "you" });
      expect(chart.scrollAt(), "start").toBeLessThan(0);
      chart.setPlayhead({ t: end, side: "you" });
      expect(chart.scrollAt(), "end").toBeGreaterThan(maxScroll);
    });

    it("keeps the recording in frame when clamped, and moves the line instead", () => {
      const { maxScroll } = set("clamped");
      const end = review.take.durationSec;
      for (const f of AT) {
        chart.setPlayhead({ t: end * f, side: "you" });
        expect(chart.scrollAt()).toBeGreaterThanOrEqual(0);
        expect(chart.scrollAt()).toBeLessThanOrEqual(maxScroll);
      }
    });

    it("puts the view back inside its frame on the way out", () => {
      // Leaving `centered` has to undo the overscroll; the clamp will not run
      // while the mode is still on.
      const { maxScroll } = set("centered");
      chart.setPlayhead({ t: 0, side: "you" });
      expect(chart.scrollAt()).toBeLessThan(0);

      chart.setFollow("clamped");
      expect(chart.scrollAt()).toBeGreaterThanOrEqual(0);
      expect(chart.scrollAt()).toBeLessThanOrEqual(maxScroll);
    });
  });

  it("keeps a run's own number when it is drawn as part of a tail", () => {
    /* The chart can be handed the last few attempts of a session rather than
       all of them. A run's number is the order it was recorded in, not where
       it lands on screen — so the window's first row is not RUN 1, and
       clicking its name has to pick up the attempt it names rather than the
       one in that position.

       The same class of bug sorting the rows already avoids, reached a
       different way: there the rows move, here the ones above them are gone. */
    const onSelectRun = vi.fn();
    chart.destroy();
    chart = createChart(host, canvas, { onSelectRun });
    const { review: other } = reviewFrom(caseNamed(SLOPPY), { expected: "CQ" });
    // The last two of a session of five.
    chart.update({
      review,
      stack: [review, other],
      selected: 0,
      firstRun: 3,
      settings,
      focus: null,
    });

    const rows = rowsFor(2, 0);
    const box = canvas.getBoundingClientRect();
    const clickName = (at: number) =>
      canvas.dispatchEvent(
        new MouseEvent("click", {
          clientX: box.left + 8,
          clientY: box.top + rows.runs[at]!.row + 4,
          bubbles: true,
        }),
      );

    // The second row, which is the fifth attempt.
    clickName(1);
    expect(onSelectRun).toHaveBeenCalledWith(4);

    // And the first row is already the one in hand, so it plays rather than
    // re-selecting — the number it would have sent is the point either way.
    onSelectRun.mockClear();
    clickName(0);
    expect(onSelectRun).not.toHaveBeenCalled();
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
    expect(onSeek.mock.calls[0]![0].you).toBeGreaterThanOrEqual(0);
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
