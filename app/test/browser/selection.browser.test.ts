/* Picking a row out of a stack, and what that is allowed to change.
 *
 * The answer is: which row is highlighted, and what the report under the chart
 * is about. Nothing else — above all not where anything on the chart is drawn.
 * A stack exists to be compared down its columns, and a comparison you cannot
 * hold still is not one.
 *
 * Here rather than in the pure tier because both ways it went wrong needed the
 * real thing: a canvas with a width to fit content into, and the effect that
 * measures it. Driven through real recordings of different lengths, since two
 * copies of one take would fit to the same zoom and prove nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewScreen } from "@/ui/ReviewScreen";
import { GUTTER, PAD_R, ROW_H, ZOOM_MIN, rowsFor } from "@/render/geometry";
import { defaultSettings, reviewTake } from "@/timing";
import { buildLayout, measureColumns } from "@/render/layout";
import type { ReviewSettings } from "@/types";
import { caseNamed, takeFrom, CLEAN, SLOPPY } from "../fixture";
import "@/ui/base.css";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  // A width to fit into, since fitting to nothing is not a fit.
  host.style.width = "900px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const TARGET = "CQ DE W7YFR";

/** The review screen driven the way App drives it: the selected index decides
 *  which attempt is loaded, which is what made picking a row re-fit. */
function mount(over: Partial<ReviewSettings> = {}) {
  const takes = [SLOPPY, CLEAN].map((name) => takeFrom(caseNamed(name)));
  let latest: ReviewSettings = {
    ...defaultSettings(takes[0]!),
    expected: TARGET,
    view: "absolute",
    ...over,
  };
  let picked = 0;

  function Harness() {
    const [settings, setSettings] = useState<ReviewSettings>(latest);
    const [at, setAt] = useState(0);
    latest = settings;
    picked = at;
    const stack = takes.map((t) => reviewTake(t, settings));
    const take = takes[at]!;
    return createElement(ReviewScreen, {
      loaded: {
        take,
        clip: { samples: new Float32Array(0), rate: take.rate, peak: 0 },
        data: null,
      },
      review: stack[at]!,
      stack,
      selected: at,
      onSelectRun: setAt,
      onDropRun: () => {},
      settings,
      onChange: (patch) => setSettings((prev) => ({ ...prev, ...patch })),
      onAudio: () => {},
      onError: () => {},
      deviceId: undefined,
      profiles: [],
      profileId: undefined,
      onProfileChange: () => {},
      onDeviceChange: () => {},
      onCalibrate: () => {},
      onFile: () => {},
      onClear: () => {},
      onNewSession: () => {},
      onBack: () => {},
    });
  }

  act(() => root.render(createElement(Harness)));
  return {
    fit: () => act(() => {
      host.querySelector<HTMLElement>("#zoom-fit")!.click();
    }),
    ppu: () => latest.ppu,
    picked: () => picked,
    runs: takes.length,
    rows: () => {
      // One lane per attempt drawn, read off the height the chart sized itself
      // to rather than counted out of the markup — the rows are painted.
      const h = host.querySelector("canvas")!.getBoundingClientRect().height;
      return Math.round((h - rowsFor(1, 0).height) / (rowsFor(2, 0).height - rowsFor(1, 0).height)) + 1;
    },
  };
}

/** Click in a row's cell in the gutter, which is how a row is picked. */
function pick(at: number, of: number, y?: number): void {
  const canvas = host.querySelector("canvas")!;
  const box = canvas.getBoundingClientRect();
  const rows = rowsFor(of, 0);
  act(() =>
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: box.left + 8,
        clientY: box.top + (y ?? rows.runs[at]!.row + ROW_H / 2),
        bubbles: true,
      }),
    ),
  );
}

/** Move the pointer somewhere and say whether the chart offers a click there. */
function hovering(y: number): boolean {
  const canvas = host.querySelector("canvas")!;
  const box = canvas.getBoundingClientRect();
  act(() =>
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: box.left + 8,
        clientY: box.top + y,
        pointerId: 1,
        isPrimary: true,
        pointerType: "mouse",
        bubbles: true,
      }),
    ),
  );
  return canvas.classList.contains("picking");
}

describe("picking a row out of a stack", () => {
  it("leaves the zoom where it was", () => {
    /* The opening fit is measured off the content, and each attempt is a
       slightly different length. Keyed on the attempt being read, picking a
       row re-fit the chart to that row — so every mark moved, including those
       in the rows you picked it in order to compare against. */
    const app = mount();
    const zoom = app.ppu();
    expect(zoom).toBeGreaterThan(0);

    for (let at = 0; at < app.runs; at++) {
      pick(at, app.runs);
      expect(app.picked(), `picked run ${at + 1}`).toBe(at);
      expect(app.ppu(), `zoom after picking run ${at + 1}`).toBe(zoom);
    }
  });

});

/* Where the rows go under a changing selection is `rowsFor`, and it is pinned
   in the pure tier — every lane the same height whichever is captioned, and
   the whole chart laid out identically across all four selections. The total
   height cannot catch that on its own: exactly one lane wears the caption
   however the selection moves, so the chart came to the same height while
   every row under the selection sat somewhere else. */

describe("showing one attempt or all of them", () => {
  it("draws every attempt by default and just the newest when asked", () => {
    /* All of them is the comparison — one column axis, readable down a column
       as well as along a row. The last one alone is the loop: send it, look at
       it, send it again, where the attempts behind it are in the way. */
    expect(mount().rows()).toBe(2);
    expect(mount({ showRuns: "last" }).rows()).toBe(1);
  });

  it("reads the attempt it is drawing", () => {
    /* Everything under the chart is about the selected run, so drawing the
       last one while the scores describe another would be two answers to one
       question. */
    const app = mount({ showRuns: "last" });
    expect(app.picked()).toBe(app.runs - 1);
  });
});

describe("the gutter as a handle", () => {
  it("offers the whole of a row's cell, not the line its name is written on", () => {
    /* The row lights under the pointer across its whole height. Only a few
       pixels of that answering a click makes the highlight a lie about where
       the thing you are pointing at is — so the cell that answers is the band
       that lit: the grade strip, the marks and the caption under them. */
    const app = mount();
    const rows = rowsFor(app.runs, 0);
    const lane = rows.runs[1]!;

    for (const [what, y] of [
      ["its grade strip", lane.grade + 2],
      ["its marks", lane.row + ROW_H / 2],
      ["its caption", lane.bottom - 4],
    ] as const) {
      expect(hovering(y), what).toBe(true);
    }
    // And not the air between one row's cell and the next.
    expect(hovering(rows.runs[0]!.bottom + 2), "the gap between rows").toBe(false);

    // Every part of it picks the same row up.
    for (const y of [lane.grade + 2, lane.row + ROW_H / 2, lane.bottom - 4]) {
      pick(0, app.runs);
      expect(app.picked()).toBe(0);
      pick(1, app.runs, y);
      expect(app.picked(), `picked from y=${y}`).toBe(1);
    }
  });
});

describe("overlay, which is one band however many attempts are in it", () => {
  it("does not grow a row's worth of page per attempt", () => {
    /* Laid out per lane it reserved a row, a grade strip and a caption band
       for each — none of which it draws — so a session opened a screen of
       empty page between the marks and the drift plot. Superimposing the
       attempts is the whole of the view: there is one band, and its height is
       not a function of how many things are in it. */
    const stacked = mount({ view: "overlay" });
    const height = () => host.querySelector("canvas")!.getBoundingClientRect().height;
    const many = height();
    expect(stacked.runs).toBeGreaterThan(1);

    act(() => root.unmount());
    root = createRoot(host);
    mount({ view: "overlay", showRuns: "last" });
    expect(height()).toBe(many);
  });
});

describe("fitting the chart to the window", () => {
  /* Wide enough that the fit is a real answer rather than the slider's floor.
     At 900px this session cannot fit at any zoom the slider offers, and a
     chart that is already as small as it goes proves nothing about fitting. */
  const WIDE = 3200;

  /** The width the chart scrolls within, at the zoom now in force.
   *
   * Built the way the chart builds it, which is the whole point: the rows of a
   * stack share a column axis whose columns are as wide as the widest run put
   * them, so no single run's own layout is the answer. */
  function contentWidth(ppu: number, runs: number): number {
    const takes = [SLOPPY, CLEAN].map((name) => takeFrom(caseNamed(name)));
    const settings = { ...defaultSettings(takes[0]!), expected: TARGET, ppu };
    const drawn = takes.slice(takes.length - runs).map((t) => reviewTake(t, settings));
    const columns = measureColumns(drawn.map((r) => r.slots), ppu);
    return Math.max(
      ...drawn.map(
        (r, at) =>
          buildLayout(r, {
            view: "per-char",
            ppu,
            columns,
            run: at,
            durationSec: r.take.durationSec,
          }).width,
      ),
    );
  }

  const track = () =>
    host.querySelector("canvas")!.getBoundingClientRect().width - GUTTER - PAD_R;

  it.each([
    ["every attempt", "all" as const, 2],
    ["one attempt", "last" as const, 1],
  ])("leaves nothing to scroll with %s drawn", (_name, showRuns, drawn) => {
    host.style.width = `${WIDE}px`;
    const app = mount({ view: "per-char", showRuns });
    app.fit();
    // A real fit, not the floor — otherwise this asserts nothing.
    expect(app.ppu()).toBeGreaterThan(ZOOM_MIN);
    expect(contentWidth(app.ppu(), drawn)).toBeLessThanOrEqual(track());
  });
});
