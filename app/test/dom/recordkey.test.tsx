/* R, when nothing is being recorded.
 *
 * The key is the recorder's own — one key for one idea, "go, from here" — so
 * it lives with the recorder rather than with either screen that offers a
 * record button. What the screens get to decide is whether it is listening at
 * all, and that is what this is about: the wizard drives the recorder on its
 * own schedule and must not have a key starting one behind its back, and a
 * screen with a dialog open has a question in front of it that R is not an
 * answer to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import * as mic from "@/capture/mic";
import { useRecorder } from "@/ui/useRecorder";

beforeEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function listening(startKey: boolean, onStart?: () => void) {
  const start = vi.spyOn(mic, "startRecording").mockResolvedValue({
    elapsed: () => 0,
    peek: () => new Float32Array(0),
    stop: vi.fn(),
    cancel: vi.fn(),
    restart: vi.fn(),
  });
  const view = renderHook(() =>
    useRecorder({
      deviceId: undefined,
      onClip: vi.fn(),
      onError: vi.fn(),
      startKey,
      ...(onStart ? { onStart } : {}),
    }),
  );
  return { start, view };
}

const settled = () =>
  waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());

const pressR = () =>
  act(async () => {
    fireEvent.keyDown(document.body, { key: "r" });
  });

describe("the record key", () => {
  it("starts a recording for a screen that asked to listen for it", async () => {
    const { start } = listening(true);
    await settled();
    await pressR();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stays silent for one that did not", async () => {
    const { start } = listening(false);
    await settled();
    await pressR();
    expect(start).not.toHaveBeenCalled();
  });

  it("hands the room over before opening the device", async () => {
    /* Playback and recording cannot both have it: through a loopback device a
       playing target is recorded literally, and through speakers it arrives a
       moment later and grades as your sending. The transport is already barred
       from starting during a take, and this is the other half of that rule.

       Before, not after — the point is that nothing is playing while the
       device is open, and opening one takes long enough for the difference to
       be audible. */
    const clear = vi.fn();
    const { start } = listening(true, clear);
    await settled();
    await pressR();
    expect(clear).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(clear.mock.invocationCallOrder[0]!).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
  });

  it("can be taken away while a screen is busy with something else", async () => {
    /* A dialog is the case: the screen that opened it still has a record
       button behind it, and a recording started from back there would answer a
       question nobody asked. */
    const start = vi.spyOn(mic, "startRecording");
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useRecorder({
          deviceId: undefined,
          onClip: vi.fn(),
          onError: vi.fn(),
          startKey: on,
        }),
      { initialProps: { on: true } },
    );
    await settled();

    rerender({ on: false });
    await pressR();
    expect(start).not.toHaveBeenCalled();

    // And comes back when the dialog does.
    rerender({ on: true });
    await pressR();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
