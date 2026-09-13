/* The canvas host: device pixels, scrolling, and the pointer gestures.
 *
 * Framework-free on purpose. It owns exactly three pieces of state — scroll
 * position, what the pointer is over, and where the playhead is — because those
 * change at sixty frames a second and have no business going through React.
 * Everything else arrives through `update()` and is treated as read-only.
 *
 * One gesture model for the whole surface: press, then either drag (pan, or
 * move the scrollbar thumb) or release without moving (a click).
 */

import type { Block, Review, ReviewSettings } from "@/types";
import {
  DRAG_SLOP,
  GUTTER,
  HEIGHT,
  PAD_R,
  RULER_H,
  Y_SCROLL,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RATE,
} from "./geometry";
import { contextWindow, hitTest, type Focus, type HitResult } from "./focus";
import { buildLayout, fitZoom, timeToX, xToTime, type Layout } from "./layout";
import { draw, scrollbarThumb, trackBands, type Scene, type Viewport } from "./scene";
import { readPalette, type Palette } from "./theme";

export interface ChartCallbacks {
  /** A character was clicked on one of the tracks. */
  onPlayChar?: (side: "you" | "tgt", from: number, to: number) => void;
  /** The ruler was clicked: seek and play from here. */
  onSeek?: (t: number) => void;
  /** Pointer moved over (or off) a block, for the tooltip. */
  onHover?: (hit: HitResult | null, clientX: number, clientY: number) => void;
  /** The zoom changed from a wheel gesture, so the slider can follow. */
  onZoom?: (ppu: number) => void;
  /** The view moved because of something the user did — a drag, a shift-wheel,
   *  the scrollbar, or the anchoring that follows a zoom.
   *
   * Deliberately NOT fired by `scrollTo`, which is how one chart is driven
   * from outside. Two charts kept in step would otherwise notify each other
   * forever. */
  onScroll?: (x: number) => void;
}

export interface ChartInput {
  review: Review;
  settings: ReviewSettings;
  focus: Focus | null;
}

export interface Chart {
  /** Hand over new data. Cheap: it relays out and redraws, nothing more. */
  update(input: ChartInput): void;
  /** Move the playhead without rebuilding anything. */
  setPlayhead(playhead: { t: number; side: "you" | "tgt" } | null): void;
  /** The zoom at which the whole session fills the width. */
  fit(): number;
  scrollTo(x: number): void;
  /** Re-read the palette (theme changed) and redraw. */
  refreshTheme(): void;
  /** Redraw at the current device pixel ratio and container width. */
  resize(): void;
  /** Render the WHOLE analysis to an offscreen canvas, for export. */
  exportImage(): { canvas: HTMLCanvasElement; note: string };
  destroy(): void;
}

/** Marks and gaps behave differently on a click — see `onClick`. */
function isGap(kind: Block["kind"]): boolean {
  return kind !== "dit" && kind !== "dah";
}

/** Cap on the *device* pixel width of an export: browsers limit canvas
 *  dimensions and area, and a retina export doubles both. */
const MAX_PNG_DEVICE_W = 16384;

export function createChart(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  callbacks: ChartCallbacks = {},
): Chart {
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("this browser gave us no 2D canvas context");
  const ctx: CanvasRenderingContext2D = ctx2d;

  let input: ChartInput | null = null;
  let layout: Layout | null = null;
  let palette: Palette = readPalette(document.body);
  let scrollX = 0;
  let hover: Block | null = null;
  let playhead: { t: number; side: "you" | "tgt" } | null = null;
  let driftMax = 1;
  let destroyed = false;

  function viewport(): Viewport {
    const viewW = Math.max(host.clientWidth, GUTTER + 40);
    const trackW = Math.max(viewW - GUTTER - PAD_R, 1);
    const contentW = layout ? layout.width : trackW;
    return { viewW, trackW, contentW, maxScroll: Math.max(0, contentW - trackW) };
  }

  function clampScroll(v: Viewport): void {
    scrollX = Math.min(Math.max(scrollX, 0), v.maxScroll);
  }

  function scene(v: Viewport): Scene | null {
    if (!input || !layout) return null;
    const s: Scene = {
      layout,
      slots: input.review.slots,
      analysis: input.review.analysis,
      palette,
      view: input.settings.view,
      tolerance: input.settings.tolerance,
      scrollX,
      viewport: v,
      durationSec: input.review.take.durationSec,
      idealDuration: input.review.ideal.duration,
      hover,
      focus: input.focus,
      playhead,
      driftMax,
    };
    return s;
  }

  function paint(): void {
    if (destroyed) return;
    const v = viewport();
    clampScroll(v);
    const s = scene(v);
    if (!s) return;
    draw(ctx as unknown as Parameters<typeof draw>[0], s);
    driftMax = s.driftMax ?? 1;
  }

  function relayout(): void {
    if (!input) return;
    layout = buildLayout(input.review, {
      view: input.settings.view,
      ppu: input.settings.ppu,
      durationSec: input.review.take.durationSec,
    });
  }

  function resize(): void {
    if (destroyed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(host.clientWidth, 1);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${HEIGHT}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  // ---- pointer ----------------------------------------------------------- //
  type Drag =
    | { kind: "pan"; x0: number; scroll0: number; moved: number }
    | {
        kind: "thumb";
        x0: number;
        scroll0: number;
        moved: number;
        thumbW: number;
        trackW: number;
      };

  let drag: Drag | null = null;
  let suppressClick = false;

  function localPos(ev: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  const contentXOf = (sx: number) => sx - GUTTER + scrollX;

  function doScrollTo(x: number, notify = true): void {
    const v = viewport();
    scrollX = x;
    clampScroll(v);
    if (notify) callbacks.onScroll?.(scrollX);
    paint();
  }

  function setZoomAt(next: number, atScreenX: number | null): void {
    if (!input || !layout) return;
    // A tenth of a pixel per unit is the finest step worth taking: it keeps the
    // readout honest and stops wheel arithmetic accumulating float noise.
    const v = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next)) * 10) / 10;
    if (v === input.settings.ppu) return;

    const vp = viewport();
    // What to hold still. A slider cannot point at anything, so it holds the
    // middle of the view; the wheel holds whatever is under the pointer. An
    // event that arrives without usable coordinates holds the middle too —
    // better than letting a NaN through into the scroll position.
    let at = vp.trackW / 2;
    if (atScreenX !== null && Number.isFinite(atScreenX)) {
      at = Math.max(0, Math.min(atScreenX - GUTTER, vp.trackW));
    }
    // Anchor on the *moment* at that point: read off the layout before, looked
    // up again after. Scaling scrollX by the zoom ratio would only approximate
    // it, because the per-character view pads every slot by a fixed amount and
    // that padding does not stretch with the zoom.
    const t = xToTime(layout, contentXOf(GUTTER + at), "you");
    input = { ...input, settings: { ...input.settings, ppu: v } };
    relayout();
    scrollX = timeToX(layout!, t, "you") - at;
    clampScroll(viewport());
    callbacks.onZoom?.(v);
    // Zooming moves the view as well as scaling it — it holds one moment still
    // and everything else slides past. Anything following this chart has to
    // hear about that or it drifts out of step on the first wheel gesture.
    callbacks.onScroll?.(scrollX);
    paint();
  }

  const onMouseDown = (ev: MouseEvent) => {
    const p = localPos(ev);
    const v = viewport();
    suppressClick = false;
    const th = scrollbarThumb(scrollX, v);
    if (th && p.y >= Y_SCROLL) {
      if (p.x >= th.x && p.x <= th.x + th.w) {
        drag = {
          kind: "thumb",
          x0: p.x,
          scroll0: scrollX,
          moved: 0,
          thumbW: th.w,
          trackW: th.trackW,
        };
      } else {
        // Clicking the bare track pages toward the click.
        doScrollTo(scrollX + (p.x < th.x ? -v.trackW : v.trackW) * 0.8);
      }
      ev.preventDefault();
      return;
    }
    if (p.x < GUTTER || p.y < RULER_H) return; // the gutter and ruler aren't pans
    drag = { kind: "pan", x0: p.x, scroll0: scrollX, moved: 0 };
  };

  const onWindowMouseMove = (ev: MouseEvent) => {
    if (!drag) return;
    const p = localPos(ev);
    const dx = p.x - drag.x0;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    if (drag.moved < DRAG_SLOP) return;
    const v = viewport();
    if (drag.kind === "thumb") {
      const span = drag.trackW - drag.thumbW;
      doScrollTo(drag.scroll0 + (span > 0 ? (dx / span) * v.maxScroll : 0));
    } else {
      canvas.classList.add("grabbing");
      doScrollTo(drag.scroll0 - dx);
    }
  };

  // Always clear `drag` here — a release outside the canvas fires no click, and
  // a stuck drag would suppress hovering indefinitely. Whether it counted as a
  // pan is handed to the click that may follow.
  const onWindowMouseUp = () => {
    if (!drag) return;
    canvas.classList.remove("grabbing");
    suppressClick = drag.moved >= DRAG_SLOP;
    drag = null;
  };

  function hitAt(p: { x: number; y: number }): HitResult | null {
    if (!layout || !input || p.x < GUTTER) return null;
    return hitTest(layout, contentXOf(p.x), p.y, trackBands(input.settings.view));
  }

  const onMouseMove = (ev: MouseEvent) => {
    if (drag && drag.moved >= DRAG_SLOP) {
      callbacks.onHover?.(null, ev.clientX, ev.clientY);
      return;
    }
    const p = localPos(ev);
    const h = hitAt(p);
    const b = h ? h.block : null;
    if (b !== hover) {
      hover = b;
      paint();
    }
    callbacks.onHover?.(h, ev.clientX, ev.clientY);
  };

  const onMouseLeave = (ev: MouseEvent) => {
    callbacks.onHover?.(null, ev.clientX, ev.clientY);
    if (hover) {
      hover = null;
      paint();
    }
  };

  const onClick = (ev: MouseEvent) => {
    // A press that turned into a pan is not a click.
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (!layout) return;
    const p = localPos(ev);
    if (p.x < GUTTER || p.y >= Y_SCROLL) return;

    // The ruler band is a seek strip.
    if (p.y < RULER_H) {
      callbacks.onSeek?.(Math.max(xToTime(layout, contentXOf(p.x), "you"), 0));
      return;
    }
    const h = hitAt(p);
    if (!h || !input) return;

    /* A mark is its own context; a gap is not.
     *
     * Clicking a dit or a dah plays that character, and the elements it is
     * made of are right there. Clicking a *gap* used to do the same thing,
     * which was no use at all: a silence played on its own is silence, and
     * what a spacing fault sounds like is only audible against what sits
     * either side of it. So a gap plays what the class is about — the same
     * window the deviation table plays for its rows, from the same function,
     * because the two answering differently is a bug nobody would notice.
     *
     * Scoped by what it is GRADED as, not by what the decoder read it as:
     * an overlong letter gap is still a letter gap, and playing it with a
     * whole word either side would bury the fault it is being blamed for. */
    if (isGap(h.block.kind)) {
      const w = contextWindow(input.review.slots, h.row, h.index, h.block.targetKind);
      if (w) {
        callbacks.onPlayChar?.(h.row, w[0], w[1]);
        return;
      }
    }
    // Click a character to hear just that character, on whichever track.
    const pad = 0.08;
    callbacks.onPlayChar?.(h.row, Math.max(h.char.t0 - pad, 0), h.char.t1 + pad);
  };

  /* The wheel zooms, anchored on the pointer so whatever you are looking at
     stays under it. The chart is one long horizontal strip with nothing to
     scroll vertically, so zoom is what a wheel over it is actually for.

     Panning is still a wheel gesture, just a horizontal one — a trackpad's
     sideways swipe, or shift+wheel, the usual way to say "pan" where the wheel
     means zoom. Dragging, the arrow keys and the scrollbar all still pan too.

     A macOS trackpad pinch arrives as ctrl+wheel, so it lands on the zoom path
     as well, which is right; preventDefault is what keeps it from zooming the
     whole page instead of the chart. */
  const onWheel = (ev: WheelEvent) => {
    if (!input) return;
    if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      const v = viewport();
      if (!v.maxScroll) return;
      const d = ev.deltaX || ev.deltaY; // shift+wheel reports on deltaY
      if (!d) return;
      ev.preventDefault();
      doScrollTo(scrollX + d);
      return;
    }
    if (!ev.deltaY) return;
    ev.preventDefault();
    setZoomAt(input.settings.ppu * Math.exp(-ev.deltaY * ZOOM_RATE), localPos(ev).x);
  };

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", onMouseLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);

  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  observer?.observe(host);

  return {
    update(next) {
      const viewChanged = input?.settings.view !== next.settings.view;
      const restsChanged = input?.settings.collapseRests !== next.settings.collapseRests;
      input = next;
      relayout();
      // A different axis or a different rest policy makes the old scroll
      // position meaningless — it would land somewhere unrelated.
      if (viewChanged || restsChanged) scrollX = 0;
      resize();
    },

    setPlayhead(next) {
      playhead = next;
      if (next && layout) {
        /* Keep the playhead on screen while audio runs. Page-jump rather than
           continuous centering: predictable, and it does not slide the whole
           view on every frame. */
        const v = viewport();
        if (v.maxScroll) {
          const cx = timeToX(layout, next.t, next.side);
          const lead = cx - scrollX;
          if (lead > v.trackW * 0.8 || lead < 0) {
            scrollX = cx - v.trackW * 0.2;
            clampScroll(v);
          }
        }
      }
      paint();
    },

    fit() {
      if (!input) return ZOOM_MIN;
      return fitZoom(
        input.review,
        {
          view: input.settings.view,
          durationSec: input.review.take.durationSec,
        },
        viewport().trackW,
        ZOOM_MIN,
        ZOOM_MAX,
      );
    },

    scrollTo: (x: number) => doScrollTo(x, false),

    refreshTheme() {
      palette = readPalette(document.body);
      paint();
    },

    resize,

    /* Export the WHOLE analysis, not the visible slice: render to an offscreen
       canvas as wide as the content. Very long sessions would exceed the
       browser's canvas limit, so the zoom is reduced just enough to fit and the
       shortfall is reported rather than silently cropped. */
    exportImage() {
      if (!input || !layout) throw new Error("nothing to export yet");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const budget = MAX_PNG_DEVICE_W / dpr;

      let ppu = input.settings.ppu;
      let exportLayout = buildLayout(input.review, {
        view: input.settings.view,
        ppu,
        durationSec: input.review.take.durationSec,
      });
      let note = "";
      if (GUTTER + exportLayout.width + PAD_R > budget) {
        const fitScale = (budget - GUTTER - PAD_R) / exportLayout.width;
        ppu = Math.max(ppu * fitScale, 1);
        exportLayout = buildLayout(input.review, {
          view: input.settings.view,
          ppu,
          durationSec: input.review.take.durationSec,
        });
        note = `zoomed to ${ppu.toFixed(1)} px/unit so the whole session fits`;
      }

      const w = Math.ceil(GUTTER + exportLayout.width + PAD_R);
      const off = document.createElement("canvas");
      off.width = Math.round(w * dpr);
      off.height = Math.round(HEIGHT * dpr);
      const offCtx = off.getContext("2d");
      if (!offCtx) throw new Error("could not make an offscreen canvas");
      offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Opaque ground: a PNG has no page behind it to supply the background.
      offCtx.fillStyle = palette.panel;
      offCtx.fillRect(0, 0, w, HEIGHT);

      draw(offCtx as unknown as Parameters<typeof draw>[0], {
        layout: exportLayout,
        slots: input.review.slots,
        analysis: input.review.analysis,
        palette,
        view: input.settings.view,
        tolerance: input.settings.tolerance,
        scrollX: 0,
        viewport: {
          viewW: w,
          trackW: w - GUTTER - PAD_R,
          contentW: exportLayout.width,
          maxScroll: 0,
        },
        durationSec: input.review.take.durationSec,
        idealDuration: input.review.ideal.duration,
        // A hover highlight or a playhead has no business in an export.
        hover: null,
        focus: null,
        playhead: null,
      });
      return { canvas: off, note };
    },

    destroy() {
      destroyed = true;
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
      observer?.disconnect();
    },
  };
}
