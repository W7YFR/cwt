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
import { ROW_H, rowsFor } from "@/render/geometry";
import { defaultSettings, reviewTake } from "@/timing";
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
function mount() {
  const takes = [SLOPPY, CLEAN].map((name) => takeFrom(caseNamed(name)));
  let latest: ReviewSettings = {
    ...defaultSettings(takes[0]!),
    expected: TARGET,
    view: "absolute",
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
      onConfigure: () => {},
      onCalibrate: () => {},
      onFile: () => {},
      onClear: () => {},
      onNewSession: () => {},
      onBack: () => {},
    });
  }

  act(() => root.render(createElement(Harness)));
  return { ppu: () => latest.ppu, picked: () => picked, runs: takes.length };
}

/** Click a run's name in the gutter, which is how a row is picked. */
function pick(at: number, of: number): void {
  const canvas = host.querySelector("canvas")!;
  const box = canvas.getBoundingClientRect();
  const rows = rowsFor(of, 0);
  act(() =>
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: box.left + 8,
        clientY: box.top + rows.runs[at]!.row + ROW_H / 2,
        bubbles: true,
      }),
    ),
  );
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
