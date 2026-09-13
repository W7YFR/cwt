/* The whole app, mounted in a real browser.
 *
 * The one test that exercises every layer at once: a bundle arrives the way
 * `cw-decode --web-review` sends one, React mounts, the canvas rasterizes, the
 * grading runs, and the report comes out. Everything below has a sharper test
 * somewhere else — this is the one that would catch them being wired together
 * wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, BOOT_MESSAGE_DELAY_MS } from "@/ui/App";
import { BUNDLE_PATH, BUNDLE_VERSION, loadBundle } from "@/io/bundle";
import { recallTake } from "@/io/storage";
import { encodeWavBuffer } from "@/audio/wav";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { caseNamed, takeFrom, SLOPPY } from "../fixture";
/* The real stylesheet. Layout is part of what this file checks — which row the
   filename lands on, whether the drop veil swallows the drop it advertises —
   and without it those assertions pass on the unstyled defaults instead. */
import "@/ui/base.css";

const TAKE = takeFrom(caseNamed(SLOPPY));

/** A bundle served the way the CLI serves one. */
function bundleFetch(overrides: Record<string, unknown> = {}) {
  const audio = encodeWavBuffer(
    synthesize("CQ DE W7YFR", targetTiming(25, 25), { rate: 8000 }).samples,
    8000,
  );
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(BUNDLE_PATH)) {
      return new Response(
        JSON.stringify({
          version: BUNDLE_VERSION,
          audioUrl: "audio.wav",
          take: TAKE,
          ...overrides,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("audio.wav")) {
      return new Response(audio, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

let container: HTMLDivElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;

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
  globalThis.fetch = realFetch;
  /* Remembering a take is fire-and-forget: it awaits IndexedDB and only then
     notes the id in the preferences. Clearing straight away leaves that write
     in flight, and it lands in the middle of the next test — which then opens
     on a recording it never loaded. */
  await new Promise((res) => setTimeout(res, 30));
  localStorage.clear();
});

async function mount() {
  root = createRoot(container);
  const r = root;
  await act(async () => {
    r.render(createElement(App));
  });
  // Let the bundle fetch and the effects that follow it settle.
  await act(async () => {
    await new Promise((res) => setTimeout(res, 40));
  });
}

describe("the app", () => {
  it("shows the landing screen when nothing was handed to it", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
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
    let release!: (r: Response) => void;
    const held = new Promise<Response>((res) => {
      release = res;
    });
    globalThis.fetch = vi.fn(() => held) as unknown as typeof fetch;

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
      release(new Response("", { status: 404 }));
      await new Promise((res) => setTimeout(res, 80));
    });
    expect(container.textContent).toContain("Start recording");
    expect(container.textContent).not.toMatch(/loading|looking/i);
  });

  it("does explain itself when the boot is genuinely slow", async () => {
    // The message still has a job: a slow network, or a long recording coming
    // back off disk. Several seconds of silence would look broken.
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;

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
  });

  it("shows no error at all under a dev server's single-page fallback", async () => {
    // What `npm run dev` actually serves for a path that does not exist.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<!doctype html><html lang=\"en\"></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await mount();
    expect(container.textContent).toContain("Start recording");
    expect(container.textContent).not.toMatch(/not readable|cannot read/i);
    expect(container.querySelector(".banner.error")).toBeNull();
  });

  it("goes straight to the review when a bundle is served beside it", async () => {
    globalThis.fetch = bundleFetch();
    await mount();

    // The header, the chart, and the report — the three things that together
    // mean the whole pipeline ran.
    expect(container.querySelector(".brandmark")).not.toBeNull();
    expect(container.textContent).toContain("consistent");
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.textContent).toContain("Element & spacing");
  });

  it("actually rasterizes the chart, rather than leaving a blank canvas", async () => {
    globalThis.fetch = bundleFetch();
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
    globalThis.fetch = bundleFetch();
    await mount();
    // The decoded text on screen comes from the segments in the bundle. If the
    // app had re-run its own DSP on the audio (which is a synthesized
    // placeholder here, not the real recording) it would say something else.
    expect(container.textContent).toContain(TAKE.source);
  });

  it("gets you home from the name in the header", async () => {
    // The wordmark is the whole of the way back: without it the review is a
    // dead end, and a second control for the same job is one too many.
    globalThis.fetch = bundleFetch();
    await mount();
    expect(container.textContent).not.toMatch(/start over/i);
    const brand = container.querySelector<HTMLButtonElement>(".brandmark")!;
    expect(brand.tagName).toBe("BUTTON"); // reachable from a keyboard, not just a mouse
    // The header draws the name rather than spelling it, and at 26 pixels tall
    // some of the drawings are not readable as letters at all — so the button
    // has to carry the name itself or it is an unlabelled control.
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
    globalThis.fetch = bundleFetch({ take: { ...TAKE, source: "microphone" } });
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
    globalThis.fetch = bundleFetch();
    await mount();
    expect(container.querySelector("header")!.textContent).toContain(TAKE.source);
  });

  it("takes a dropped recording on the review page, not just the landing one", async () => {
    // Having looked at one take, dragging the next one on is the obvious move
    // — and it should not mean clicking back to the landing screen first.
    globalThis.fetch = bundleFetch();
    await mount();
    expect(container.querySelector("canvas")).not.toBeNull();

    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [], dropEffect: "" },
      });
      window.dispatchEvent(event);
      return event;
    };

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

  it("puts a long filename on a row of its own", async () => {
    /* Beside the brand, a name pushed the record controls along by however
       long it happened to be. Nothing above it can move now, whatever it is
       called. */
    const long = "cq-de-w7-long-filename-what-do-you-do-oh-dear-oh-dear.wav";
    globalThis.fetch = bundleFetch({ take: { ...TAKE, source: long } });
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

    globalThis.fetch = bundleFetch({ take: { ...TAKE, source: "a.wav" } });
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
    globalThis.fetch = bundleFetch();
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

    /* Centred in its own band. In the header they were not: the line above
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
    globalThis.fetch = bundleFetch();
    await mount();
    const onReview = container
      .querySelector<HTMLElement>("[data-testid='cog']")!
      .getBoundingClientRect();

    act(() => root!.unmount());
    root = null;
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);

    globalThis.fetch = bundleFetch({ take: null });
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
    globalThis.fetch = bundleFetch();
    await mount();
    const foot = container.querySelector<HTMLElement>(".colophon")!;
    expect(foot.textContent).toContain(String(new Date().getFullYear()));
    expect(foot.textContent).toContain("W7YFR");
  });

  it("offers a recording control on the review itself", async () => {
    // Having just seen where the spacing drifted, the next thing you want is
    // another go — without losing the speeds and tolerance you just set.
    globalThis.fetch = bundleFetch();
    await mount();
    const record = container.querySelector(".recordbar")!;
    expect(record.textContent).toMatch(/Record another/i);
  });

  it("comes back to the same recording after a reload", async () => {
    // A refresh must not drop a take you just spent thirty seconds keying. The
    // bundle path is only how it gets *in* here; what is under test is that it
    // was kept.
    globalThis.fetch = bundleFetch();
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
    globalThis.fetch = bundleFetch();
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

  it("says so when the bundle is from a newer version than it understands", async () => {
    globalThis.fetch = bundleFetch({ version: BUNDLE_VERSION + 5 });
    await mount();
    expect(container.textContent).toMatch(/newer version/i);
    // And still offers a way forward rather than only an error.
    expect(container.textContent).toContain("Start recording");
  });

  it("says so when the bundle is not a recording at all", async () => {
    globalThis.fetch = bundleFetch({ take: { nonsense: true } });
    await mount();
    expect(container.textContent).toMatch(/cannot read|does not contain/i);
  });
});

describe("loading a bundle", () => {
  it("treats a missing bundle as 'nothing to load', not an error", async () => {
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    await expect(
      loadBundle(BUNDLE_PATH, missing as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("treats a single-page fallback as 'nothing to load' too", async () => {
    // A dev server answers an unknown path with index.html and a 200, because
    // in a single-page app an unknown path is a route rather than a missing
    // file. Parsing that as JSON reports a corrupt bundle at the top of the
    // page on every `npm run dev`.
    const fallback = vi.fn(
      async () =>
        new Response("<!doctype html>\n<html lang=\"en\">", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(
      loadBundle(BUNDLE_PATH, fallback as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("recognizes the fallback even with no useful content type", async () => {
    const bare = vi.fn(
      async () => new Response("<!DOCTYPE html><html></html>", { status: 200 }),
    );
    await expect(
      loadBundle(BUNDLE_PATH, bare as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("still complains about a bundle that is genuinely corrupt", async () => {
    // The distinction has to cut both ways: somebody meant to hand us this
    // one, so silence would be the wrong answer.
    const broken = vi.fn(
      async () =>
        new Response("{ take: nope", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      loadBundle(BUNDLE_PATH, broken as unknown as typeof fetch),
    ).rejects.toThrow(/not readable JSON/);
  });

  it("treats a blocked fetch as 'nothing to load' too", async () => {
    // A file:// page cannot fetch at all. That is the ordinary way to open the
    // deployed app, so it must not read as a failure.
    const blocked = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      loadBundle(BUNDLE_PATH, blocked as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("resolves the audio against the bundle, not the site root", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("take.json")) {
        return new Response(
          JSON.stringify({ version: 1, audioUrl: "audio.wav", take: TAKE }),
        );
      }
      return new Response(new ArrayBuffer(8));
    });
    await loadBundle("sessions/today/take.json", fetcher as unknown as typeof fetch);
    // A bundle in a subdirectory has to find its own audio beside itself.
    expect(seen.some((u) => u.includes("sessions/today/audio.wav"))).toBe(true);
  });
});
