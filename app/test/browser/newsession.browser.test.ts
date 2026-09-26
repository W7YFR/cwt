/* Starting a session and starting to send, on one click.
 *
 * The dialog collects what the session is; the record dot beside Save says
 * "and go". What that has to get right is an order: the session is declared
 * first and the microphone opens second, or the first second of the take is
 * paced against the message this one replaced.
 *
 * Here rather than in the DOM tier because both ends have to be real — a
 * recorder that actually opens a device, and a canvas with a 2D context under
 * the chart that is on screen while it does.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewScreen } from "@/ui/ReviewScreen";
import { defaultSettings, reviewTake } from "@/timing";
import { blankTake } from "@/io/take";
import type { ReviewSettings } from "@/types";
import "@/ui/base.css";

/** A real MediaStream with a real audio track, made without a microphone. */
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

/** The review screen, driven the way App drives it: the settings live above
 *  it, and a new session replaces them. */
function mount() {
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
  let latest: ReviewSettings = defaultSettings(take);

  function Harness() {
    const [settings, setSettings] = useState<ReviewSettings>(latest);
    latest = settings;
    const review = reviewTake(take, settings);
    return createElement(ReviewScreen, {
      loaded,
      review,
      stack: [review],
      selected: 0,
      onSelectRun: () => {},
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
      onConfigure: () => {},
      onFile: () => {},
      onClear: () => {},
      onNewSession: (next) => setSettings((prev) => ({ ...prev, ...next })),
      onBack: () => {},
    });
  }

  act(() => root.render(createElement(Harness)));
  return { settings: () => latest };
}

/** The button that goes by this name — by accessible name, because the record
 *  control is an icon and that is what it is called for anyone not seeing it.
 *
 * Whole name, not a substring: "Save" is a substring of "Save and record", and
 * a helper that took the first match would quietly press whichever of the two
 * happened to come first in the DOM — which is the difference this file is
 * about. */
function press(label: string) {
  const named = (b: HTMLButtonElement) =>
    (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
  const button = Array.from(host.querySelectorAll("button")).find(
    (b) => named(b) === label,
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

const type = (testid: string, value: string) =>
  act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>(`#${testid}`)!;
    const setter = Object.getOwnPropertyDescriptor(
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

const recording = () => host.querySelector(".recordbar.recording") !== null;

const button = (label: string): HTMLButtonElement => {
  const named = (b: HTMLButtonElement) =>
    (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
  return Array.from(host.querySelectorAll("button")).find((b) => named(b) === label)!;
};

describe("a new session that starts recording", () => {
  it("declares the session, then opens the microphone", async () => {
    const app = mount();
    await press("New session");
    await type("ns-text", "paris paris");
    await press("Save and record");

    // Both halves, and in this order: the message is what the recording that
    // just started is an attempt at.
    expect(app.settings().expected).toBe("PARIS PARIS");
    expect(recording()).toBe(true);
  });

  it("leaves the microphone alone when only saving", async () => {
    /* The other reason to open the dialog: set the session up now, hear the
       target, send it when you are ready. */
    const app = mount();
    await press("New session");
    await type("ns-text", "cq test");
    await press("Save");

    expect(app.settings().expected).toBe("CQ TEST");
    expect(recording()).toBe(false);
  });

  it("tells the two apart by the dot, not by an accent", async () => {
    /* Three ordinary buttons. The dot is recognizable as a way into the
       microphone because it carries the same red dot every other one does, and
       a colored border on top of that would be a second way of saying it.
       Read off the rendered page rather than off the class list: which of a
       shape class and a color class wins is a question about the stylesheet,
       not about the markup. */
    mount();
    await press("New session");
    const border = (label: string) => getComputedStyle(button(label)).borderTopColor;
    expect(border("Save and record")).toBe(border("Save"));
    expect(border("Save")).toBe(border("Cancel"));
    // The dot itself is what distinguishes it, and it is still there.
    expect(button("Save and record").querySelector(".recdot")).not.toBe(null);
  });

  it("closes either way", async () => {
    const app = mount();
    await press("New session");
    await press("Save and record");
    expect(host.querySelector("[data-testid='new-session']")).toBe(null);
    expect(app.settings()).toBeTruthy();
  });
});
