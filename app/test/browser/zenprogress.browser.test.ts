/* Live progress on the Zen sheet, end to end.
 *
 * A real recorder on a stream that plays a keyed message, and the real worker
 * decoding it. The DOM tier stands a fake in for the worker. This is the test
 * that the worker loads, gets the audio and answers while the take runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { startRecording, type Recorder } from "@/capture/mic";
import { synthesize } from "@/audio/synth";
import { targetTiming } from "@/timing";
import { ZenMode } from "@/ui/ZenMode";
import "@/ui/base.css";

const MESSAGE = "CQ DE W7YFR";
const WPM = 25;

/** A stream that keys `MESSAGE` once, from the moment it is asked for. */
function keyedMic(): { restore: () => void; seconds: number } {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const { samples, rate } = synthesize(MESSAGE, targetTiming(WPM, WPM), {
    rate: ctx.sampleRate,
    padSec: 0.5,
    amplitude: 0.5,
  });
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const was = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = () => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    src.start();
    return Promise.resolve(dest.stream);
  };
  return {
    seconds: samples.length / rate,
    restore: () => {
      navigator.mediaDevices.getUserMedia = was;
      void ctx.close();
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let mic: ReturnType<typeof keyedMic>;
let recorder: Recorder | null = null;

beforeEach(async () => {
  // A real click first. The browser holds every audio context suspended until
  // a gesture, and a suspended recorder captures nothing.
  const go = document.createElement("button");
  go.textContent = "go";
  document.body.append(go);
  await userEvent.click(go);
  go.remove();

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mic = keyedMic();
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await recorder?.cancel();
  recorder = null;
  mic.restore();
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe("live progress", () => {
  it("colors and grades the message as it is keyed, and stops at its end", async () => {
    recorder = await startRecording();
    const rec = recorder;
    let finished = 0;
    act(() =>
      root.render(
        createElement(ZenMode, {
          message: MESSAGE,
          times: 1,
          elapsed: () => rec.elapsed(),
          level: 0,
          busy: false,
          live: { recorder: rec, charWpm: WPM, farnsworthWpm: WPM },
          grade: true,
          onFinish: () => finished++,
          onRestart: () => {},
          onDiscard: () => {},
        }),
      ),
    );

    // Started, or read back: anything colored.
    const keyed = () => host.querySelectorAll(".zenkeyed, .zenright, .zenwrong").length;
    const seen: number[] = [];
    const until = mic.seconds + 1.5;
    for (let t = 0; t < until; t += 0.25) {
      await wait(250);
      seen.push(keyed());
    }

    expect(seen[0], "nothing before the first character").toBe(0);
    expect(seen[seen.length - 1], `counts seen: ${seen.join(" ")}`).toBe(9);
    // On the way, not all at the end.
    expect(seen.some((n) => n > 0 && n < 9), `counts seen: ${seen.join(" ")}`).toBe(true);
    const right = host.querySelectorAll<HTMLElement>(".zenright");
    expect(right.length, "every character right").toBe(9);
    // The verdict is a dot under the character, in the theme's blue. The
    // letter itself keeps the text color.
    const dot = getComputedStyle(right[0]!, "::after");
    const blue = getComputedStyle(document.documentElement).getPropertyValue("--you").trim();
    const probe = document.createElement("span");
    probe.style.color = blue;
    document.body.append(probe);
    const blueRgb = getComputedStyle(probe).color;
    probe.remove();
    expect(parseFloat(dot.width), "a dot is drawn").toBeGreaterThan(0);
    expect(dot.backgroundColor).toBe(blueRgb);
    expect(getComputedStyle(right[0]!).color).not.toBe(blueRgb);
    // The message is sized to fill the sheet. The dots must not push it over.
    const text = host.querySelector<HTMLElement>(".zenmessage")!;
    expect(text.scrollHeight, "the dots add no scroll").toBeLessThanOrEqual(text.clientHeight + 1);
    expect(finished, "the take finished itself, once").toBe(1);
  }, 20_000);
});

describe("the grading dots", () => {
  it("fit under every line when the passes fill the sheet", async () => {
    /* Eight passes, so the type is as large as the height allows and the last
       line sits at the bottom of the box. A stand-in worker grades every
       character at once. */
    const posted: Array<{ type: string; gen?: number; target?: string[] }> = [];
    let answer: ((ev: { data: unknown }) => void) | null = null;
    class Graded {
      set onmessage(fn: (ev: { data: unknown }) => void) {
        answer = fn;
      }
      postMessage(msg: { type: string }) {
        posted.push(msg);
      }
      terminate() {}
    }
    const real = window.Worker;
    (window as unknown as { Worker: unknown }).Worker = Graded;
    try {
      recorder = await startRecording();
      const rec = recorder;
      act(() =>
        root.render(
          createElement(ZenMode, {
            message: "CQ CQ DE W7YFR K",
            times: 8,
            elapsed: () => 0,
            level: 0,
            busy: false,
            live: { recorder: rec, charWpm: WPM, farnsworthWpm: WPM },
            grade: true,
            onFinish: () => {},
            onRestart: () => {},
            onDiscard: () => {},
          }),
        ),
      );
      await wait(100);
      const start = posted.find((m) => m.type === "start")!;
      const n = start.target!.length;
      // All but the last right, the last wrong: both kinds of dot drawn.
      const graded = Array.from({ length: n }, (_, i) => i < n - 1);
      act(() => answer!({ data: { gen: start.gen, reached: n, graded } }));
      await wait(50);

      expect(host.querySelectorAll(".zenright").length).toBe(n - 1);
      expect(host.querySelectorAll(".zenwrong").length).toBe(1);
      const text = host.querySelector<HTMLElement>(".zenmessage")!;
      expect(text.scrollHeight, "the dots add no scroll").toBeLessThanOrEqual(
        text.clientHeight + 1,
      );
      // And the last dot is inside the box.
      const last = host.querySelector<HTMLElement>(".zenwrong")!;
      const dotBottom = last.getBoundingClientRect().bottom
        - parseFloat(getComputedStyle(last, "::after").bottom);
      expect(dotBottom).toBeLessThanOrEqual(text.getBoundingClientRect().bottom + 1);
    } finally {
      (window as unknown as { Worker: unknown }).Worker = real;
    }
  });
});
