/* The readout, and the control that gets it out of the way.
 *
 * Debug tooling rather than product surface, so this is not exhaustive. It
 * covers the two things that would make the panel worse than not having it:
 * appearing when nobody asked for it, and covering the button underneath it
 * with no way to move it. The second is a real report — the panel is pinned to
 * the bottom of the screen, and on the landing page that is where the button
 * out of it lives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MicDebug } from "@/ui/MicDebug";
import type { RecorderHandle } from "@/ui/useRecorder";

const REC = {
  devices: [{ deviceId: "a", label: "iPhone Microphone" }],
  probing: false,
  needAccess: false,
  blocked: false,
  recorder: null,
  elapsed: 0,
  level: 0,
  busy: false,
  start: vi.fn(),
  grantAccess: vi.fn(),
  restart: vi.fn(),
  finish: vi.fn(),
  discard: vi.fn(),
} as unknown as RecorderHandle;

function flag(on: boolean) {
  window.history.replaceState({}, "", on ? "/?micdebug" : "/");
}

beforeEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([
          { kind: "audioinput", deviceId: "a", label: "iPhone Microphone", groupId: "g" },
        ]),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  flag(false);
  vi.restoreAllMocks();
});

describe("the microphone readout", () => {
  it("is not there at all unless the URL asks for it", async () => {
    flag(false);
    const { container } = render(<MicDebug rec={REC} />);
    expect(container).toBeEmptyDOMElement();
    // And it does not go reading devices behind the page's back either.
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  it("folds out of the way, and says the one thing worth seeing while folded", async () => {
    flag(true);
    const user = userEvent.setup();
    render(<MicDebug rec={REC} />);

    // Waiting for the probe, so its state update is not left mid-flight.
    await waitFor(() => expect(screen.getByTestId("mic-debug")).toHaveTextContent(/iPhone/));

    await user.click(screen.getByTestId("mic-debug-hide"));
    expect(screen.queryByTestId("mic-debug")).toBeNull();

    /* Not merely gone: which branch the screen is in is the question the panel
       exists to answer, and it is worth carrying on the tab that replaces it. */
    const tab = screen.getByTestId("mic-debug-show");
    expect(tab).toHaveTextContent("needAccess=false");

    await user.click(tab);
    expect(await screen.findByTestId("mic-debug")).toBeInTheDocument();
  });

  it("stays folded across a change of screen", async () => {
    flag(true);
    const user = userEvent.setup();
    const first = render(<MicDebug rec={REC} />);
    await waitFor(() => expect(screen.getByTestId("mic-debug")).toBeInTheDocument());
    await user.click(screen.getByTestId("mic-debug-hide"));
    first.unmount();

    /* A different screen builds its own panel. One that reopened itself would
       be a control that does not stay where it was put — and the landing page
       and the review screen are exactly the pair this gets used across. */
    render(<MicDebug rec={REC} />);
    expect(screen.getByTestId("mic-debug-show")).toBeInTheDocument();
    expect(screen.queryByTestId("mic-debug")).toBeNull();

    // Left as it was found, since the fold outlives any one render tree.
    await user.click(screen.getByTestId("mic-debug-show"));
  });
});
