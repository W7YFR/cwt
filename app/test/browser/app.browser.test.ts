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

/** Answer the microphone permission query with a state we control.
 *
 * Real Chromium answers "prompt" here, and the case worth testing is the one
 * that cannot be reached by asking nicely: permission refused in the browser's
 * own settings, before this page ever opened. */
function permission(state: string) {
  const target = new EventTarget() as EventTarget & { state: string };
  target.state = state;
  const real = Object.getOwnPropertyDescriptor(navigator, "permissions");
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => target },
  });
  return {
    /** The browser changing its mind while the page stays open, which is what
     *  happens when you go and fix it in site settings and come back. */
    becomes: async (next: string) => {
      target.state = next;
      await act(async () => {
        target.dispatchEvent(new Event("change"));
      });
    },
    restore: () => {
      if (real) Object.defineProperty(navigator, "permissions", real);
      else delete (navigator as { permissions?: unknown }).permissions;
    },
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

  it("says so when the browser will not let it near a microphone", async () => {
    /* The symptom is silence. Every picker that offers a choice correctly
       declines to offer one when there is nothing to pick, so the page ends up
       with no controls and nothing saying why — which reads as the app being
       broken rather than as a permission to change.

       And it clears itself: the fix happens in the browser's settings, off
       this page, and coming back to a page still claiming to be blocked would
       be the same lie in the other direction. */
    const perm = permission("denied");
    try {
      await mount();
      const banner = container.querySelector("[data-testid='mic-blocked']");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toMatch(/microphone/i);

      await perm.becomes("granted");
      expect(container.querySelector("[data-testid='mic-blocked']")).toBeNull();
    } finally {
      perm.restore();
    }
  });

  it("says nothing about permission it has not been refused", async () => {
    const perm = permission("prompt");
    try {
      await mount();
      expect(container.querySelector("[data-testid='mic-blocked']")).toBeNull();
    } finally {
      perm.restore();
    }
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

    // The header, the grade and the chart — the three things that together
    // mean the whole pipeline ran. Not the grading tables: those are behind
    // Advanced grading and off unless asked for, so their absence says
    // nothing about whether the recording came back.
    expect(container.querySelector(".brandmark")).not.toBeNull();
    expect(container.textContent).toContain("consistent");
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector("[data-testid='scores']")!.getAttribute("data-blank"))
      .toBe("false");
  });

/** Tick a box in the chart settings panel, opening the panel if it is shut.
 *
 * Only if: the cog is a toggle, so opening one that is already open closes it
 * and takes the box being reached for with it. */
async function tickSetting(id: string): Promise<void> {
  const cog = () => container.querySelector<HTMLElement>("[data-testid='panel-toggle']")!;
  if (cog().getAttribute("aria-pressed") !== "true") {
    await act(async () => cog().click());
  }
  await act(async () => container.querySelector<HTMLInputElement>(`#${id}`)!.click());
}

const showDownloads = () => tickSetting("show-downloads");

  it("rolls the settings band open instead of dropping it in", async () => {
    /* It arrives between two things already on screen and pushes the chart
       down the page. Done instantly that reads as the page having jumped;
       rolled open the eye follows the chart to where it went.

       Which means the band is in the tree closed as well as open — there has
       to be something to animate from — so what is checked is that a closed
       one takes no room and cannot be reached: a panel rolled up is not a
       panel you can land on with a tab key. */
    await served();
    await mount();
    const band = () => container.querySelector<HTMLElement>(".chartsettings")!;
    const cog = () => container.querySelector<HTMLElement>("[data-testid='panel-toggle']")!;

    expect(band(), "in the tree while closed").not.toBeNull();
    expect(band().getBoundingClientRect().height, "closed").toBe(0);
    expect(band().firstElementChild!.hasAttribute("inert"), "closed").toBe(true);
    // A real transition to run, not a swap dressed up as one.
    expect(getComputedStyle(band()).transitionDuration).not.toBe("0s");

    await act(async () => cog().click());
    const atOnce = band().getBoundingClientRect().height;
    expect(band().firstElementChild!.hasAttribute("inert"), "open").toBe(false);

    await act(async () => {
      await new Promise((res) => setTimeout(res, 400));
    });
    const open = band().getBoundingClientRect().height;
    expect(open, "settles at the height of what is in it").toBeGreaterThan(0);
    // The whole claim: it was not already there when the click returned.
    expect(atOnce, "arrived rather than rolled").toBeLessThan(open);
  });

  it("shows the grading tables only when they are asked for", async () => {
    /* They are the deepest thing on the page and the slowest to read, and the
       scores band answers "how did that go" without them. Driven through the
       real control rather than through a settings object, because what is
       being checked is that the switch reaches the tables. */
    await served();
    await mount();
    const report = () => container.querySelector("[data-testid='report']");
    // On to begin with: they are the answer to "why", which is the next
    // question after a score you did not like.
    expect(report()).not.toBeNull();
    expect(report()!.textContent).toContain("Element & spacing");

    await tickSetting("advanced-grading");
    expect(report()).toBeNull();

    await tickSetting("advanced-grading");
    expect(report()).not.toBeNull();
  });

  it("takes the hints away without taking the key with them", async () => {
    /* The color key is a legend and is read every time; the two notes under it
       are instructions, and an instruction is furniture once you know it. */
    await served();
    await mount();
    const howto = () => container.querySelector(".legend.howto");
    const keys = () => container.querySelector("[data-testid='hotkeys']");
    expect(howto()).not.toBeNull();
    expect(keys()).not.toBeNull();

    await tickSetting("show-hints");
    expect(howto()).toBeNull();
    expect(keys()).toBeNull();
    // The swatches stay: that is what the colors on the chart mean.
    expect(container.querySelector(".legend .sw")).not.toBeNull();
  });

  it("says which keys work, since a key is otherwise found by pressing it", async () => {
    /* R above all: it is what you press to go again, and the review is where
       you are standing when you decide to. The other two are on the record bar
       while a take is running, but a legend that named only one key would read
       as the only one there is. */
    await served();
    await mount();
    const keys = container.querySelector("[data-testid='hotkeys']")!;
    expect([...keys.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
      "R",
      "Enter",
      "Esc",
    ]);
  });

  it("offers the downloads only when they are asked for", async () => {
    /* Getting a file out is an occasional act, and four buttons across the
       page is a standing invitation to something you do rarely. */
    await served();
    await mount();
    const row = () => container.querySelector(".downloads");
    expect(row()).toBeNull();

    await showDownloads();
    expect(row()).not.toBeNull();
    // All four, and where the rest of the page starts rather than off to the
    // right on a margin of its own.
    expect(row()!.querySelectorAll("button")).toHaveLength(4);
    const left = (el: Element) => el.getBoundingClientRect().left;
    expect(left(row()!.querySelector("button")!)).toBeLessThan(
      left(container.querySelector("canvas")!) + 40,
    );
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
    expect(src.textContent).toBe(long);

    const brand = container.querySelector<HTMLElement>(".brand")!.getBoundingClientRect();
    const bar = container.querySelector<HTMLElement>(".recordbar")!.getBoundingClientRect();
    // Below everything, not beside anything.
    expect(src.getBoundingClientRect().top).toBeGreaterThanOrEqual(brand.bottom - 1);
    expect(src.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.bottom - 1);

    /* Below the brand in the document too, not merely pushed under it. After
       the record controls rather than last in the header: the corner button is
       out of flow and sits after everything, which says nothing about where
       the name is laid out. */
    const bars = container.querySelector<HTMLElement>(".recordbar")!;
    expect(bars.compareDocumentPosition(src) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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

  it("keeps the grades and the way out of the run on one line", async () => {
    /* The band holds two grades and five measurements. Left to reflow, which
       line a figure landed on was a fact about the window rather than about
       the figure — and on a narrow one the single button among them ended up
       alone on a line of nothing else.

       Measured at a width that cannot hold the lot, because that is the only
       width where the claim means anything. */
    await served();
    await mount();
    container.style.width = "620px";
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });

    const head = container.querySelector<HTMLElement>(".scorehead")!;
    const detail = container.querySelector<HTMLElement>(".scoredetail")!;
    const drop = container.querySelector<HTMLElement>("[data-testid='drop-run']");
    const consistent = [...head.querySelectorAll<HTMLElement>(".score")].find((el) =>
      el.textContent!.includes("consistent"),
    )!;

    /* Two rows with boxes of their own, which is the whole mechanism: wrappers
       that lay their children out into the band around them would put every
       assertion below against a zero-sized rectangle and pass on nothing. */
    for (const [what, row] of [["head", head], ["rest", detail]] as const) {
      expect(getComputedStyle(row).display, `the ${what} is a row`).toBe("flex");
      expect(row.getBoundingClientRect().height, `the ${what} is a row`).toBeGreaterThan(0);
    }
    expect(detail.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      head.getBoundingClientRect().bottom - 1,
    );
    // And the window really is too narrow to have held the lot on one line.
    expect(head.scrollWidth + detail.scrollWidth).toBeGreaterThan(
      container.getBoundingClientRect().width,
    );

    /* The grades and the button share the head's line, and the button is at
       the end of it — an action among readings. */
    const line = consistent.getBoundingClientRect();
    if (drop) {
      const box = drop.getBoundingClientRect();
      expect(box.top).toBeLessThan(line.bottom);
      expect(box.right).toBeCloseTo(head.getBoundingClientRect().right, 0);
    }
    // And nothing from underneath crept up onto it.
    for (const el of detail.querySelectorAll<HTMLElement>(".score")) {
      expect(el.getBoundingClientRect().top).toBeGreaterThanOrEqual(line.bottom - 1);
    }
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

  it("reaches the corner button where the eye finds it, last in the header", async () => {
    /* The button is out of flow, so where it is drawn says nothing about where
       the keyboard finds it — only its place in the document does, and those
       two were opposite ends of the header. Tabbing onto the review page put
       you straight into chart settings, past the way home and every record
       control, with the focus ring jumping to the far corner first. */
    await served();
    await mount();

    /* Document order, which IS the order Tab walks for everything here: no
       control on the page carries a positive tabindex, and nothing sets one. */
    const reachable = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLElement>("button, select, input, a[href], [tabindex]")]
        .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);

    const cog = container.querySelector<HTMLElement>("[data-testid='panel-toggle']")!;
    const inHeader = reachable(container.querySelector<HTMLElement>("header")!);

    expect(inHeader.length, "the header has controls to come first").toBeGreaterThan(1);
    expect(inHeader.at(-1), "the corner is reached last").toBe(cog);

    // And the first stop on the page is the way home, which the corner took.
    expect(reachable(container)[0]).toBe(container.querySelector(".brandmark"));
  });

  it("ends the corner button on the page's own right margin", async () => {
    /* It is out of flow, so nothing lays it out against the things it sits
       among — and a few pixels inside or outside the margin every other row
       keeps reads as a mistake rather than as a difference. Checked against
       the drop button in the band below it, which is the nearest thing to it
       on screen and is laid out by the ordinary rules. */
    await served();
    await mount();
    const corner = container
      .querySelector<HTMLElement>("[data-testid='panel-toggle']")!
      .getBoundingClientRect();
    /* Against the scores' own content box rather than the band around it: the
       band's edge is the window, and what the corner has to line up with is
       where the content inside it ends. */
    const content = container
      .querySelector<HTMLElement>(".scoresrow .scores")!
      .getBoundingClientRect();
    expect(corner.right).toBeCloseTo(content.right, 0);
  });

  it("keeps the way out of the help in sight however long the help is", async () => {
    /* The first version let the whole sheet scroll, which put Close below the
       fold — reachable only by reading to the end of something you opened
       because you did not know what you were looking for.

       Asked structurally rather than by measuring the copy: whether this page
       happens to overflow today is a fact about how much is written on it, and
       a layout test that fails when somebody shortens a paragraph is a test
       about the paragraph. */
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='sound-path-open']")!.click();
    });

    const sheet = container.querySelector<HTMLElement>("[data-testid='sound-path']")!;
    const prose = sheet.querySelector<HTMLElement>(".prose")!;
    const close = container.querySelector<HTMLElement>("[data-testid='sound-path-close']")!;
    const title = sheet.querySelector<HTMLElement>("h2")!;

    // The reading scrolls, and it is the only thing that does.
    expect(getComputedStyle(prose).overflowY, "the reading scrolls").toBe("auto");
    expect(getComputedStyle(sheet).overflowY, "the sheet does not").not.toBe("auto");

    // The title and the way out are outside it, so neither can scroll away.
    for (const [what, el] of [["title", title], ["way out", close]] as const) {
      expect(prose.contains(el), `the ${what} is out of the scroll`).toBe(false);
      const at = el.getBoundingClientRect();
      const box = sheet.getBoundingClientRect();
      expect(at.height, `the ${what} is drawn`).toBeGreaterThan(0);
      expect(at.top, `the ${what} is inside the sheet`).toBeGreaterThanOrEqual(box.top - 1);
      expect(at.bottom, `the ${what} is inside the sheet`).toBeLessThanOrEqual(box.bottom + 1);
    }
  });

  it("asks for zen mode every sitting rather than remembering it", async () => {
    /* It is the only setting on the page that takes the page away. Remembered
       with the other aids, a box ticked days ago blanks the screen on the next
       record and nothing on screen connects the two. Every other practice aid
       is saved; this one is chosen. */
    await served();
    await mount();

    const open = () =>
      act(async () => {
        container.querySelector<HTMLButtonElement>("[data-testid='panel-toggle']")!.click();
      });
    const zen = () => container.querySelector<HTMLInputElement>("#zen-mode")!;

    await open();
    await act(async () => {
      zen().click();
    });
    expect(zen().checked, "it is on for this sitting").toBe(true);

    // Past the settings debounce, so anything that was going to be written has.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 600));
    });
    expect(Object.keys(loadPrefs()), "nothing of it is saved").not.toContain("zenMode");

    // And the next visit opens without it.
    act(() => root!.unmount());
    root = null;
    container.innerHTML = "";
    await mount();
    await open();
    expect(zen().checked, "the next visit starts off").toBe(false);
  });

  it("puts the repeat count beside the message, not under it", async () => {
    /* The message group claims a whole row by itself — it is the only control
       here whose useful width has no upper bound — so a small field after it
       spends a whole band of the page on one number. Sharing the line, it also
       has to stop where every other row stops: held to the groups' 130px
       floor, the label stretched and left a hand's width of nothing between
       the number and the edge. */
    await served();
    await mount();

    const box = container.querySelector<HTMLElement>("#expected")!.getBoundingClientRect();
    const times = container.querySelector<HTMLElement>("#times")!.getBoundingClientRect();
    const row = container.querySelector<HTMLElement>(".msgrow")!.getBoundingClientRect();

    // Beside it, on the same line.
    expect(times.left, "to the right of the message").toBeGreaterThan(box.right);
    expect(times.top).toBeLessThan(box.bottom);
    expect(times.bottom).toBeGreaterThan(box.top);

    // And nothing after it but the margin every other row keeps.
    expect(times.right).toBeCloseTo(row.right, 0);
  });

  it("signs every screen", async () => {
    // Read at render, not baked in at build time, so a page left open over
    // New Year does not claim last year's copyright.
    await served();
    await mount();
    const foot = container.querySelector<HTMLElement>(".colophon")!;
    expect(foot.textContent).toContain(String(new Date().getFullYear()));
    expect(foot.textContent).toContain("W7YFR");

    // And the call sign goes where a call sign goes, in a tab of its own so a
    // session in progress is not navigated away from.
    const sign = foot.querySelector<HTMLAnchorElement>("a")!;
    expect(sign.href).toBe("https://www.qrz.com/db/W7YFR");
    expect(sign.target).toBe("_blank");
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
      // Two is a row: with one attempt and no stack, the chart's row is the
      // axis and the zoom and nothing else.
      expect(groups.length, row).toBeGreaterThanOrEqual(2);

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
      // The download buttons are among the things being checked and are off
      // unless asked for, so ask.
      await showDownloads();
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

  it("never lands the keyboard on the file dialog itself", async () => {
    /* Both ways in are a visible button that opens a hidden <input type=file>.
       The input is clipped to a 1px box, so in the tab order it is a stop on
       nothing: no visible focus ring, nothing to read, and Enter opens a file
       dialog you did not ask for.

       Both halves are the claim. Taking it out of the tab order would be easy
       to do by hiding the whole feature from the keyboard, which is worse than
       the problem. */
    for (const [screen, opener] of [
      ["landing", ".way.drop button"],
      ["review", "[data-testid='open-file']"],
    ] as const) {
      if (screen === "review") await served();
      await mount();
      /* Opening a file is barred once a session has attempts in it, and a
         barred button cannot take focus — so clear first and ask about the
         control when it is actually on offer. */
      if (screen === "review") {
        await act(async () =>
          container.querySelector<HTMLButtonElement>("[data-testid='clear-take']")!.click(),
        );
      }

      const inputs = [...container.querySelectorAll<HTMLInputElement>("input[type=file]")];
      expect(inputs.length, `the ${screen} screen opens files`).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input.tabIndex, `the ${screen} dialog is skipped`).toBeLessThan(0);
      }

      const button = container.querySelector<HTMLButtonElement>(opener)!;
      expect(button.tabIndex, `the ${screen} button is reachable`).toBeGreaterThanOrEqual(0);
      button.focus();
      expect(document.activeElement, `the ${screen} button takes focus`).toBe(button);

      root?.unmount();
      root = null;
      container.innerHTML = "";
    }
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
