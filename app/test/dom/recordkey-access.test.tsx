/* R, before the microphone has been allowed.
 *
 * The key and the record button are two ways in to one thing, so a rule only
 * one of them obeys is not a rule. The button has three states — ask, record,
 * barred — and these are the two that are not "record": R must not open a
 * device that has never been chosen, and it must not keep reaching for one the
 * browser has already refused.
 *
 * Separate from `recordkey.test.tsx` because the fixture is the subject here.
 * That file mocks a microphone that has been allowed; every test below mocks
 * one that has not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import * as mic from "@/capture/mic";
import { useRecorder } from "@/ui/useRecorder";

/** What a browser hands back before it has been allowed the microphone: the
 *  input is there, with the name stripped off. */
const UNGRANTED = [{ kind: "audioinput", deviceId: "", label: "", groupId: "" }];

beforeEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(UNGRANTED),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* Every wait here is on hook state rather than on markup, and each one sits at
   the end of a chain of promises: enumerate, then permission, then enumerate
   again. `waitFor` polls on a timer, and its default one-second budget is the
   whole chain's — which is fine alone and not fine at all when the pure tier
   is using every core. One of these failed at 1014ms in a full run and passed
   on its own, which is the signature. The budget is not what is under test. */
const SETTLE = { timeout: 5000 };

/* Waiting for the lookup to have been MADE is not the same as waiting for its
   answer, and the difference is a race the key can lose: press R in between
   and `needAccess` is still at its mount-time default, so the key takes the
   branch that records instead of the branch that asks. That is exactly the
   window `probing` exists to close, so waiting on it is both the honest
   barrier and the thing under test. */
const ready = (view: { result: { current: { probing: boolean } } }) =>
  waitFor(() => expect(view.result.current.probing).toBe(false), SETTLE);

const pressR = () =>
  act(async () => {
    fireEvent.keyDown(document.body, { key: "r" });
  });

function hook(onError = vi.fn()) {
  const view = renderHook(() =>
    useRecorder({ deviceId: undefined, onClip: vi.fn(), onError, startKey: true }),
  );
  return { view, onError };
}

describe("the record key before access has been granted", () => {
  it("asks for the microphone rather than recording from it", async () => {
    const start = vi.spyOn(mic, "startRecording");
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });

    const { view } = hook();
    await ready(view);
    expect(view.result.current.needAccess).toBe(true);

    await pressR();

    // The prompt, and nothing else: a take recorded here would be from
    // whatever the default input happens to be, which is the choice this
    // whole state exists to give back.
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("stops reaching for a microphone the browser has refused", async () => {
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMedia.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

    const { view, onError } = hook();
    await ready(view);

    await pressR();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/denied/i));

    /* Refused is remembered rather than re-read, because only Chromium will
       report it: Firefox and Safari reject the permission query for the
       microphone, so without this the page would go on offering to ask and
       every press would be a prompt nobody is shown. */
    await waitFor(() => expect(view.result.current.blocked).toBe(true), SETTLE);
    expect(view.result.current.needAccess).toBe(false);

    await pressR();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("records once the names arrive", async () => {
    const start = vi.spyOn(mic, "startRecording").mockResolvedValue({
      elapsed: () => 0,
      peek: () => new Float32Array(0),
      stop: vi.fn(),
      cancel: vi.fn(),
      restart: vi.fn(),
    });
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMedia.mockImplementation(async () => {
      (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { kind: "audioinput", deviceId: "a", label: "Built-in Microphone", groupId: "g" },
      ]);
      return { getTracks: () => [{ stop: vi.fn() }] };
    });

    const { view } = hook();
    await ready(view);

    await pressR();
    await waitFor(() => expect(view.result.current.needAccess).toBe(false), SETTLE);
    expect(start).not.toHaveBeenCalled();

    // The same key, now meaning what it usually means.
    await pressR();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
