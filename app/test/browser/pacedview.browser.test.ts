/* Which chart you get while a paced recording runs.
 *
 * The two views answer different questions and only one of them is a question
 * you have while sending. Per-character packs the slots evenly so the columns
 * line up, which is what makes it worth reading afterwards and useless under a
 * cursor: the cursor moves in real time and that axis does not. On the absolute
 * axis a second of silence is a second of chart, so the cursor and the marks
 * agree.
 *
 * Here rather than in the DOM tier because this needs the real thing at both
 * ends — a canvas with a 2D context, and a recorder that actually opens. The
 * failure it exists to catch is not the decision but the wiring: `onChange` is
 * rebuilt on every render up in App, so an effect that depends on it tears
 * itself down and runs its cleanup between every pair of frames, and the two
 * views fight each other forever instead of one of them being set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewScreen } from "@/ui/ReviewScreen";
import { ROW_H, rowsFor } from "@/render/geometry";
import { defaultSettings, reviewTake } from "@/timing";
import { blankTake } from "@/io/take";
import type { ReviewSettings } from "@/types";
import "@/ui/base.css";

/** A real MediaStream with a real audio track, made without a microphone.
 *
 * The recorder opens a device, adds a worklet and pulls samples through it —
 * all of which work on a stream from an audio context, and none of which work
 * against an object shaped like one. */
function fakeMic(): () => void {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.connect(dest);
  osc.start();
  const was = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = () => Promise.resolve(dest.stream);
  return () => {
    navigator.mediaDevices.getUserMedia = was;
    osc.stop();
    void ctx.close();
  };
}

let host: HTMLDivElement;
let root: Root;
let restoreMic: () => void;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  restoreMic = fakeMic();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restoreMic();
});

/** The review screen, driven the way App drives it.
 *
 * A real component holding the settings in state, and an `onChange` written
 * inline so it is a brand new function on every render — which is what App
 * does, and the whole reason the effect under test holds it in a ref.
 *
 * Driving it by calling `root.render` from a callback instead would not do:
 * nested inside `act`, those renders collapse into one, and a loop between two
 * views would be flattened out of existence before the assertion saw it. */
function mount(over: Partial<ReviewSettings> & { runs?: number }) {
  const take = blankTake({
    expected: "CQ DE W7YFR",
    expectedSource: "the test",
    charWpm: 20,
    farnsworthWpm: 20,
  });
  const loaded = {
    take,
    clip: { samples: new Float32Array(0), rate: take.rate, peak: 0 },
    data: null,
  };
  const seen: ReviewSettings["view"][] = [];
  const { runs: _runs, ...settingsOver } = over;
  let picked = Math.max((over.runs ?? 1) - 1, 0);
  let latest: ReviewSettings = { ...defaultSettings(take), ...settingsOver };

  function Harness() {
    const [settings, setSettings] = useState<ReviewSettings>(latest);
    const [at, setAt] = useState(picked);
    latest = settings;
    picked = at;
    const review = reviewTake(take, settings);
    /* A session with more than one attempt in it, so that dropping down to
       just the incoming one is a visible difference. The same review twice is
       enough: what is under test is how many rows are drawn, not what is in
       them. */
    const stack = Array.from({ length: over.runs ?? 1 }, () => review);
    return createElement(ReviewScreen, {
      loaded,
      review,
      stack,
      selected: at,
      onSelectRun: setAt,
      onDropRun: () => {},
      settings,
      onChange: (patch) => {
        if (patch.view) seen.push(patch.view);
        setSettings((prev) => ({ ...prev, ...patch }));
      },
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
  return { view: () => latest.view, seen, picked: () => picked };
}

/** The button that goes by this name.
 *
 * Its accessible name rather than its text: the record control is an icon, and
 * the name is what it is called for anyone who cannot see the icon — so it is
 * both the durable anchor and the one a screen reader would use. */
function press(label: string) {
  const named = (b: HTMLButtonElement) =>
    `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    named(b).includes(label),
  );
  if (!button) {
    const had = Array.from(host.querySelectorAll("button")).map(named);
    throw new Error(`no "${label}" button; screen had ${JSON.stringify(had)}`);
  }
  return act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 150));
  });
}

const record = () => press("Record");
const stop = () => press("Stop and review");

describe("the view while pacing", () => {
  it("opens the absolute axis to record against, and closes it afterwards", async () => {
    const app = mount({ paceCursor: true, view: "per-char" });
    await record();
    expect(app.view()).toBe("absolute");

    await stop();
    // Back to the one worth reading: letter against letter.
    expect(app.view()).toBe("per-char");
  });

  it("settles rather than flipping between the two", async () => {
    /* One change on the way in and one on the way out. More than that is the
       effect rebuilding itself against a new `onChange` every render. */
    const app = mount({ paceCursor: true, view: "per-char" });
    await record();
    expect(app.seen.length).toBeLessThan(4);
  });

  it("puts back the view it took, not a view of its own", async () => {
    /* You may have been in overlay. Coming back to per-character is the swap
       happening twice — once to record against and once for no reason at all. */
    const app = mount({ paceCursor: true, view: "overlay" });
    await record();
    expect(app.view()).toBe("absolute");
    await stop();
    expect(app.view()).toBe("overlay");
  });

  it("holds the chart still when the swap is turned off", async () => {
    /* It moves the chart out from under you at the moment your hand is on the
       paddle, and whether that is worth a cursor that agrees with itself is
       not a call the app gets to make for somebody. */
    const app = mount({ paceCursor: true, paceAbsolute: false, view: "per-char" });
    await record();
    expect(app.view()).toBe("per-char");
    await stop();
    expect(app.view()).toBe("per-char");
  });

  it("leaves the view alone when nothing is pacing the chart", async () => {
    /* The flash card runs on the same schedule but never touches the chart, so
       it is no reason to take a view away from somebody. */
    const app = mount({ paceCursor: false, flashCard: true, view: "per-char" });
    await record();
    expect(app.view()).toBe("per-char");
  });
});

describe("zen mode", () => {
  const sheet = () => host.querySelector("[data-testid='zen']");

  it("covers the page for the take, and gives it back", async () => {
    const app = mount({ zenMode: true, view: "per-char" });
    expect(sheet()).toBeNull();

    await record();
    expect(sheet(), "the sheet is up while the take runs").toBeTruthy();
    // And it carries the message, which is the whole reason it is there.
    expect(host.querySelector("[data-testid='zen-message']")!.textContent)
      .toBe("CQ DE W7YFR");

    await stop();
    expect(sheet(), "and gone once the paddle is down").toBeNull();
    // Nothing of the paced aids' doing: the view is where it was left.
    expect(app.view()).toBe("per-char");
  });

  it("fits every pass on the sheet, at a size that reads", async () => {
    /* The sheet exists so you never have to touch the page while sending, and
       one you have to scroll is one you have to touch. Sized by arithmetic it
       overflowed: the message wraps at a width that depends on the font the
       browser actually picked, so a pass the formula counted as one line was
       two. It is measured now, and this is the measurement.

       Checked at the counts, not at one: the failure only appears once there
       is more than fits at full size. */
    for (const times of [1, 3, 8]) {
      mount({ zenMode: true, times, expected: "CQ CQ DE W7YFR K" });
      await record();

      const text = sheet()!.querySelector<HTMLElement>(".zenmessage")!;
      const passes = text.querySelectorAll<HTMLElement>(".zenpass");
      expect(passes.length, `${times} passes drawn`).toBe(times);
      expect(
        text.scrollHeight,
        `${times} passes fit without scrolling`,
      ).toBeLessThanOrEqual(text.clientHeight + 1);

      /* And they read as separate passes. A long message wraps, so the space
         between two passes has to be bigger than the space inside one — packed
         tighter, the whole thing is a block of text with no way to see where a
         pass ends. */
      if (times > 1) {
        const gap = passes[1]!.getBoundingClientRect().top
          - passes[0]!.getBoundingClientRect().bottom;
        const line = parseFloat(getComputedStyle(text).lineHeight)
          - parseFloat(getComputedStyle(text).fontSize);
        expect(gap, `${times} passes are told apart`).toBeGreaterThan(line);
      }

      await stop();
    }
  });

  it("stops the take from where the sheet puts the button", async () => {
    /* The sheet is over the record bar, so the bar's own Stop is unreachable.
       Pressed here through the same name, which is what makes this a test of
       the sheet's copy of it rather than of the one underneath. */
    mount({ zenMode: true });
    await record();
    const stopper = sheet()!.querySelector<HTMLButtonElement>("[data-testid='zen-stop']")!;
    await act(async () => {
      stopper.click();
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(sheet()).toBeNull();
  });

  it("runs no count-in behind the sheet, whatever was set before", async () => {
    /* A preference saved before zen mode existed would otherwise arm the
       pacing loop — which swaps the axis, moves a cursor along a chart nobody
       can see, and stops the take at the end of the message. */
    const app = mount({ zenMode: true, paceCursor: true, paceAbsolute: true, view: "per-char" });
    await record();
    expect(sheet()).toBeTruthy();
    expect(app.view(), "the axis is left alone").toBe("per-char");
    /* The record bar's light, behind the sheet. It counts down while a paced
       take is waiting to begin and reads the clock once it is under way, so
       never reaching "waiting" is the count-in never having been armed. */
    const light = host.querySelector<HTMLElement>("[data-testid='reclight']")!;
    expect(light.dataset.state, "no count-in").toBe("sending");
    await stop();
  });
});

describe("what the chart shows while recording", () => {
  const height = () => host.querySelector("canvas")!.getBoundingClientRect().height;

  it("comes down to the target and the attempt arriving", async () => {
    /* With a paddle in your hand the earlier attempts are rows between your
       eye and the cursor, and the cursor is the only thing on the chart that
       is about the next second. The chart is measured rather than counted:
       every lane makes it taller, so a shorter chart is fewer rows. */
    mount({ paceCursor: true, runs: 3 });
    const before = height();

    await record();
    const during = height();
    expect(during).toBeLessThan(before);

    await stop();
    // And they come straight back once the paddle is down.
    expect(height()).toBe(before);
  });
});

describe("picking a run out of the stack", () => {
  it("takes one click on its name in the gutter", () => {
    /* The names are the handle. Going through a mark to reach the row it
       belongs to means aiming at a dit in order to say "this run", which is an
       indirection you can feel. */
    const app = mount({ runs: 3 });
    expect(app.picked()).toBe(2);

    const canvas = host.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    const rows = rowsFor(3, 2);
    act(() =>
      canvas.dispatchEvent(
        new MouseEvent("click", {
          clientX: box.left + 8,
          clientY: box.top + rows.runs[0]!.row + ROW_H / 2,
          bubbles: true,
        }),
      ),
    );
    expect(app.picked()).toBe(0);
  });

  it("leaves the name alone when it is the only attempt there is", () => {
    /* With one run the label reads YOU, and there is no other row for it to
       be — so it is a label rather than a control. */
    const app = mount({ runs: 1 });
    const canvas = host.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    const rows = rowsFor(1, 0);
    act(() =>
      canvas.dispatchEvent(
        new MouseEvent("click", {
          clientX: box.left + 8,
          clientY: box.top + rows.runs[0]!.row + ROW_H / 2,
          bubbles: true,
        }),
      ),
    );
    expect(app.picked()).toBe(0);
  });
});

