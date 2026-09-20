/* The review header at a phone's width.
 *
 * Geometry, in a real browser, because that is the only place this can be
 * checked: the rules are a media query and a flex wrap, and jsdom has neither
 * a viewport nor a layout. What went wrong was not that anything was missing
 * — every control was present and correct — but that they were all on one
 * line, squeezing each other until the buttons re-flowed their own labels and
 * the status ran off the right edge.
 *
 * So the assertions are about position, not presence: what is on which line,
 * and whether anything sticks out past the page.
 *
 * One symptom from the report is deliberately not tested here: a button
 * re-flowing its own label, which is what "New session" was doing across two
 * lines. This tier is Chromium, and Chromium will not shrink a <button> below
 * its label whatever the pressure — the overflow lands somewhere else instead.
 * WebKit will, which is where the screenshots came from. `white-space: nowrap`
 * on `.recordbar button` is the guard, and it is a guard no test on this tier
 * can fail, so writing one would only have looked like coverage.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Fragment, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
/* The rules under test are in the stylesheet, and nothing in this file's
   imports would otherwise pull it in: the app loads it from main.tsx, which a
   component test never reaches. Without it every measurement below is of
   unstyled markup, which lays out differently and proves nothing. */
import "@/ui/base.css";
import { RecordBar } from "@/ui/Record";
import { APP_NAME, Brandmark } from "@/ui/Wordmark";
import { visitWordmark } from "@/ui/wordmarks";
import type { RecorderHandle } from "@/ui/useRecorder";

/** A phone held upright, and the width the screenshots that started this were
 *  taken at. */
const NARROW = 414;
const WIDE = 1200;

const IDLE: RecorderHandle = {
  devices: [],
  probing: false,
  needAccess: false,
  blocked: false,
  grantAccess: async () => {},
  recorder: null,
  elapsed: 0,
  level: 0,
  busy: false,
  start: async () => {},
  restart: () => {},
  finish: async () => {},
  discard: async () => {},
};

/** Recording, with a clock and a level to watch. */
const RUNNING: RecorderHandle = {
  ...IDLE,
  elapsed: 6.4,
  level: 0.4,
  recorder: {
    elapsed: () => 6.4,
    peek: () => new Float32Array(0),
    stop: async () => ({ samples: new Float32Array(0), rate: 8000, peak: 0 }),
    restart: () => {},
    cancel: async () => {},
  },
};

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  /* The real header, because that is what the rules are written against: the
     bar is a flex item in it, and the filename is its sibling. A bare div
     would lay the same markup out differently and prove nothing. */
  host = document.createElement("header");
  document.body.style.margin = "0";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await page.viewport(WIDE, 800);
});

function show(rec: RecorderHandle, source?: string) {
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        /* The brand belongs in here. It is the widest fixed thing in the band
           and it never moves, so it is a large part of what the controls are
           competing for — leave it out and the row has room it does not really
           have, and the squeeze this file is about never happens. */
        createElement(
          "h1",
          { className: "brand" },
          createElement(
            "button",
            { className: "brandmark", "aria-label": APP_NAME },
            createElement(Brandmark, { art: visitWordmark() }),
          ),
        ),
        createElement(RecordBar, {
          rec,
          deviceId: undefined,
          onDeviceChange: () => {},
          profiles: [],
          profileId: undefined,
          onProfileChange: () => {},
          appliesToTake: false,
          rereading: false,
          leadLeft: null,
          onClear: () => {},
          onNewSession: () => {},
          onFile: () => {},
          source,
        }),
      ),
    ),
  );
}

const box = (sel: string) => host.querySelector(sel)!.getBoundingClientRect();

/** Every element that draws something, measured against the page's own width. */
function overflowing(): string[] {
  const out: string[] = [];
  for (const el of host.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > document.documentElement.clientWidth + 0.5) {
      out.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(r.right)}`);
    }
  }
  return out;
}

describe("the review header on a narrow screen", () => {
  it("stacks the note under the filename", async () => {
    await page.viewport(NARROW, 800);
    show(IDLE, "bens-best-bent-wire-grading-bug.wav");

    /* The order the screenshots asked for: what you can do, then what you are
       looking at, then how it is being read. Beside each other these are two
       short things on a row too narrow for either. */
    expect(box(".calchip").top).toBeGreaterThanOrEqual(box(".src").bottom - 1);
    expect(box(".srcrow").top).toBeGreaterThanOrEqual(box(".recordbar").bottom - 1);
  });

  it("puts the note beside the filename when there is room", async () => {
    await page.viewport(WIDE, 800);
    show(IDLE, "bens-best-bent-wire-grading-bug.wav");

    // One line, and the note to the right of the name it is about.
    expect(box(".calchip").top).toBeLessThan(box(".src").bottom);
    expect(box(".calchip").left).toBeGreaterThan(box(".src").right);
    // Still the foot of the header, below everything it is a footnote to.
    expect(box(".srcrow").top).toBeGreaterThanOrEqual(box(".recordbar").bottom - 1);
  });

  it("leaves the control row to the controls", async () => {
    await page.viewport(WIDE, 800);
    show(IDLE, "bens-best-bent-wire-grading-bug.wav");

    /* The note used to ride at the end of the button row, which is where it
       went for want of anywhere better rather than because it belonged. */
    expect(box(".calchip").top).toBeGreaterThanOrEqual(box(".recordbar").bottom - 1);
  });

  it("puts the transport below the clock and the level while recording", async () => {
    await page.viewport(NARROW, 800);
    show(RUNNING);

    /* The two things being watched with a hand on a paddle keep the first
       line. A button wrapping above them moved them down the screen in the
       middle of a take. */
    expect(box(".recbtns").top).toBeGreaterThanOrEqual(box(".reclight").bottom - 1);
    expect(box(".recbtns").top).toBeGreaterThanOrEqual(box(".meter").bottom - 1);
    // The three of them together, on one line of their own.
    const buttons = [...host.querySelectorAll<HTMLElement>(".recbtns button")];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b.getBoundingClientRect().top).toBeCloseTo(box(".recbtns").top, 0);
    }
  });

  it("keeps the transport on the clock's line when there is room", async () => {
    await page.viewport(WIDE, 800);
    show(RUNNING);
    expect(box(".recbtns").top).toBeLessThan(box(".reclight").bottom);
  });

  it("puts nothing past the right edge of the page, in either state", async () => {
    await page.viewport(NARROW, 800);

    show(IDLE, "bens-best-bent-wire-grading-bug.wav");
    expect(overflowing()).toEqual([]);

    show(RUNNING);
    expect(overflowing()).toEqual([]);
  });
});
