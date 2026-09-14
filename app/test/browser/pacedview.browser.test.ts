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
function mount(over: Partial<ReviewSettings>) {
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
  let latest: ReviewSettings = { ...defaultSettings(take), ...over };

  function Harness() {
    const [settings, setSettings] = useState<ReviewSettings>(latest);
    latest = settings;
    return createElement(ReviewScreen, {
      loaded,
      review: reviewTake(take, settings),
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
      onConfigure: () => {},
      onClear: () => {},
      onBack: () => {},
    });
  }

  act(() => root.render(createElement(Harness)));
  return { view: () => latest.view, seen };
}

/** The button whose label contains this text. Found by what it says, because
 *  that is what a person clicks; there is no test hook on these. */
function press(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) {
    const had = Array.from(host.querySelectorAll("button")).map((b) => b.textContent);
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

  it("leaves the view alone when nothing is pacing the chart", async () => {
    /* The flash card runs on the same schedule but never touches the chart, so
       it is no reason to take a view away from somebody. */
    const app = mount({ paceCursor: false, flashCard: true, view: "per-char" });
    await record();
    expect(app.view()).toBe("per-char");
  });
});
