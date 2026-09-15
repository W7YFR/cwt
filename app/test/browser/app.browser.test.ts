/* The whole app, mounted in a real browser.
 *
 * The one test that exercises every layer at once: a session comes back out of
 * storage, React mounts, the canvas rasterizes, the grading runs, and the
 * report comes out. Everything below has a sharper test somewhere else — this
 * is the one that would catch them being wired together wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, BOOT_MESSAGE_DELAY_MS } from "@/ui/App";
import { loadPrefs, recallTake, rememberTake } from "@/io/storage";
import { encodeWavBuffer } from "@/audio/wav";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { caseNamed, takeFrom, SLOPPY } from "../fixture";
/* The real stylesheet. Layout is part of what this file checks — which row the
   filename lands on, whether the drop veil swallows the drop it advertises —
   and without it those assertions pass on the unstyled defaults instead. */
import "@/ui/base.css";

const TAKE = takeFrom(caseNamed(SLOPPY));

/** Leave a recording where the app looks for one.
 *
 * The same place a previous visit would have left it, which is the only way in
 * there now — so the delivery under test is the delivery that exists. */
async function served(take = TAKE) {
  const audio = encodeWavBuffer(
    synthesize("CQ DE W7YFR", targetTiming(25, 25), { rate: 8000 }).samples,
    8000,
  );
  await rememberTake({ take, audio: new Blob([audio]) });
}

/** Hold the boot open, and let it go on demand.
 *
 * The boot's async work is one database read, so stalling the database is what
 * stops it finishing. Two wrinkles make that less direct than it sounds: the
 * open is cached behind a module-level promise, and a failed open is the only
 * thing that clears it — so this deliberately fails one open first to empty
 * that cache, and only then installs the handle that never answers.
 *
 * Released as a failure too: what is under test is the gate in front of the
 * page, not what comes through it. */
async function heldStorage(): Promise<() => void> {
  const real = globalThis.indexedDB;
  const put = (value: unknown) =>
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value });

  put({
    open: () => {
      const r: { onerror?: (() => void) | null } = {};
      setTimeout(() => r.onerror?.(), 0);
      return r;
    },
  });
  await recallTake();

  const held: { onerror?: (() => void) | null } = {};
  put({ open: () => held });
  return () => {
    put(real);
    held.onerror?.();
  };
}

/** Drive a range input the way React's synthetic onChange expects. */
function setRange(el: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  /* React refuses to run act() outside an environment that has opted in, and
     without the flag nothing renders at all — which reads as every assertion
     failing against an empty page rather than as a setup problem.

     Mounted through react-dom directly rather than through Testing Library:
     under the browser runner the library is pre-bundled with its own copy of
     React, and hooks called against a second copy fail with a null internals
     object. The DOM tier uses the library and is the right place for anything
     that wants its queries; this one only needs a root. */
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  container.remove();
  /* Remembering a take is fire-and-forget: it awaits IndexedDB and only then
     notes the id in the preferences. Clearing straight away leaves that write
     in flight, and it lands in the middle of the next test — which then opens
     on a recording it never loaded. */
  await new Promise((res) => setTimeout(res, 30));
  localStorage.clear();
});

/** A drag carrying files, the way a browser reports one. */
function drag(type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [], dropEffect: "" },
  });
  window.dispatchEvent(event);
  return event;
}

/** Drop a real, decodable recording on the window. */
async function drop(name: string) {
  const wav = encodeWavBuffer(
    synthesize("TEST", targetTiming(20, 20), { rate: 8000 }).samples,
    8000,
  );
  const file = new File([wav], name, { type: "audio/wav" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [file], dropEffect: "" },
  });
  await act(async () => {
    window.dispatchEvent(event);
    await new Promise((res) => setTimeout(res, 300));
  });
}

async function mount() {
  root = createRoot(container);
  const r = root;
  await act(async () => {
    r.render(createElement(App));
  });
  // Let the database read and the effects that follow it settle.
  await act(async () => {
    await new Promise((res) => setTimeout(res, 40));
  });
}

describe("the app", () => {
  it("shows the landing screen when nothing was handed to it", async () => {
    await mount();
    expect(container.textContent).toContain("Start recording");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("says nothing at all while a quick boot happens", async () => {
    /* The boot has to hold the page — otherwise the landing screen paints and
       is immediately replaced by a remembered review. But the work is a 404
       and one database read, and a word on screen for forty milliseconds is
       not information, it is the flicker you see on every reload.

       Held open by hand rather than raced against: `act` flushes the whole
       boot, so rendering and then looking is looking at the finished page. The
       only way to see the gate is to stop it from finishing. */
    localStorage.setItem("cwt:prefs", JSON.stringify({ currentId: "held" }));
    const release = await heldStorage();

    root = createRoot(container);
    const r = root;
    await act(async () => {
      r.render(createElement(App));
    });

    // Mid-boot: the gate is up, and it is saying nothing.
    expect(container.querySelector(".busy")).not.toBeNull();
    expect(container.textContent).not.toMatch(/loading|looking/i);
    expect(container.textContent).not.toContain("Start recording");

    // Finish well inside the delay, the way a real boot does.
    await act(async () => {
      release();
      await new Promise((res) => setTimeout(res, 80));
    });
    expect(container.textContent).toContain("Start recording");
    expect(container.textContent).not.toMatch(/loading|looking/i);
  });

  it("does explain itself when the boot is genuinely slow", async () => {
    // The message still has a job: a long recording coming back off disk.
    // Several seconds of silence would look broken.
    localStorage.setItem("cwt:prefs", JSON.stringify({ currentId: "held" }));
    const release = await heldStorage();

    root = createRoot(container);
    const r = root;
    await act(async () => {
      r.render(createElement(App));
    });
    expect(container.textContent).not.toMatch(/looking/i);

    await act(async () => {
      await new Promise((res) => setTimeout(res, BOOT_MESSAGE_DELAY_MS + 150));
    });
    expect(container.textContent).toMatch(/looking for your last session/i);
    // And it is still a gate: the landing screen has not been let through.
    expect(container.textContent).not.toContain("Start recording");
    await act(async () => {
      release();
      await new Promise((res) => setTimeout(res, 20));
    });
  });

  it("opens on the recording it was left with", async () => {
    await served();
    await mount();

    // The header, the chart, and the report — the three things that together
    // mean the whole pipeline ran.
    expect(container.querySelector(".brandmark")).not.toBeNull();
    expect(container.textContent).toContain("consistent");
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.textContent).toContain("Element & spacing");
  });

  it("actually rasterizes the chart, rather than leaving a blank canvas", async () => {
    await served();
    await mount();
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBeGreaterThan(0);
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit++;
    expect(lit).toBeGreaterThan(1000);
  });

  it("grades the handed-over recording rather than re-deriving it", async () => {
    await served();
    await mount();
    // The decoded text on screen comes from the segments in the bundle. If the
    // app had re-run its own DSP on the audio (which is a synthesized
    // placeholder here, not the real recording) it would say something else.
    expect(container.textContent).toContain(TAKE.source);
  });

  it("gets you home from the name in the header", async () => {
    // The wordmark is the whole of the way back: without it the review is a
    // dead end, and a second control for the same job is one too many.
    await served();
    await mount();
    expect(container.textContent).not.toMatch(/start over/i);
    const brand = container.querySelector<HTMLButtonElement>(".brandmark")!;
    expect(brand.tagName).toBe("BUTTON"); // reachable from a keyboard, not just a mouse
    // The header draws the name rather than spelling it, and at 26 pixels tall
    // some of the drawings are not readable as letters at all — so the button
    // has to carry the name itself or it is an unlabeled control.
    expect(brand.getAttribute("aria-label")).toBe("CWT");
    expect(brand.querySelector(".art")).not.toBeNull();
    await act(async () => {
      brand.click();
    });
    expect(container.textContent).toContain("Start recording");
  });

  it("does not waste header room saying the recording came from a microphone", async () => {
    // A filename earns its place up there. "microphone" is the same word every
    // time and is already implied by the fact that you just recorded.
    await served({ ...TAKE, source: "microphone" });
    await mount();
    expect(container.querySelector("header")!.textContent).not.toMatch(/microphone/i);
    // Still a review, and still able to name the take for a download.
    expect(container.textContent).toContain("consistent");

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    // A file keeps its name, which is the case the header is for.
    await served();
    await mount();
    expect(container.querySelector("header")!.textContent).toContain(TAKE.source);
  });

  it("takes a dropped recording on the review page, not just the landing one", async () => {
    // Having looked at one take, dragging the next one on is the obvious move
    // — and it should not mean clicking back to the landing screen first.
    await served();
    await mount();
    expect(container.querySelector("canvas")).not.toBeNull();

    await act(async () => {
      drag("dragenter");
    });
    // The whole page invites it, rather than a rectangle to aim at.
    const veil = document.querySelector<HTMLElement>(".dropveil");
    expect(veil).not.toBeNull();
    // And the invitation must not swallow the drop it is advertising.
    expect(getComputedStyle(veil!).pointerEvents).toBe("none");

    expect(drag("dragover").defaultPrevented).toBe(true);

    await act(async () => {
      drag("dragleave");
    });
    expect(document.querySelector(".dropveil")).toBeNull();
  });

  it("ignores a file dropped onto a session that already has attempts", async () => {
    /* A recording carries its own speed, and only the attempt that starts a
       session gets to set one — so a file can begin a session but never join
       one. The drag itself is left alone: the page still invites the drop,
       because turning the invitation off would be a second rule to notice for
       a gesture that costs nothing to repeat after clearing. */
    await served();
    await mount();
    const before = container.textContent ?? "";
    expect(before).toContain(TAKE.source);

    /* And the invitation says so while the file is still in the air. Promising
       to open it and then quietly doing nothing is the worse half of both
       options — it looks broken rather than closed. */
    await act(async () => {
      drag("dragenter");
    });
    const veil = document.querySelector<HTMLElement>(".dropveil")!;
    expect(veil.dataset.accepts).toBe("false");
    expect(veil.textContent).toMatch(/speed|clear|new session/i);
    await act(async () => {
      drag("dragleave");
    });

    await drop("dropped.wav");
    expect(container.textContent).toContain(TAKE.source);
    expect(container.textContent).not.toContain("dropped.wav");
    // Ignored, not failed: no error banner for a gesture that simply does not
    // apply here.
    expect(container.querySelector(".banner.error")).toBeNull();

    // And accepted once there is no session for it to contradict — the
    // invitation goes back to inviting.
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='clear-take']")!.click(),
    );
    await act(async () => {
      drag("dragenter");
    });
    expect(document.querySelector<HTMLElement>(".dropveil")!.dataset.accepts).toBe("true");
    await act(async () => {
      drag("dragleave");
    });

    await drop("dropped.wav");
    expect(container.textContent).toContain("dropped.wav");
  });

  it("puts a long filename on a row of its own", async () => {
    /* Beside the brand, a name pushed the record controls along by however
       long it happened to be. Nothing above it can move now, whatever it is
       called. */
    const long = "cq-de-w7-long-filename-what-do-you-do-oh-dear-oh-dear.wav";
    await served({ ...TAKE, source: long });
    await mount();

    const src = container.querySelector<HTMLElement>(".src")!;
    const header = container.querySelector<HTMLElement>("header")!;
    expect(src.textContent).toBe(long);

    const brand = container.querySelector<HTMLElement>(".brand")!.getBoundingClientRect();
    const bar = container.querySelector<HTMLElement>(".recordbar")!.getBoundingClientRect();
    // Below everything, not beside anything.
    expect(src.getBoundingClientRect().top).toBeGreaterThanOrEqual(brand.bottom - 1);
    expect(src.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.bottom - 1);

    // Below the brand in the document too, not merely pushed under it.
    expect(header.lastElementChild).toBe(src);

    // And the record controls sit where they would with no name at all.
    const withName = bar.left;

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    await served({ ...TAKE, source: "a.wav" });
    await mount();
    const short = container.querySelector<HTMLElement>(".recordbar")!.getBoundingClientRect();
    expect(short.left).toBeCloseTo(withName, 1);
  });

  it("puts the scores on a row of their own, left-aligned", async () => {
    /* They used to be pushed to the right of the top row, which worked when
       that row held a brand and a record button. It now also holds a device
       picker, a calibration picker and a cog, and the numbers landed wherever
       those left room — a different place on every screen, which is the one
       thing a row of figures read at a glance must not do. */
    await served();
    await mount();

    const band = container.querySelector<HTMLElement>(".scoresrow")!;
    const scores = container.querySelector<HTMLElement>(".scores")!;
    const bar = container.querySelector<HTMLElement>(".recordbar")!;

    // Below the controls, not beside them.
    expect(band.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      bar.getBoundingClientRect().bottom - 1,
    );
    // And starting at the same left edge as everything else above it.
    const brand = container.querySelector<HTMLElement>(".brand")!.getBoundingClientRect();
    expect(scores.getBoundingClientRect().left).toBeCloseTo(brand.left, 0);

    /* Centered in its own band. In the header they were not: the line above
       set the padding and the figures took whatever was left, which put them
       a few pixels high. */
    const outer = band.getBoundingClientRect();
    const inner = scores.getBoundingClientRect();
    // Against the interior: the rule under the band is part of its border box
    // and would count as a pixel of space that is not space.
    const rule = parseFloat(getComputedStyle(band).borderBottomWidth) || 0;
    expect(inner.top - outer.top).toBeCloseTo(outer.bottom - rule - inner.bottom, 0);
  });

  it("has the same way into configuration from either screen", async () => {
    /* A control that moves between screens is one somebody has to look for
       twice, so it is the same component in the same place on both. */
    await served();
    await mount();
    const onReview = container
      .querySelector<HTMLElement>("[data-testid='cog']")!
      .getBoundingClientRect();

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    await mount();
    const onLanding = container
      .querySelector<HTMLElement>("[data-testid='cog']")!
      .getBoundingClientRect();

    expect(onLanding.top).toBeCloseTo(onReview.top, 0);
    expect(onLanding.right).toBeCloseTo(onReview.right, 0);
  });

  it("signs every screen", async () => {
    // Read at render, not baked in at build time, so a page left open over
    // New Year does not claim last year's copyright.
    await served();
    await mount();
    const foot = container.querySelector<HTMLElement>(".colophon")!;
    expect(foot.textContent).toContain(String(new Date().getFullYear()));
    expect(foot.textContent).toContain("W7YFR");
  });

  it("lines up every control in the settings rows", async () => {
    /* A select, a slider, a checkbox, a text box and a row of buttons all have
       different natural heights, and a row that mixes them ends up with
       everything at a slightly different level and nothing to blame it on.
       Two bands per group — caption above, control below — is what puts them
       on one center line.

       Checked per wrapped line rather than across the whole row: these rows
       wrap, and two groups that have wrapped onto different lines are supposed
       to be at different heights. */
    await served();
    await mount();

    /** The middle of a group's control band — its last child, which is the
     *  control itself, or the label when the label IS the control. */
    const controlMid = (group: HTMLElement) => {
      const el = (group.querySelector<HTMLElement>(":scope > label.check, :scope > label.field") ??
        group.lastElementChild) as HTMLElement;
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };

    for (const row of [".controls", ".viewcontrols"]) {
      const groups = [...container.querySelectorAll<HTMLElement>(`${row} > .group`)];
      expect(groups.length, row).toBeGreaterThan(2);

      const lines = new Map<number, number[]>();
      for (const g of groups) {
        const line = Math.round(g.getBoundingClientRect().top);
        const mids = lines.get(line) ?? [];
        mids.push(controlMid(g));
        lines.set(line, mids);
      }
      for (const [line, mids] of lines) {
        const spread = Math.max(...mids) - Math.min(...mids);
        expect(spread, `${row} line ${line} spread ${spread.toFixed(1)}px`).toBeLessThanOrEqual(1);
      }
    }

    // The header's own row, where the controls are smaller but the rule is the
    // same one.
    const bar = [...container.querySelectorAll<HTMLElement>(".recordbar > *")].map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    expect(bar.length).toBeGreaterThan(1);
    expect(Math.max(...bar) - Math.min(...bar)).toBeLessThanOrEqual(1);
  });

  it("gives a banner a band of its own height, not of its words", async () => {
    /* A strip that arrives without warning over a page somebody is already
       reading. Sized to its own words it is a different height every time, so
       the page jumps by some unpredictable amount as it lands — and by a
       different amount for a short message than for a long one. It is the same
       band the header is built from. */
    await served();
    await mount();

    const band = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--band-h"),
    );
    expect(band).toBeGreaterThan(0);

    const heights = ["ok", "I could not hear any CW in this recording."].map((text) => {
      const el = document.createElement("p");
      el.className = "banner error";
      el.textContent = text;
      container.prepend(el);
      const h = el.getBoundingClientRect().height;
      el.remove();
      return h;
    });
    expect(heights[0]).toBeCloseTo(band, 0);
    expect(heights[1]).toBeCloseTo(band, 0);
  });

  it("says how long the target runs at the speeds now set", async () => {
    /* The same fact as the speed readings beside it, in the form somebody can
       feel: "yours runs eleven seconds where the target runs nine". It has to
       follow the sliders, because the target is rendered from them — a figure
       that stayed put while the speed changed would be describing a different
       target from the one on the chart. */
    await served();
    await mount();

    const shown = () =>
      container.querySelector<HTMLElement>("[data-testid='target-duration']")!.textContent;
    const before = shown();
    expect(before).toMatch(/^\d+\.\d+s$/);

    const wpm = container.querySelector<HTMLInputElement>("#wpm")!;
    await act(async () => {
      setRange(wpm, Number(wpm.value) - 5);
    });
    // Slower sending, a longer target.
    expect(parseFloat(shown()!)).toBeGreaterThan(parseFloat(before!));
  });

  it("carries a corrected intended message into the next recording", async () => {
    /* It is not a property of the take on screen — it is what you are
       practicing, and it outlives every attempt at it. Edited on the review it
       used to change only that review, so the next recording was graded
       against whatever the page had loaded with and the correction you had
       just made was thrown away. */
    await served();
    await mount();

    const box = container.querySelector<HTMLInputElement>("#expected")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(box, "CQ TEST DE W7YFR");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(box.value).toBe("CQ TEST DE W7YFR");
    // Kept where the next recording reads it from, not only in this view.
    await new Promise((res) => setTimeout(res, 20));
    expect(loadPrefs().expected).toBe("CQ TEST DE W7YFR");
  });

  it("sits the clear adornment on the field's center line", async () => {
    /* Real layout, because that is the only place this can go wrong: the
       button is out of flow inside the box, so nothing in the markup says
       where it lands. Measured rather than eyeballed — riding a few pixels
       high is exactly the kind of thing that survives a screenshot. */
    await served();
    await mount();

    const box = container.querySelector<HTMLInputElement>("#expected")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(box, "CQ TEST DE W7YFR");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const button = container.querySelector<HTMLElement>("[data-testid='clear-expected']")!;
    const field = box.getBoundingClientRect();
    const glyph = button.querySelector("svg")!.getBoundingClientRect();
    const mid = (r: DOMRect) => r.top + r.height / 2;
    expect(Math.abs(mid(glyph) - mid(field))).toBeLessThanOrEqual(1);
    // And inside the box's right edge rather than over or past it.
    expect(glyph.right).toBeLessThan(field.right);
    expect(glyph.left).toBeGreaterThan(field.left);
  });

  describe("clearing the recording", () => {
    /* The loop this is for: set the message and the speeds, hear the target,
       send it, look at how it went, wipe it, send it again. Wiping keeps the
       session — what you are practicing — and drops only what was recorded
       into it. */
    const clear = () =>
      container.querySelector<HTMLElement>("[data-testid='clear-take']")!;

    it("keeps the target and drops the grading", async () => {
      await served();
      await mount();
      const before = container.querySelector<HTMLInputElement>("#expected")!.value;
      expect(container.querySelector("[data-testid='scores']")!.getAttribute("data-blank"))
        .toBe("false");

      await act(async () => clear().click());

      // Still here, still set up, with nothing recorded in it.
      expect(container.querySelector("header")).not.toBeNull();
      expect(container.querySelector<HTMLInputElement>("#expected")!.value).toBe(before);
      expect(container.querySelector("[data-testid='scores']")!.getAttribute("data-blank"))
        .toBe("true");
      expect(container.querySelector("[data-testid='report-blank']")).not.toBeNull();
    });

    it("still draws the target, which is the point of staying", async () => {
      /* The target half needs no recording — a message and a pair of speeds
         are enough to render what you are about to send. If it went blank too
         there would be nothing to practice against. */
      await served();
      await mount();
      await act(async () => clear().click());

      const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) lit++;
      expect(lit).toBeGreaterThan(100);
    });

    it("offers nothing that would act on a recording that is not there", async () => {
      await served();
      await mount();
      await act(async () => clear().click());

      // Matched on the accessible name as well as the text, since some of
      // these are icons.
      const named = (re: RegExp) =>
        [...container.querySelectorAll("button")].find((b) =>
          re.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
        )!;
      expect(named(/your sending/i).disabled, "play yours").toBe(true);
      expect(named(/your audio/i).disabled, "download yours").toBe(true);
      expect(named(/json report/i).disabled, "json").toBe(true);
      // And nothing left to clear.
      expect(container.querySelector("[data-testid='clear-take']")).toBeNull();

      // What still works is everything about the target.
      expect(named(/target$/i).disabled, "play target").toBe(false);
      expect(named(/record another/i).disabled, "record").toBe(false);
      // And opening a file, which is exactly when it is allowed: a cleared
      // session has no speed of its own for a recording to contradict.
      expect(named(/open a recording/i).disabled, "open a file").toBe(false);
    });
  });

  it("starts a practice from a cold start, with the message it was given", async () => {
    /* The loop begins before there is any recording: say what you are going to
       send, hear the target, set the pace, then key it. Reachable only through
       Clear, that first step would have required recording something blind in
       order to get to the screen that stops you recording blind. */
    localStorage.setItem(
      "cwt:prefs",
      JSON.stringify({ expected: "CQ DE W7YFR" }),
    );
    await mount();

    const go = container.querySelector<HTMLButtonElement>("[data-testid='practice']")!;
    expect(go.disabled).toBe(false);
    await act(async () => go.click());

    // On the review, set up, with nothing recorded in it.
    expect(container.querySelector("header")).not.toBeNull();
    expect(container.querySelector("[data-testid='scores']")!.getAttribute("data-blank"))
      .toBe("true");
    expect(container.querySelector<HTMLInputElement>("#expected")!.value).toBe(
      "CQ DE W7YFR",
    );
    // And a real target to practice against, not an empty one.
    expect(
      parseFloat(
        container.querySelector("[data-testid='target-duration']")!.textContent!,
      ),
    ).toBeGreaterThan(0);
  });

  it("offers a recording control on the review itself", async () => {
    // Having just seen where the spacing drifted, the next thing you want is
    // another go — without losing the speeds and tolerance you just set.
    await served();
    await mount();
    const bar = container.querySelector(".recordbar")!;
    // By name rather than by text: it is an icon, and the name is what it is
    // called for anyone who cannot see one.
    const named = Array.from(bar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent ?? "",
    );
    expect(named.some((n) => /record/i.test(n))).toBe(true);
    // And a way to open a recording, so the two ways in are not asymmetric —
    // dropping a file on the page says nothing about itself until you are
    // already dragging one.
    expect(named.some((n) => /open a recording/i.test(n))).toBe(true);
  });

  it("comes back to the same recording after a reload", async () => {
    // A refresh must not drop a take you just spent thirty seconds keying. The
    // Storage is only how it gets *in* here; what is under test is that it
    // was kept.
    await served();
    await mount();

    // The write is fire-and-forget, so wait for it rather than assuming it
    // beat the assertion.
    for (let i = 0; i < 100 && !(await recallTake()); i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(await recallTake()).not.toBeNull();

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    // Second visit: no bundle this time, the way an ordinary reload of the
    // deployed app would find it.
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await mount();

    expect(container.textContent).toContain(TAKE.source);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.textContent).not.toContain("Start recording");
  });

  it("stays on the landing screen after you deliberately start over", async () => {
    // Leaving the review is a decision, and a reload should not undo it.
    await served();
    await mount();
    for (let i = 0; i < 100 && !(await recallTake()); i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".brandmark")!.click();
    });

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await mount();
    expect(container.textContent).toContain("Start recording");
  });

  it("makes a closed upload look closed, not merely quiet", async () => {
    /* One glyph dims far less convincingly than a phrase does, so the shared
       disabled opacity was not enough to read as off — it looked like a button
       that happened to be understated. */
    await served();
    await mount();
    const open = container.querySelector<HTMLButtonElement>("[data-testid='open-file']")!;
    expect(open.disabled).toBe(true);
    /* Copied out, not held: getComputedStyle returns a LIVE declaration, and
       React flips `disabled` on the same node — so a reference read after the
       click reports the state after the click, and the two snapshots compare
       equal however different they looked. */
    const look = (el: Element) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, ink: c.color, cursor: c.cursor };
    };
    const off = look(open);

    // Against the same control when it is available.
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='clear-take']")!.click(),
    );
    const on = look(container.querySelector("[data-testid='open-file']")!);

    expect(off.bg).not.toBe(on.bg);
    expect(off.ink).not.toBe(on.ink);
    // And the pointer says so before the tooltip has to.
    expect(off.cursor).toBe("not-allowed");
  });
});
