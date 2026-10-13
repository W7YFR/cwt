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
  it("colors the message as it is keyed, and stops at its end", async () => {
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
          onFinish: () => finished++,
          onRestart: () => {},
          onDiscard: () => {},
        }),
      ),
    );

    const keyed = () => host.querySelectorAll(".zenkeyed").length;
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
    expect(finished, "the take finished itself, once").toBe(1);
  }, 20_000);
});
