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
  ROW_H,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RATE,
  rowsFor,
} from "./geometry";
import { contextWindow, hitTest, type Focus, type HitResult } from "./focus";
import {
  buildLayout,
  fitZoom,
  measureColumns,
  timeToX,
  xToTime,
  type ColumnMetrics,
  type Layout,
} from "./layout";
import {
  draw,
  scrollbarThumb,
  trackBands,
  type GutterName,
  type Lane,
  type Scene,
  type Viewport,
} from "./scene";
import { readPalette, type Palette } from "./theme";

export interface ChartCallbacks {
  /** A character was clicked on one of the tracks. */
  onPlayChar?: (side: "you" | "tgt", from: number, to: number) => void;
  /** A row other than the one being read was clicked.
   *
   * Picking it up rather than playing it: the report below the chart, the
   * audio and the caption band all follow the selection, so the first click on
   * another attempt is what moves them there. A second click then plays it,
   * out of the right recording. */
  onSelectRun?: (run: number) => void;
  /** The target's name in the gutter was clicked.
   *
   * Not a run and not a selection of one — the report below the chart stays
   * about the attempt it was about. What it picks up is the track: the ruler
   * seeks into the target from here, and the name lights to say so. */
  onSelectTarget?: () => void;
  /** A name in the gutter was clicked while its track was already the one in
   *  hand. Play it, or stop it if it is already running. */
  onPlayTrack?: (side: "you" | "tgt") => void;
  /** The ruler was clicked: seek and play from here.
   *
   * Both tracks' times for that point, because one ruler runs over two of
   * them and only the caller knows which one is being listened to. In
   * per-character view the two tracks are stretched to a shared column axis
   * independently, so a point on the ruler is a different second on each. */
  onSeek?: (at: { you: number; tgt: number }) => void;
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
  /** Session indices, in the order their rows should be drawn. Omitted to
   *  draw them in the order they were recorded. */
  order?: readonly number[];
  /** The attempt being read in detail: the captioned row, and the one the
   *  report below the chart is about. */
  review: Review;
  /** Every attempt in the session, oldest first. Omitted by a chart that is
   *  showing one thing — the calibration preview is one — in which case the
   *  stack is just `review`. */
  stack?: readonly Review[];
  /** Which of `stack` is `review`. */
  selected?: number;
  /** The session number of `stack[0]`.
   *
   * The chart can be handed a tail of a session rather than all of it — "the
   * last five" — and a run's number is the order it was recorded in, not where
   * it lands on screen. Without this the fourth attempt would be drawn as RUN
   * 1 and clicking its name would pick up the first, which is the same class
   * of bug sorting the rows already avoids.
   *
   * One number covers it because the window is always a tail: nothing is ever
   * left out of the middle. */
  firstRun?: number;
  /** The track playback is about, for the gutter. Defaults to yours. */
  heard?: "you" | "tgt";
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
  /** Reserve room at both ends of the axis, in seconds: a count-in to come in
   *  on and a run-out to carry on into. Zero puts it back. */
  setLead(seconds: number): void;
  /** How the view follows a running playhead.
   *
   * `clamped` keeps the content within the frame and lets the playhead travel
   * across it — right for playback, where the ends of the recording are worth
   * seeing properly. `centered` pins the playhead to the middle of the track
   * and slides the content under it, overscrolling past both ends so that the
   * moment you are meant to act on is always in the same place. */
  setFollow(mode: "clamped" | "centered"): void;
  scrollTo(x: number): void;
  /** Where the view currently sits, in content pixels.
   *
   * Read-only and purely diagnostic: the scroll is owned here because it moves
   * with the pointer and with a running playhead, and this is the one way to
   * see what it did without inferring it from the picture. */
  scrollAt(): number;
  /** Re-read the palette (theme changed) and redraw. */
  refreshTheme(): void;
  /** Redraw at the current device pixel ratio and container width. */
  resize(): void;
  /** Render the WHOLE analysis to an offscreen canvas, for export. */
  exportImage(): { canvas: HTMLCanvasElement; note: string };
  destroy(): void;
}

/** Where a running playhead is held across the track, as a fraction of its
 *  width. Left of center: what is coming matters more than what has gone. */
const PLAYHEAD_HOLD = 0.4;

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
  /* The shared column axis, measured once for every run on screen. Only the
     per-character view has columns; the time views are keyed to the clock. */
  let columns: ColumnMetrics | undefined;
  /* Every attempt on screen, and where its row sits. Held here rather than
     rebuilt inside `scene()` because hit testing has to agree with drawing
     about which row is where, and two places computing that is two places for
     them to disagree. */
  let lanes: Lane[] = [];
  let rows = rowsFor(1, 0);
  let selected = 0;
  /** The name in the gutter under the pointer, for its highlight. */
  let picking: GutterName | null = null;
  /** The row the pointer is anywhere over, for its tint. */
  let hoverRow: GutterName | null = null;

  /** The attempts to draw, in the order their rows go, and which row is being
   *  read.
   *
   * `order` is session indices — the order the attempts were recorded in is
   * the order they arrive in, and sorting rearranges where they are drawn
   * without renaming them. Everything the chart hands back out is a session
   * index again, so nothing outside here has to know the rows moved. */
  function stackOf(inp: ChartInput): {
    reviews: readonly Review[];
    order: readonly number[];
    selected: number;
  } {
    const reviews = inp.stack && inp.stack.length ? inp.stack : [inp.review];
    const fallback = reviews.map((_, i) => i);
    const order =
      inp.order && inp.order.length === reviews.length ? inp.order : fallback;
    const at = inp.selected ?? reviews.indexOf(inp.review);
    const pick = order.indexOf(at);
    return { reviews, order, selected: pick >= 0 ? pick : order.length - 1 };
  }
  let palette: Palette = readPalette(document.body);
  let scrollX = 0;
  let hover: Block | null = null;
  let playhead: { t: number; side: "you" | "tgt" } | null = null;
  let driftMax = 1;
  let destroyed = false;
  let leadSec = 0;
  let follow: "clamped" | "centered" = "clamped";

  function viewport(): Viewport {
    const viewW = Math.max(host.clientWidth, GUTTER + 40);
    const trackW = Math.max(viewW - GUTTER - PAD_R, 1);
    /* The widest attempt on screen, not the one being read.
     *
     * On the time axes a lane is as wide as its own recording, so taking the
     * selected lane's width made how far the chart scrolls a property of which
     * row was picked: selecting a shorter attempt narrowed the content under a
     * scroll position that was still valid a moment ago, and everything slid
     * sideways to a clamp. The rows are drawn on one axis and the extent of
     * that axis has to hold all of them. */
    const contentW = lanes.length
      ? Math.max(...lanes.map((l) => l.layout.width))
      : layout
        ? layout.width
        : trackW;
    return { viewW, trackW, contentW, maxScroll: Math.max(0, contentW - trackW) };
  }

  function clampScroll(v: Viewport): void {
    // Overscrolling both ends is the whole of `centered`: at the start the
    // content has to sit off to the right of the middle, and at the end it has
    // to keep going past it.
    if (follow === "centered") return;
    scrollX = Math.min(Math.max(scrollX, 0), v.maxScroll);
  }

  function scene(v: Viewport): Scene | null {
    if (!input || !layout) return null;
    const s: Scene = {
      runs: lanes,
      selected,
      picking,
      hoverRow,
      ...(input.heard ? { heard: input.heard } : {}),
      ...(columns ? { columns } : {}),
      layout,
      slots: lanes[selected]!.slots,
      analysis: lanes[selected]!.analysis,
      rows,
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
      leadSec,
      charMarkers: input.settings.charMarkers,
      runScores: input.settings.runScores,
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
    const stack = stackOf(input);
    selected = stack.selected;

    /* One axis for every attempt, measured before any of them is laid out —
       which is what makes a column mean the same thing on every row. */
    columns =
      input.settings.view === "per-char"
        ? measureColumns(
            stack.reviews.map((r) => r.slots),
            input.settings.ppu,
            input.settings.charMarkers,
          )
        : undefined;

    const opts = {
      view: input.settings.view,
      ppu: input.settings.ppu,
      leadSec,
      // The same runway either side: it is the room a centered playhead needs
      // to keep moving at both ends, and one number is one thing to get wrong.
      tailSec: leadSec,
      /* Goes to the layout as well as to the columns. They have to be measured
         the same way or the chart is drawn on one axis and read on another:
         the columns collapse to the tick, the time map tiles the elements
         across a width that is no longer there, and the playhead sweeps a
         character's phantom width and then snaps back to the next column. */
      charMarkers: input.settings.charMarkers,
    };

    lanes = stack.order.map((at) => {
      const review = stack.reviews[at]!;
      return {
        layout: buildLayout(review, {
          ...opts,
          durationSec: review.take.durationSec,
          // Columns are measured in session order, so a run is asked for its
          // own row of the plan rather than for wherever it is drawn.
          ...(columns ? { columns, run: at } : {}),
        }),
        slots: review.slots,
        analysis: review.analysis,
        accuracy: review.comparison?.accuracy ?? null,
        blank: review.take.segments.length === 0,
        ordinal: (input?.firstRun ?? 0) + at,
      } satisfies Lane;
    });
    layout = lanes[selected]!.layout;
    /* Overlay draws every attempt in one band, so its height is not a function
       of how many there are. Laid out per lane it reserved a row, a grade
       strip and a caption band for each — none of which it draws — and a
       session of four opened a screen of empty page between the marks and the
       drift plot. One lane, and uncaptioned: superimposing them is the view,
       and there is no row for a caption to belong to. */
    rows =
      input.settings.view === "overlay"
        ? rowsFor(1, -1)
        : rowsFor(lanes.length, selected, input.settings.captionAll);
  }

  /** How wide the chart would be at this zoom — the whole of it.
   *
   * The same computation `rebuild` does, at a zoom that is not in force yet.
   * Every lane, because the extent of a shared axis has to hold all of them,
   * and through `measureColumns` because in the per-character view a column is
   * as wide as the widest run put it — a width no single run's own layout
   * knows about. */
  function widthAt(ppu: number): number {
    if (!input) return 0;
    const stack = stackOf(input);
    const cols =
      input.settings.view === "per-char"
        ? measureColumns(
            stack.reviews.map((r) => r.slots),
            ppu,
            input.settings.charMarkers,
          )
        : undefined;
    let width = 0;
    for (const at of stack.order) {
      const review = stack.reviews[at]!;
      const l = buildLayout(review, {
        view: input.settings.view,
        ppu,
        leadSec,
        tailSec: leadSec,
        charMarkers: input.settings.charMarkers,
        durationSec: review.take.durationSec,
        ...(cols ? { columns: cols, run: at } : {}),
      });
      width = Math.max(width, l.width);
    }
    return width;
  }

  function resize(): void {
    if (destroyed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(host.clientWidth, 1);
    canvas.style.width = `${w}px`;
    // Taller with every attempt stacked on it, so the element is sized from
    // the rows rather than from a constant. With one attempt that constant is
    // exactly what `rows.height` comes to.
    canvas.style.height = `${rows.height}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(rows.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  // ---- pointer ----------------------------------------------------------- //
  /* Pointer events rather than mouse events, which is the whole of what a
     touch screen needed.
     A tap arrives as a click either way — the browser synthesises one — so
     playing a character by touching it always worked, and that made the gap
     easy to miss: everything on this canvas responded to a finger except the
     one gesture that is not a tap. Dragging was listening for `mousedown`,
     which a finger never sends, so the chart could be read and played on a
     phone but not moved.

     One code path for mouse, touch and pen, because they are one gesture:
     press, move, release. `pointerType` is consulted in exactly one place
     below, for hover, which is the one thing a finger genuinely cannot do. */
  type DragBase = { x0: number; scroll0: number; moved: number; pointerId: number };
  type Drag =
    | ({ kind: "pan" } & DragBase)
    | ({ kind: "thumb"; thumbW: number; trackW: number } & DragBase);

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

  const onPointerDown = (ev: PointerEvent) => {
    /* One gesture at a time. A second finger landing mid-pan would otherwise
       take the drag over from where it happened to touch down, and the chart
       would jump. Non-primary pointers are the rest of a multi-touch gesture
       — a pinch, most often — and none of them are this. */
    if (drag || !ev.isPrimary) return;
    // A right-click is a menu, not a grab. Touch and pen report button 0.
    if (ev.button > 0) return;

    const p = localPos(ev);
    const v = viewport();
    suppressClick = false;
    const th = scrollbarThumb(scrollX, v);
    if (th && p.y >= rows.scroll) {
      if (p.x >= th.x && p.x <= th.x + th.w) {
        drag = {
          kind: "thumb",
          x0: p.x,
          scroll0: scrollX,
          moved: 0,
          pointerId: ev.pointerId,
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
    drag = { kind: "pan", x0: p.x, scroll0: scrollX, moved: 0, pointerId: ev.pointerId };
  };

  const onWindowPointerMove = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
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

  /* Always clear `drag` here — a release outside the canvas fires no click, and
     a stuck drag would suppress hovering indefinitely. Whether it counted as a
     pan is handed to the click that may follow.

     Cancellation comes through here too. A touch gesture the browser decides
     belongs to it — a page scroll, a back-swipe from the edge — ends in
     `pointercancel` and no `pointerup` at all, and a drag left standing after
     one would pan on the next unrelated move. */
  const onWindowPointerUp = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    canvas.classList.remove("grabbing");
    suppressClick = drag.moved >= DRAG_SLOP;
    drag = null;
  };

  /** Never matches, since y is never negative. Used to ask one row's question
   *  without the other row answering it. */
  const NO_BAND: [number, number] = [-1, -1];

  /** Which track the gutter is offering at this point, or null.
   *
   * The gutter is the handle for picking a track up. Clicking the row itself
   * works too, but a row is mostly the marks on it, and going through a mark
   * to reach the row it belongs to is an indirection you can feel — you aim at
   * a dit to say "this run". The gutter says only that, which is why it is the
   * place to click. The target has a row there like the rest, so it is one of
   * them.
   *
   * The whole of the row's cell answers, not the few pixels the name is
   * written in. The name is where a row's cell is legible, not where it is:
   * the row lights under the pointer across its whole height, and then only a
   * line of text inside it would take the click. Exactly the band the tint
   * covers, so what lit is what answers. */
  function gutterNameAt(p: { x: number; y: number }): GutterName | null {
    if (p.x >= GUTTER) return null;
    /* Only where there is something for a click to do: a chart can be shown
       purely to be looked at — the calibration preview is one — and a cell
       that changes the cursor but answers no click is a control that lies. */
    if (!callbacks.onPlayTrack && !callbacks.onSelectRun) return null;
    return rowAt(p);
  }

  /** Whether that name's track is the one already in hand.
   *
   * Which is the whole of what a second click on a name means. Yours is in
   * hand when its row is the one being read AND the target is not what you
   * are listening to, so a run picked up while the target was playing takes
   * one click to come back to and a second to play — the same two clicks any
   * other name takes. */
  /** Which row this point is in, anywhere across the width — the gutter and
   *  the marks alike, since the tint is about the whole row.
   *
   * A row runs from its grade strip to the bottom of its caption, which is
   * exactly the band `rowsFor` reserves for it, so the tint cannot disagree
   * with what is drawn in it. Overlay has no rows of its own to tint. */
  function rowAt(p: { x: number; y: number }): GutterName | null {
    if (!input || input.settings.view === "overlay") return null;
    if (p.y >= rows.tgtLabel && p.y < rows.tgt + ROW_H) return "tgt";
    for (let r = 0; r < lanes.length; r++) {
      const row = rows.runs[r];
      if (row && p.y >= row.grade && p.y < row.bottom) return r;
    }
    return null;
  }

  function inHand(name: GutterName): boolean {
    const heard = input?.heard ?? "you";
    return name === "tgt" ? heard === "tgt" : name === selected && heard === "you";
  }

  function hitAt(p: { x: number; y: number }): HitResult | null {
    if (!layout || !input || p.x < GUTTER) return null;
    const x = contentXOf(p.x);
    const bands = trackBands(input.settings.view, rows);

    /* The target belongs to the whole stack rather than to any one attempt, so
       it is asked once — of the run being read, whose layout carries the same
       target geometry every other one does. */
    const sel = lanes[selected];
    if (sel) {
      const h = hitTest(sel.layout, x, p.y, { you: NO_BAND, tgt: bands.tgt }, selected);
      if (h) return h;
    }

    /* Then each attempt, in its own band. Overlay superimposes them, so there
       is one band to share. */
    for (let r = 0; r < lanes.length; r++) {
      /* Overlay has one band however many attempts are in it, so a lane there
         has no row of its own to be found by — and asking for one would leave
         every attempt but the first unreachable. */
      let band: [number, number];
      if (input.settings.view === "overlay") band = bands.you;
      else {
        const row = rows.runs[r];
        if (!row) continue;
        band = [row.row, row.row + ROW_H];
      }
      const h = hitTest(lanes[r]!.layout, x, p.y, { you: band, tgt: NO_BAND }, r);
      if (h) return h;
    }
    return null;
  }

  const onPointerMove = (ev: PointerEvent) => {
    if (drag && drag.moved >= DRAG_SLOP) {
      callbacks.onHover?.(null, ev.clientX, ev.clientY);
      return;
    }
    /* The one thing a finger cannot do. Hovering is a state you are in while
       pointing at something without committing to it, and a touch screen has
       no such state — the finger is either down or gone. Driven from touch
       moves anyway, the tooltip would follow the finger through a pan and
       then sit where it was lifted, describing whatever happened to be under
       it. Pen is left in: a stylus really does hover. */
    if (ev.pointerType === "touch") return;
    const p = localPos(ev);
    const over = gutterNameAt(p);
    canvas.classList.toggle("picking", over !== null);
    const band = rowAt(p);
    const h = hitAt(p);
    const b = h ? h.block : null;
    // One repaint for however many of the three moved, rather than one each.
    if (over !== picking || band !== hoverRow || b !== hover) {
      picking = over;
      hoverRow = band;
      hover = b;
      paint();
    }
    callbacks.onHover?.(h, ev.clientX, ev.clientY);
  };

  const onPointerLeave = (ev: PointerEvent) => {
    canvas.classList.remove("picking");
    callbacks.onHover?.(null, ev.clientX, ev.clientY);
    if (picking !== null || hoverRow !== null || hover) {
      picking = null;
      hoverRow = null;
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

    /* The gutter picks a track up, and plays the one already in hand. Picking up first rather than playing straight away: the report
       below the chart, the scores and the caption band all follow the
       selection, so a click on another attempt has to move them there before
       anything comes out of the speakers — playing a recording while the
       numbers on screen describe a different one is worse than one more
       click. Once it IS the one on screen, there is nothing left to move and
       the click is free to do the obvious thing. */
    const named = gutterNameAt(p);
    if (named !== null) {
      if (inHand(named)) callbacks.onPlayTrack?.(named === "tgt" ? "tgt" : "you");
      else if (named === "tgt") callbacks.onSelectTarget?.();
      else callbacks.onSelectRun?.(lanes[named]!.ordinal);
      return;
    }

    if (p.x < GUTTER || p.y >= rows.scroll) return;

    // The ruler band is a seek strip.
    if (p.y < RULER_H) {
      const at = contentXOf(p.x);
      callbacks.onSeek?.({
        you: Math.max(xToTime(layout, at, "you"), 0),
        tgt: Math.max(xToTime(layout, at, "tgt"), 0),
      });
      return;
    }
    const h = hitAt(p);
    if (!h || !input) return;

    // Another attempt: pick it up. Its audio and its numbers are not on screen
    // yet, and playing out of the wrong recording is worse than one more click.
    if (h.row === "you" && h.run !== selected) {
      callbacks.onSelectRun?.(lanes[h.run]!.ordinal);
      return;
    }

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
      const w = contextWindow(lanes[h.run]!.slots, h.row, h.index, h.block.targetKind);
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

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  /* On the window, so a drag that leaves the canvas still arrives — the mouse
     may well be outside it by the time the button comes up, and a release the
     chart never hears about is a pan that never stops. Touch gets the same
     thing for free through implicit capture, which retargets the whole
     gesture to whatever it started on. */
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerUp);

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

    setLead(seconds) {
      const next = Math.max(0, seconds);
      if (next === leadSec) return;
      leadSec = next;
      relayout();
      // Back to the start: the room was reserved so a cursor could come in
      // from the left, and it cannot do that from halfway along.
      scrollX = 0;
      paint();
    },

    setFollow(mode) {
      if (mode === follow) return;
      follow = mode;
      // Leaving `centered` has to put the view back inside its frame, which
      // the clamp will not do while the mode is still on.
      paint();
    },

    setPlayhead(next) {
      playhead = next;
      if (next && layout) {
        /* Keep the playhead on screen, by sliding the content under it.
         *
         * This used to page-jump — leave the view alone until the playhead ran
         * off the right, then throw it forward by most of a screen. Predictable
         * on paper, and very hard to follow in practice: the thing you are
         * watching teleports, and you have to find it again in a chart that has
         * just changed underneath you. Worse while pacing a recording, where
         * losing the cursor for half a second is losing your place in the
         * message.
         *
         * So the playhead is held at a fixed fraction of the track and the
         * content moves. The clamps at both ends do the rest: at the start it
         * walks out to that fraction before anything moves, and at the end the
         * content stops while it runs on to the right edge. */
        const v = viewport();
        const cx = timeToX(layout, next.t, next.side);
        if (follow === "centered") {
          /* Dead center, always — including before the first character and
             after the last, where the clamp would otherwise park the view and
             let the playhead drift across it. With the card above holding your
             eye at the middle of the screen, the mark you are about to make
             has to be in the same place every single time. */
          scrollX = cx - v.trackW / 2;
        } else if (v.maxScroll) {
          scrollX = cx - v.trackW * PLAYHEAD_HOLD;
          clampScroll(v);
        }
      }
      paint();
    },

    fit() {
      if (!input) return ZOOM_MIN;
      return fitZoom(widthAt, viewport().trackW, ZOOM_MIN, ZOOM_MAX);
    },

    scrollTo: (x: number) => doScrollTo(x, false),
    scrollAt: () => scrollX,

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
        charMarkers: input.settings.charMarkers,
      });
      let note = "";
      if (GUTTER + exportLayout.width + PAD_R > budget) {
        const fitScale = (budget - GUTTER - PAD_R) / exportLayout.width;
        ppu = Math.max(ppu * fitScale, 1);
        exportLayout = buildLayout(input.review, {
          view: input.settings.view,
          ppu,
          durationSec: input.review.take.durationSec,
          charMarkers: input.settings.charMarkers,
        });
        note = `zoomed to ${ppu.toFixed(1)} px/unit so the whole session fits`;
      }

      /* Measured at the export's own zoom, which the fit above may have
         changed. Without them the target row has no columns to draw itself
         against and would be missing from the picture entirely. */
      const exportColumns =
        input.settings.view === "per-char"
          ? measureColumns([input.review.slots], ppu, input.settings.charMarkers)
          : undefined;

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
        runs: [
          {
            layout: exportLayout,
            slots: input.review.slots,
            analysis: input.review.analysis,
            accuracy: input.review.comparison?.accuracy ?? null,
            ordinal: 0,
          },
        ],
        selected: 0,
        ...(exportColumns ? { columns: exportColumns } : {}),
        layout: exportLayout,
        slots: input.review.slots,
        analysis: input.review.analysis,
        rows: rowsFor(1, 0),
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
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
      observer?.disconnect();
    },
  };
}
