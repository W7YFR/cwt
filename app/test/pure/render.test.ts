/* The chart, checked without a browser.
 *
 * Everything here runs against the real renderer through a recording context,
 * so these assert what the chart decided — not that it managed to draw
 * something. The parts that genuinely need a GPU (device pixel ratio, real
 * event dispatch) live in the browser tier.
 */

import { describe, expect, it } from "vitest";
import { recordingCtx } from "../recording-ctx";
import { caseNamed, reviewFrom, CLEAN, FARNSWORTH, SLOPPY } from "../fixture";
import {
  buildLayout,
  charWidth,
  fitZoom,
  gapWidth,
  isRest,
  slotSpan,
  timeToX,
  xToTime,
  type Layout,
} from "@/render/layout";
import { contextSlots, contextWindow, focusSpan, hitTest, slotIndexAtTime } from "@/render/focus";
import { draw, gradeOf, scrollbarThumb, trackBands, type Scene } from "@/render/scene";
import { FALLBACK_PALETTE } from "@/render/theme";
import {
  GUTTER,
  PAD_R,
  PAD_X,
  REST_W,
  ROW_H,
  Y_TGT,
  ZOOM_MAX,
  ZOOM_MIN,
} from "@/render/geometry";
import type { Review, ViewMode } from "@/types";

const VIEWS: ViewMode[] = ["per-char", "absolute", "overlay"];

function layoutFor(review: Review, view: ViewMode, ppu: number): Layout {
  return buildLayout(review, { view, ppu, durationSec: review.take.durationSec });
}

function sceneFor(review: Review, view: ViewMode, ppu: number, trackW = 900): Scene {
  const layout = layoutFor(review, view, ppu);
  return {
    layout,
    slots: review.slots,
    analysis: review.analysis,
    palette: FALLBACK_PALETTE,
    view,
    tolerance: 0.3,
    scrollX: 0,
    viewport: {
      viewW: trackW + GUTTER + PAD_R,
      trackW,
      contentW: layout.width,
      maxScroll: Math.max(0, layout.width - trackW),
    },
    durationSec: review.take.durationSec,
    idealDuration: review.ideal.duration,
    hover: null,
    focus: null,
    playhead: null,
  };
}

describe("layout", () => {
  const { review } = reviewFrom(caseNamed(SLOPPY));

  it.each(VIEWS)("lays %s out with one item per slot", (view) => {
    const layout = layoutFor(review, view, 12);
    expect(layout.items.length).toBe(review.slots.length);
    expect(layout.width).toBeGreaterThan(PAD_X);
  });

  it("gives a wider chart at a higher zoom", () => {
    const narrow = layoutFor(review, "per-char", 6).width;
    const wide = layoutFor(review, "per-char", 24).width;
    expect(wide).toBeGreaterThan(narrow);
  });

  it("is not proportional to the zoom, which is why fit has to iterate", () => {
    // Per-slot padding and the fixed rest width do not scale, so doubling the
    // zoom gives less than double the width. A fit that solved the proportion
    // in one step would undershoot every time.
    const a = layoutFor(review, "per-char", 6).width;
    const b = layoutFor(review, "per-char", 12).width;
    expect(b).toBeLessThan(2 * a);
  });

  it("maps time to x and back again", () => {
    const layout = layoutFor(review, "per-char", 12);
    for (const ch of review.actual.chars.slice(0, 8)) {
      const x = timeToX(layout, ch.t0, "you");
      expect(xToTime(layout, x, "you")).toBeCloseTo(ch.t0, 6);
    }
  });

  it("keeps the time axis monotonic in every view", () => {
    for (const view of VIEWS) {
      const layout = layoutFor(review, view, 12);
      for (const side of ["you", "tgt"] as const) {
        let prevT = -Infinity;
        let prevX = -Infinity;
        for (const [t, x] of layout.maps[side]) {
          expect(t, `${view}/${side} time went backwards`).toBeGreaterThanOrEqual(prevT);
          expect(x, `${view}/${side} x went backwards`).toBeGreaterThanOrEqual(prevX - 1e-6);
          prevT = t;
          prevX = x;
        }
      }
    }
  });

  it("clamps a rest to a fixed sliver instead of drawing it to scale", () => {
    // A rest's real width is uninformative and ruinous: one 200-unit silence at
    // a readable zoom would push everything after it off screen.
    const rest = {
      t0: 0,
      t1: 10,
      kind: "pause" as const,
      units: 200,
      targetUnits: 0,
      context: "",
      targetKind: "pause" as const,
    };
    expect(isRest(rest)).toBe(true);
    expect(gapWidth(rest, 12)).toBe(REST_W);
    expect(gapWidth({ ...rest, kind: "word-gap", targetKind: "word-gap" }, 12)).toBe(2400);
  });

  it("measures a character as the sum of its own blocks", () => {
    const ch = review.actual.chars[0]!;
    const sum = ch.blocks.reduce((a, b) => a + b.units, 0);
    expect(charWidth(ch, 10)).toBeCloseTo(sum * 10, 9);
  });
});

describe("the pacing cursor's count-in", () => {
  /* Room reserved in front of the first character so a cursor has somewhere to
     come in from. Without it there is nowhere: the axis stops at the first
     character and `timeToX` clamps anything earlier to it, so the cursor would
     simply appear on the beat — which is a count-in you cannot count along
     with. */
  const LEAD = 2;
  const review = reviewFrom(caseNamed(SLOPPY)).review;

  const withLead = (view: ViewMode, ppu: number) =>
    buildLayout(review, {
      view,
      ppu,
      durationSec: review.take.durationSec,
      leadSec: LEAD,
    });

  it.each(VIEWS)("changes nothing at all when there is none (%s)", (view) => {
    /* The rule the rest of this codebase is built on: a correction that is not
       needed is not applied, rather than applied and cancelled out. Compared
       structurally, because a lead-in that shifted the axis by a rounding
       error would be invisible here and visible on screen. */
    const plain = layoutFor(review, view, 18);
    const zero = buildLayout(review, {
      view,
      ppu: 18,
      durationSec: review.take.durationSec,
      leadSec: 0,
    });
    expect(zero).toEqual(plain);
  });

  it.each(VIEWS)("puts the first character a count-in further along (%s)", (view) => {
    const plain = layoutFor(review, view, 18);
    const led = withLead(view, 18);
    const leadPx = (LEAD / plain.unitSec) * 18;

    expect(led.width).toBeCloseTo(plain.width + leadPx, 6);
    for (let i = 0; i < plain.items.length; i++) {
      const a = plain.items[i]!;
      const b = led.items[i]!;
      if (a.x !== null) expect(b.x!).toBeCloseTo(a.x + leadPx, 6);
      if (a.ix !== null) expect(b.ix!).toBeCloseTo(a.ix + leadPx, 6);
    }
  });

  it.each(VIEWS)("runs the count-in at the chart's own tempo (%s)", (view) => {
    /* The point of doing this on the time axis rather than as a flourish over
       it. A count-in at some other tempo is worse than none — you would read
       the wrong speed off it and come in wrong. */
    const ppu = 18;
    const led = withLead(view, ppu);
    const first = led.maps.tgt[1] ?? led.maps.tgt[0]!;
    const start = led.maps.tgt[0]!;

    const seconds = first[0] - start[0];
    const pixels = first[1] - start[1];
    expect(seconds).toBeCloseTo(LEAD, 6);
    // Same pixels per second as the body of the chart.
    expect(pixels / seconds).toBeCloseTo(ppu / led.unitSec, 4);
  });

  /* Located by where it lands, not by its words. The ruler draws "3s" too —
     on the ruler — and a test that could not tell the two apart would pass on
     the tick and call the bracket drawn. */
  const textAt = (ctx: ReturnType<typeof recordingCtx>, y: number) =>
    ctx.ofType("fillText").filter((c) => c.args[1] === y).map((c) => c.text);

  const LEAD_ROW_Y = Y_TGT + ROW_H / 2;
  /* The count sits at the far left of the caption band, where the captions
     cannot reach while the count-in is holding them to the right of it. Picked
     out by its weight — nothing else on the chart is drawn bold — rather than
     by its size or its exact position, neither of which it is the job of this
     test to pin. */
  const countdowns = (ctx: ReturnType<typeof recordingCtx>) =>
    ctx
      .ofType("fillText")
      .filter((c) => c.font.startsWith("700 "))
      .map((c) => c.text);

  function paint(ppu: number, over: Partial<Scene> = {}) {
    const ctx = recordingCtx();
    draw(ctx, {
      ...sceneFor(review, "per-char", ppu),
      layout: withLead("per-char", ppu),
      leadSec: LEAD,
      ...over,
    });
    return ctx;
  }

  it("draws the count-in as a measured silence, not as empty space", () => {
    /* Empty space says nothing — it reads as the chart starting late rather
       than as time you are meant to be counting through. Bracketed and
       labelled it is the same object as the gaps below it, and the cursor
       crossing it means something. */
    expect(textAt(paint(18), LEAD_ROW_Y)).toContain(`${LEAD}s`);
  });

  it("says how long is left, where it cannot scroll away", () => {
    /* The cursor shows where it has got to and the bracket shows how far it
       has to come; neither answers "how long have I got" at a glance, which is
       the one thing somebody with a hand on a paddle is asking. Drawn outside
       the scrolled group for that reason. */
    const arrival = withLead("per-char", 18).maps.tgt[1]![0];
    const at = (t: number) => countdowns(paint(18, { playhead: { t, side: "tgt" } }));

    expect(at(arrival - 1.9)).toEqual(["1.9"]);
    expect(at(arrival - 0.5)).toEqual(["0.5"]);
    /* Tenths, and really tenths: a count that ticks whole seconds tells you
       which second you are in and nothing about where in it, which is the
       only thing being asked of it. */
    expect(at(arrival - 0.4)).toEqual(["0.4"]);
    // Gone the moment the cursor is past the first character.
    expect(at(arrival + 0.5)).toEqual([]);
  });

  it("shows neither when no count-in was asked for", () => {
    // Inert by construction, like every other correction here.
    const ctx = recordingCtx();
    draw(ctx, {
      ...sceneFor(review, "per-char", 18),
      playhead: { t: 0, side: "tgt" as const },
    });
    expect(textAt(ctx, LEAD_ROW_Y)).not.toContain(`${LEAD}s`);
    expect(countdowns(ctx)).toEqual([]);
  });

  it("gives the cursor somewhere to be before the first character", () => {
    /* The symptom this exists to prevent: every instant of the count-in
       mapping to the same x, so the cursor sits still and then jumps. */
    const led = withLead("per-char", 18);
    const firstT = led.maps.tgt[1]![0];
    const xs = [0, 0.5, 1, 1.5].map((f) => timeToX(led, firstT - LEAD + f * LEAD, "tgt"));
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    // And it arrives exactly on the first character, not near it.
    expect(timeToX(led, firstT, "tgt")).toBeCloseTo(led.maps.tgt[1]![1], 6);
  });
});

describe("fit zoom", () => {
  const { review } = reviewFrom(caseNamed(SLOPPY));

  it.each(VIEWS)("fills the track in %s without overflowing it", (view) => {
    const trackW = 1200;
    const ppu = fitZoom(
      review,
      { view, durationSec: review.take.durationSec },
      trackW,
      ZOOM_MIN,
      ZOOM_MAX,
    );
    const width = layoutFor(review, view, ppu).width;
    expect(ppu).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(ppu).toBeLessThanOrEqual(ZOOM_MAX);
    // Within a slot's padding of the target, and never spilling past it by
    // more than the rounding to a tenth of a pixel allows.
    expect(width).toBeLessThanOrEqual(trackW * 1.02);
    expect(width).toBeGreaterThan(trackW * 0.8);
  });

  it("never goes below the slider's floor for a very long session", () => {
    const ppu = fitZoom(
      review,
      { view: "per-char", durationSec: review.take.durationSec },
      80, // an absurdly narrow window
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(ppu).toBe(ZOOM_MIN);
  });

  it("zooms a short session IN to fill the width", () => {
    // The failure this pins: opening at the slider minimum leaves a short
    // session stranded in a third of the chart.
    const { review: short } = reviewFrom(caseNamed(FARNSWORTH));
    const ppu = fitZoom(
      short,
      { view: "per-char", durationSec: short.take.durationSec },
      4000,
      ZOOM_MIN,
      ZOOM_MAX,
    );
    expect(ppu).toBeGreaterThan(ZOOM_MIN);
  });
});

describe("focus scoping", () => {
  const { review } = reviewFrom(caseNamed(SLOPPY));
  const slots = review.slots;

  it("scopes a dit, dah or intra-character gap to one character", () => {
    for (const kind of ["dit", "dah", "element-gap"] as const) {
      for (let i = 0; i < Math.min(slots.length, 6); i++) {
        expect(contextSlots(slots, "you", i, kind), `${kind} at ${i}`).toEqual([i, i]);
      }
    }
  });

  it("scopes a letter gap to the characters either side of it", () => {
    expect(contextSlots(slots, "you", 3, "char-gap")).toEqual([2, 3]);
  });

  it("scopes a word gap to whole words", () => {
    const r = contextSlots(slots, "you", 3, "word-gap");
    expect(r).not.toBeNull();
    expect(r![0]).toBeLessThanOrEqual(3);
    expect(r![1]).toBeGreaterThanOrEqual(3);
    // Strictly wider than a letter gap's scope, or the two classes would
    // highlight the same thing and the distinction would be invisible.
    const chars = contextSlots(slots, "you", 3, "char-gap")!;
    expect(r![1] - r![0]).toBeGreaterThanOrEqual(chars[1] - chars[0]);
  });

  it("plays exactly what the highlight covers", () => {
    // These two came apart once, and the symptom — hovering lights one stretch,
    // clicking plays another — is very hard to notice and easy to disbelieve.
    const layout = layoutFor(review, "per-char", 12);
    for (const dev of review.analysis.deviations) {
      const idx = slotIndexAtTime(slots, dev.timeSec);
      const win = contextWindow(slots, "you", idx, dev.kind);
      const span = focusSpan(layout, slots, { side: "you", idx, kind: dev.kind });
      if (!win || !span) continue;
      // The window is in seconds, the span in pixels; both must cover the same
      // slots, which is the property that matters.
      const r = contextSlots(slots, "you", idx, dev.kind)!;
      const firstChar = slots[r[0]]?.actual ?? slots[idx]!.actual!;
      expect(win[0]).toBeLessThanOrEqual(firstChar.t0 + 1e-9);
      expect(span[0]).toBeLessThanOrEqual(
        slotSpan(layout, "you", r[0], false)?.[0] ?? Infinity,
      );
    }
  });

  it("does not reach into a neighbor for a fault inside one character", () => {
    // The regression that prompted the scoping rewrite: a 23 ms hesitation
    // inside a B highlighted A through C.
    for (const dev of review.analysis.deviations) {
      if (dev.kind === "char-gap" || dev.kind === "word-gap") continue;
      const idx = slotIndexAtTime(slots, dev.timeSec);
      const win = contextWindow(slots, "you", idx, dev.kind);
      if (!win) continue;
      const before = slots[idx - 1]?.actual;
      const after = slots[idx + 1]?.actual;
      if (before) {
        expect(
          win[0],
          `${dev.kind} at ${dev.timeSec}s reaches back into the previous character`,
        ).toBeGreaterThan(before.t1 - 1e-9);
      }
      if (after) {
        expect(
          win[1],
          `${dev.kind} at ${dev.timeSec}s reaches into the next character`,
        ).toBeLessThan(after.t0 + 1e-9);
      }
    }
  });

  it("finds the slot a deviation's time belongs to", () => {
    for (const dev of review.analysis.deviations) {
      const idx = slotIndexAtTime(slots, dev.timeSec);
      expect(idx).toBeGreaterThanOrEqual(0);
      const a = slots[idx]!.actual;
      expect(a).not.toBeNull();
      // A gap deviation's time is its lead gap's start, which is also the
      // instant the previous slot ends — so both slots contain it, and the
      // right answer is the one the gap leads INTO.
      const from = a!.leadGap ? a!.leadGap.t0 : a!.t0;
      expect(dev.timeSec).toBeGreaterThanOrEqual(from - 1e-6);
      expect(dev.timeSec).toBeLessThanOrEqual(a!.t1 + 1e-6);
    }
  });
});

describe("hit testing", () => {
  const { review } = reviewFrom(caseNamed(SLOPPY));

  it.each(VIEWS)("finds the block under a point in %s", (view) => {
    const layout = layoutFor(review, view, 16);
    const bands = trackBands(view);
    const midYou = (bands.you[0] + bands.you[1]) / 2;

    // Walk across the first character's own marks and make sure each is found.
    const item = layout.items.find((i) => i.slot.actual);
    expect(item).toBeDefined();
    const ch = item!.slot.actual!;
    let bx = view === "per-char" ? item!.x! + item!.gapW : item!.x!;
    for (const b of ch.blocks) {
      const w = b.units * layout.ppu;
      const hit = hitTest(layout, bx + w / 2, midYou, bands);
      expect(hit?.block, `${view}: block at ${bx + w / 2}`).toBe(b);
      expect(hit?.char).toBe(ch);
      expect(hit?.row).toBe("you");
      bx += w;
    }
  });

  it("returns nothing above the tracks", () => {
    const layout = layoutFor(review, "per-char", 16);
    expect(hitTest(layout, 100, 0, trackBands("per-char"))).toBeNull();
  });

  it("splits the shared band in overlay so both tracks stay reachable", () => {
    const bands = trackBands("overlay");
    expect(bands.you[1]).toBe(bands.tgt[0]);
    expect(bands.you[0]).toBeLessThan(bands.you[1]);
    expect(bands.tgt[0]).toBeLessThan(bands.tgt[1]);
  });
});

describe("grading a value", () => {
  it("calls an exact match clean and a big miss bad", () => {
    expect(gradeOf(1, 1, 0.3)).toBe("ok");
    expect(gradeOf(1.29, 1, 0.3)).toBe("ok");
    expect(gradeOf(1.5, 1, 0.3)).toBe("warn");
    expect(gradeOf(2.5, 1, 0.3)).toBe("bad");
  });

  it("grades nothing that has no target", () => {
    // A rest carries targetUnits 0 and must not read as an infinite error.
    expect(gradeOf(200, 0, 0.3)).toBe("none");
  });
});

describe("drawing", () => {
  const { review } = reviewFrom(caseNamed(SLOPPY));

  it.each(VIEWS)("draws something in every view (%s)", (view) => {
    const ctx = recordingCtx();
    draw(ctx, sceneFor(review, view, 12));
    expect(ctx.calls.length).toBeGreaterThan(50);
    expect(ctx.ofType("clearRect").length).toBe(1);
    // The gutter is drawn last and outside the content clip, so nothing can
    // slide underneath the track labels.
    expect(ctx.texts()).toContain("YOU");
    expect(ctx.texts()).toContain("TGT");
    expect(ctx.texts()).toContain("DRIFT");
  });

  it("clips the content to the right of the gutter", () => {
    const ctx = recordingCtx();
    draw(ctx, sceneFor(review, "per-char", 12));
    const clipRect = ctx.ofType("rect")[0];
    expect(clipRect?.args[0]).toBe(GUTTER);
    expect(ctx.ofType("clip").length).toBe(1);
  });

  it("captions each character, and marks a substitution", () => {
    const ctx = recordingCtx();
    draw(ctx, sceneFor(review, "per-char", 12, 20000));
    const texts = ctx.texts();
    for (const ch of review.actual.chars.slice(0, 5)) {
      const captioned = texts.some((t) => t === ch.char || t.startsWith(`${ch.char}→`));
      expect(captioned, `no caption for ${ch.char}`).toBe(true);
    }
  });

  it("draws only what is on screen", () => {
    const narrow = recordingCtx();
    draw(narrow, sceneFor(review, "per-char", 30, 200));
    const wide = recordingCtx();
    draw(wide, sceneFor(review, "per-char", 30, 20000));
    expect(wide.calls.length).toBeGreaterThan(narrow.calls.length * 2);
  });

  it("labels a rest with its real length, which it is not drawn to", () => {
    const { review: rested } = reviewFrom(caseNamed(SLOPPY), { collapseRests: true });
    const hasRest = rested.actual.blocks.some((b) => b.targetKind === "pause");
    if (!hasRest) return; // this fixture has no stop in it
    const ctx = recordingCtx();
    draw(ctx, sceneFor(rested, "per-char", 12, 20000));
    expect(ctx.texts().some((t) => t.startsWith("Rest "))).toBe(true);
  });

  it("shows no scrollbar when everything fits", () => {
    expect(scrollbarThumb(0, { viewW: 900, trackW: 800, contentW: 400, maxScroll: 0 })).toBeNull();
  });

  it("sizes the scrollbar thumb to the visible fraction", () => {
    const th = scrollbarThumb(0, {
      viewW: 900,
      trackW: 800,
      contentW: 3200,
      maxScroll: 2400,
    });
    expect(th).not.toBeNull();
    expect(th!.w).toBeCloseTo(800 * (800 / 3200), 6);
    expect(th!.x).toBe(GUTTER);
  });

  it("puts the thumb at the far end when scrolled to the end", () => {
    const v = { viewW: 900, trackW: 800, contentW: 3200, maxScroll: 2400 };
    const th = scrollbarThumb(v.maxScroll, v)!;
    expect(th.x + th.w).toBeCloseTo(GUTTER + v.trackW, 6);
  });

  it("draws a highlight only when a row is focused", () => {
    const plain = recordingCtx();
    draw(plain, sceneFor(review, "per-char", 12, 20000));

    const focused = recordingCtx();
    const scene = sceneFor(review, "per-char", 12, 20000);
    const dev = review.analysis.deviations[0];
    expect(dev, "fixture has no deviations to focus").toBeDefined();
    scene.focus = {
      side: "you",
      idx: slotIndexAtTime(review.slots, dev!.timeSec),
      kind: dev!.kind,
    };
    draw(focused, scene);

    expect(focused.calls.length).toBeGreaterThan(plain.calls.length);
  });

  it("draws the playhead on the track that is playing", () => {
    const scene = sceneFor(review, "per-char", 12, 20000);
    const t = review.actual.chars[2]!.t0;
    scene.playhead = { t, side: "you" };
    const ctx = recordingCtx();
    draw(ctx, scene);
    const expectedX = GUTTER + timeToX(scene.layout, t, "you") - scene.scrollX;
    const moves = ctx.ofType("moveTo").map((c) => c.args[0]);
    expect(moves.some((x) => Math.abs(x! - expectedX) < 0.01)).toBe(true);
  });

  it("leaves a clean recording's chart free of bad-colored marks", () => {
    const { review: clean } = reviewFrom(caseNamed(CLEAN));
    const ctx = recordingCtx();
    draw(ctx, sceneFor(clean, "per-char", 12, 20000));
    // A machine keyer at its own nominal speed should be almost entirely
    // inside tolerance; a chart full of red would mean the grader is wrong.
    const fills = ctx.ofType("fill").map((c) => c.fill);
    const bad = fills.filter((f) => f === FALLBACK_PALETTE.bad).length;
    expect(bad / fills.length).toBeLessThan(0.1);
  });
});
