/* A permission that is answered once and never mentioned again.
 *
 * Measured on an iPhone rather than reasoned about: Safari answers
 * `permissions.query({name:"microphone"})` with "prompt", fires no `change`
 * when the microphone is subsequently granted, and answers "granted" the next
 * time it is asked. The page therefore holds a true-at-load answer that is
 * false a second later, with nothing to tell it so — and the screens read that
 * stale answer as "not asked yet" and go on offering to ask.
 *
 * This is the browser the app was wrong about twice. The first fix assumed
 * Safari refused the query and only upgraded "unknown"; the query resolves, so
 * it changed nothing. These tests are the shape of the real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRecorder } from "@/ui/useRecorder";

const SETTLE = { timeout: 5000 };

/** Two inputs with the names withheld: the state in which asking for the
 *  microphone is a step of its own, because there is a choice behind it. */
const UNGRANTED = [
  { kind: "audioinput", deviceId: "", label: "", groupId: "g1" },
  { kind: "audioinput", deviceId: "", label: "", groupId: "g2" },
];

/** Safari's shape: `query` resolves, and `change` never fires.
 *
 * The state is read at the moment of the call rather than captured, so a test
 * can move it the way granting the microphone moves it — and every query after
 * that point gets the new answer while the old `PermissionStatus` sits there
 * saying what it said at load, exactly as it does on the device. */
function mockPermissions(state: () => PermissionState) {
  const query = vi.fn(async () => ({
    get state() {
      return state();
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query },
  });
  return query;
}

let permission: PermissionState;

beforeEach(() => {
  permission = "prompt";
  mockPermissions(() => permission);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(UNGRANTED),
      // Granting is what moves the browser's answer, here as on the device.
      getUserMedia: vi.fn(async () => {
        permission = "granted";
        return { getTracks: () => [{ stop: vi.fn() }] };
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function hook(onError = vi.fn()) {
  const view = renderHook(() =>
    useRecorder({ deviceId: undefined, onClip: vi.fn(), onError }),
  );
  return { view, onError };
}

const ready = (view: { result: { current: { probing: boolean } } }) =>
  waitFor(() => expect(view.result.current.probing).toBe(false), SETTLE);

describe("a browser that answers the permission once", () => {
  it("stops offering to ask once a device has actually opened", async () => {
    const { view } = hook();
    await ready(view);
    // The honest state at load, and the one the screens are built around.
    expect(view.result.current.needAccess).toBe(true);

    await act(async () => {
      await view.result.current.grantAccess();
    });

    /* The names are still withheld in this fixture and no `change` has fired,
       so every signal the old code consulted still says "not asked yet". The
       device that opened says otherwise, and it is the one that was there. */
    await waitFor(() => expect(view.result.current.needAccess).toBe(false), SETTLE);
    expect(view.result.current.blocked).toBe(false);
  });

  it("asks the browser again rather than waiting for news it will not send", async () => {
    const query = navigator.permissions.query as ReturnType<typeof vi.fn>;
    const { view } = hook();
    await ready(view);
    const asked = query.mock.calls.length;

    await act(async () => {
      await view.result.current.grantAccess();
    });
    await waitFor(() => expect(view.result.current.needAccess).toBe(false), SETTLE);

    /* Not merely remembered locally: the browser is re-asked, so the app ends
       up holding what the browser would say now rather than a local override
       of what it said at load. That matters where the two could disagree —
       a permission revoked from the site settings is the browser's to report,
       and it can only report it to someone who asks. */
    expect(query.mock.calls.length).toBeGreaterThan(asked);
  });

  it("still bars the page when the browser says denied", async () => {
    const { view } = hook();
    await ready(view);

    /* Granted once, then taken away from the browser's own settings — the one
       case where a remembered "yes" would be actively wrong. The re-read finds
       "denied", which outranks it. */
    await act(async () => {
      await view.result.current.grantAccess();
    });
    await waitFor(() => expect(view.result.current.needAccess).toBe(false), SETTLE);

    permission = "denied";
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await act(async () => {
      await view.result.current.start();
    });

    await waitFor(() => expect(view.result.current.blocked).toBe(true), SETTLE);
    expect(view.result.current.needAccess).toBe(false);
  });

  /* Reported from a desktop, after a shortcut that read the device list as a
     count shipped and took the asking step away from a machine with several
     microphones in it.

     The list this fixture returns is byte-for-byte what an iPhone with exactly
     one microphone returns — `{id:(empty) label:(empty)}`, one entry — and the
     two cases are not distinguishable from here. A placeholder is what a
     browser hands back *instead of* the inputs, so its length is not a count
     of them, and the only list that can be counted is one whose names have
     arrived. By then permission has been granted and the question is already
     answered. */
  it("does not read an anonymized list as a count of the inputs", async () => {
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "audioinput", deviceId: "", label: "", groupId: "" },
    ]);

    const { view } = hook();
    await ready(view);

    /* One entry, no names, and a browser that will ask: the microphone has not
       been granted, whatever the length of that list suggests. */
    expect(view.result.current.devices).toHaveLength(1);
    expect(view.result.current.needAccess).toBe(true);
  });
});
