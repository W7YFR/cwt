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
import { defaultSettings, reviewTake, subLabel } from "@/timing";
import { blankTake } from "@/io/take";
import { draw, gradeOf, scrollbarThumb, trackBands, type Scene } from "@/render/scene";
import { FALLBACK_PALETTE } from "@/render/theme";
import {
  GUTTER,
  MARK_H,
  MARKER_W,
  PAD_R,
  PAD_X,
  REST_W,
  LABEL_H,
  ROW_H,
  Y_TGT,
  Y_TGT_LABEL,
  Y_YOU,
  Y_YOU_LABEL,
  ZOOM_MAX,
  ZOOM_MIN,
} from "@/render/geometry";
import type { Review, ViewMode } from "@/types";

const VIEWS: ViewMode[] = ["per-char", "absolute", "overlay"];

/** How the renderer writes a gap's length on its bracket. */
const fmtUnits = (u: number) => `${u.toFixed(1)}u`;

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

describe("the two tracks, and the text on each", () => {
  /* The target is the reference: the message you meant to send, rendered at
     the speeds now set, and the one thing on the chart that does not change
     between attempts. It goes on top, with its own caption band, and your
     sending goes underneath with its own — so each row carries its own text
     instead of one band trying to be both. */
  const review = reviewFrom(caseNamed(SLOPPY)).review;

  /* Deliberately not what was sent, and different in the FIRST character —
     with the intended message left to default it is the decode, the two
     captions say the same thing, and a test that one follows the intended text
     while the other follows the decode would pass without either being true.
     First rather than last because the far end of a long fixture is scrolled
     out of the viewport and never drawn. */
  const sent = review.actual.text;
  const swap = sent[0] === "X" ? "Y" : "X";
  const mismatched = reviewFrom(caseNamed(SLOPPY), {
    expected: `${swap}${sent.slice(1)}`,
  }).review;

  const paint = (view: ViewMode, r: Review = review) => {
    const ctx = recordingCtx();
    draw(ctx, sceneFor(r, view, 18));
    return ctx;
  };
  /* Located by the band it lands in, which is the thing under test. */
  const textAt = (ctx: ReturnType<typeof recordingCtx>, y: number) =>
    ctx.ofType("fillText").filter((c) => c.args[1] === y).map((c) => c.text ?? "");

  const TGT_CAP = Y_TGT_LABEL + LABEL_H / 2;
  const YOU_CAP = Y_YOU_LABEL + LABEL_H / 2;

  it("puts the target above your sending, in every view", () => {
    expect(Y_TGT).toBeLessThan(Y_YOU);
    for (const view of VIEWS) {
      const bands = trackBands(view);
      expect(bands.tgt[0], view).toBeLessThan(bands.you[0]);
    }
  });

  it("gives each row its own caption band, on the outside", () => {
    // Target's above its row, yours below its own, so the two tracks face each
    // other across the grade strip with no line of text between them.
    expect(Y_TGT_LABEL + LABEL_H).toBe(Y_TGT);
    expect(Y_YOU_LABEL).toBe(Y_YOU + ROW_H);
  });

  it("labels the target with what was meant and your row with what came out", () => {
    const ctx = paint("per-char", mismatched);
    // The first character is the one they disagree on.
    expect(textAt(ctx, TGT_CAP)[0]).toBe(swap);
    // Intended first, then what came out — the order the accuracy panel uses
    // and the order the two rows are stacked in.
    expect(textAt(ctx, YOU_CAP)[0]).toBe(subLabel(swap, sent[0]!));
  });

  it.each(VIEWS)("labels both rows, not just one of them (%s)", (view) => {
    /* The target row used to go unnamed in the time-axis views: there was one
       caption band and it belonged to the decode. On a wall clock the two
       rows' characters sit at different x, and that offset IS the drift —
       naming both is what makes it readable. */
    const ctx = paint(view, mismatched);
    expect(textAt(ctx, TGT_CAP).join("").length, `${view} target`).toBeGreaterThan(0);
    expect(textAt(ctx, YOU_CAP).join("").length, `${view} yours`).toBeGreaterThan(0);
  });

  it("writes a substitution the same way the accuracy panel does", () => {
    /* It was decided twice: the chart wrote the character it had under the
       arrow and the report wrote the one it wanted, so the same mistake read
       "E→I" on the chart and "I→E" under it. Whichever way round it goes, two
       places disagreeing about it is the bug. */
    const ctx = paint("per-char", mismatched);
    const onChart = textAt(ctx, YOU_CAP).find((t) => t.includes("\u2192"))!;
    const inDiff = mismatched.comparison!.diff;
    expect(onChart).toBeTruthy();
    expect(inDiff).toContain(`[${onChart}]`);
  });

  it("never marks up the target's own caption", () => {
    /* It is the text that defines what right is, so a character in it cannot
       be wrong. The arrows, the plusses and the minuses belong to the row
       underneath, which is where the differences actually are. */
    const ctx = paint("per-char", mismatched);
    for (const t of textAt(ctx, TGT_CAP)) {
      expect(t, `target caption "${t}"`).not.toMatch(/[\u2192+\u2013]/);
    }
    expect(textAt(ctx, YOU_CAP).join("")).toMatch(/[\u2192+\u2013]/);
  });
});

describe("a chart with nothing recorded into it", () => {
  /* Against an empty decode the alignment quite correctly calls every
     character a deletion and every word boundary a missing space. Drawn, that
     is a page of faults in sending that has not happened — so the target row
     stands and the "yours" row is ghosts with nothing written on it. */
  const take = blankTake({
    expected: "CQ DE W7YFR",
    charWpm: 15,
    farnsworthWpm: 12,
  });
  const review = reviewTake(take, defaultSettings(take));

  const paint = () => {
    const ctx = recordingCtx();
    draw(ctx, { ...sceneFor(review, "per-char", 18, 4000), blank: true });
    return ctx;
  };

  it("says the alignment would have plenty to complain about", () => {
    // Without this the rest of the block could pass on a review that simply
    // had no faults in it to draw.
    expect(review.slots.some((s) => s.op === "del")).toBe(true);
    expect(review.slots.some((s) => s.spaceOp === "del")).toBe(true);
  });

  it("writes nothing under your row", () => {
    const under = paint()
      .ofType("fillText")
      .filter((c) => c.args[1] === Y_YOU_LABEL + LABEL_H / 2)
      .map((c) => c.text ?? "")
      .join("");
    expect(under).toBe("");
  });

  it("does not accuse you of missing a space you never sent", () => {
    const texts = paint().texts();
    expect(texts).not.toContain("no space");
    expect(texts).not.toContain("extra space");
  });

  it("still draws the target, which is the whole point of staying", () => {
    const above = paint()
      .ofType("fillText")
      .filter((c) => c.args[1] === Y_TGT_LABEL + LABEL_H / 2)
      .map((c) => c.text ?? "")
      .join("");
    expect(above.length).toBeGreaterThan(3);
  });
});

describe("a gap that reaches in from off screen", () => {
  /* On a time axis a gap is drawn to the LEFT of the character it leads into.
     So a character just past the right edge can have a gap reaching a long way
     back into view — and culling on the character alone dropped that whole
     line until the character itself was nearly on screen, at which point it
     appeared all at once. The chart looked like it simply stopped, and the
     connection to what came next snapped into existence out of nowhere. */
  const { review } = reviewFrom(caseNamed(SLOPPY));
  const PPU = 18;
  const TRACK = 846;

  /** A slot whose lead gap is wide enough to be worth seeing, positioned so
   *  the gap is in view while the character it leads to is not. */
  function offRight() {
    const layout = buildLayout(review, {
      view: "absolute",
      ppu: PPU,
      durationSec: review.take.durationSec,
    });
    for (const it of layout.items) {
      const g = it.slot.actual?.leadGap;
      if (!g || it.x === null) continue;
      const gw = gapWidth(g, PPU);
      if (gw < 80) continue;
      // Put the right edge between the gap's midpoint and the character, well
      // clear of the margin either side.
      const right = it.x - 42;
      if (it.x - gw / 2 > right - 10) continue;
      return { label: fmtUnits(g.units), scrollX: right - TRACK };
    }
    throw new Error("no wide gap in the fixture to test with");
  }

  it("draws the gap, not only the character it leads to", () => {
    const { label, scrollX } = offRight();
    const ctx = recordingCtx();
    draw(ctx, { ...sceneFor(review, "absolute", PPU, TRACK), scrollX });
    expect(ctx.texts()).toContain(label);
  });
});

describe("characters as start markers", () => {
  /* A fixed-width tick at the moment a character begins, instead of the dits
     and dahs in it. What is being practiced is the rhythm — when the next
     character starts — and a block whose length tracked the character puts its
     duration back on screen, which is what pulls attention into counting
     elements rather than keeping time. */
  const review = reviewFrom(caseNamed(SLOPPY)).review;
  const PPU = 18;
  const ROW_Y = Y_YOU + (ROW_H - MARK_H) / 2;

  /* Wide enough that nothing is culled: these are claims about every
     character, and a viewport that dropped half of them would make them
     claims about whichever half happened to be on screen. */
  const paint = (over: Partial<Scene> = {}) => {
    const ctx = recordingCtx();
    draw(ctx, { ...sceneFor(review, "per-char", PPU, 4000), ...over });
    return ctx;
  };

  /** Every filled rounded rect on the "yours" row, as [x, width, color].
   *
   * Reconstructed from the path: `roundRect` opens with a moveTo at x+r and
   * its first arcTo carries x+w, so the two together give both ends back. */
  function bodies(ctx: ReturnType<typeof recordingCtx>) {
    const out: Array<{ x: number; w: number; fill: string }> = [];
    const { calls } = ctx;
    for (let i = 0; i < calls.length; i++) {
      const m = calls[i]!;
      if (m.op !== "moveTo" || m.args[1] !== ROW_Y) continue;
      const arc = calls[i + 1];
      if (!arc || arc.op !== "arcTo") continue;
      const fill = calls.slice(i, i + 8).find((c) => c.op === "fill");
      if (!fill) continue;
      /* `roundRect` clamps its radius to half the box, so the distance between
         those two x's is `w - min(3, w/2)` — which inverts differently for a
         tick a couple of pixels wide than for a block. */
      const d = arc.args[0]! - m.args[0]!;
      const w = d < 3 ? d * 2 : d + 3;
      out.push({ x: m.args[0]! - (w - d), w, fill: fill.fill });
    }
    return out;
  }

  it("gives every character the same width, whatever is in it", () => {
    /* The whole point. The fixture has characters of several different
       lengths, so a width that tracked the character would come back with
       several different numbers here. */
    const lengths = new Set(
      review.slots.filter((s) => s.actual).map((s) => s.actual!.blocks.length),
    );
    expect(lengths.size, "fixture has only one shape of character").toBeGreaterThan(1);

    const widths = new Set(bodies(paint({ charMarkers: true })).map((b) => b.w));
    expect(widths).toEqual(new Set([MARKER_W]));
  });

  it("puts the marker where the character starts", () => {
    // It is a mark on the clock: its position is the whole of its meaning, and
    // that position is where the character's first element begins.
    const markers = bodies(paint({ charMarkers: true }));
    expect(markers.length).toBeGreaterThan(2);

    const layout = buildLayout(review, {
      view: "per-char",
      ppu: PPU,
      durationSec: review.take.durationSec,
    });
    const starts = layout.items
      .filter((it) => it.slot.actual && it.x !== null)
      .map((it) => it.x! + it.gapW);
    expect(markers.map((m) => Math.round(m.x))).toEqual(starts.map((x) => Math.round(x)));
  });

  it("takes the worst grade of its elements and the gap that led into it", () => {
    /* Arriving late is exactly the fault this view exists to show, so the gap
       before a character counts toward its marker — and a character whose own
       elements are ragged must not come back clean just because it is drawn as
       one tick now. */
    const tolerance = 0.02;
    const drawn = bodies(paint({ charMarkers: true, tolerance }));
    const chars = review.slots.map((s) => s.actual).filter((c) => c !== null);
    expect(drawn.length).toBe(chars.length);

    const colorOf: Record<string, string> = {
      ok: FALLBACK_PALETTE.you,
      warn: FALLBACK_PALETTE.warn,
      bad: FALLBACK_PALETTE.bad,
    };
    let sawFault = false;
    chars.forEach((ch, i) => {
      let worst: "ok" | "warn" | "bad" = "ok";
      for (const b of ch!.leadGap ? [...ch!.blocks, ch!.leadGap] : ch!.blocks) {
        if (b.targetUnits <= 0) continue;
        const g = gradeOf(b.units, b.targetUnits, tolerance);
        if (g === "bad" || (g === "warn" && worst === "ok")) worst = g;
      }
      if (worst !== "ok") sawFault = true;
      expect(drawn[i]!.fill, `${ch!.char} at ${i}`).toBe(colorOf[worst]);
    });
    // A fixture with nothing wrong in it would prove nothing above.
    expect(sawFault).toBe(true);
  });

  it("leaves the chart exactly as it was when it is off", () => {
    // Inert by construction, like everything else optional here.
    expect(paint({ charMarkers: false }).calls).toEqual(paint().calls);
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
       needed is not applied, rather than applied and canceled out. Compared
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
       labeled it is the same object as the gaps below it, and the cursor
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
    /* Stacked the same way the separate rows are — target above yours — or a
       click in overlay would reach the other track from the one it does in
       every other view. */
    const bands = trackBands("overlay");
    expect(bands.tgt[1]).toBe(bands.you[0]);
    expect(bands.tgt[0]).toBeLessThan(bands.tgt[1]);
    expect(bands.you[0]).toBeLessThan(bands.you[1]);

    const rows = trackBands("per-char");
    expect(rows.tgt[0]).toBeLessThan(rows.you[0]);
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
