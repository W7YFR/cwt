/* Pass thru on the Live page: the input through the speakers, at the Volume,
 * only while it is ticked. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as mic from "@/capture/mic";
import { App } from "@/ui/App";

const monitor = vi.fn();

beforeEach(() => {
  localStorage.setItem("cwt:prefs", JSON.stringify({ page: "live" }));
  localStorage.setItem("cwt:live-page", "1");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: "audioinput", deviceId: "radio", label: "Radio", groupId: "g" }]),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.spyOn(mic, "startRecording").mockResolvedValue({
    elapsed: () => 0,
    peek: () => new Float32Array(0),
    rate: 48000,
    since: () => new Float32Array(0),
    restarts: () => 0,
    stop: vi.fn(),
    cancel: vi.fn(),
    restart: vi.fn(),
    monitor,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  monitor.mockReset();
  localStorage.clear();
});

describe("Pass thru", () => {
  it("plays the input only while it is ticked, at the Volume", async () => {
    render(<App />);
    /* Listen is shown before the input is found, and a click on it does
       nothing until then. */
    const listen = await screen.findByTestId("live-start");
    await waitFor(() => expect(listen).toBeEnabled());
    fireEvent.click(listen);
    // Listening, and off: nothing reaches the speakers.
    await waitFor(() => expect(monitor).toHaveBeenCalled());
    expect(monitor.mock.lastCall![0]).toBe(0);

    fireEvent.click(screen.getByTestId("chip-passthru"));
    fireEvent.click(document.getElementById("live-passthru")!);
    // At the Volume, 0 dB: the input as it comes.
    await waitFor(() => expect(monitor.mock.lastCall![0]).toBe(1));

    fireEvent.click(document.getElementById("live-passthru")!);
    await waitFor(() => expect(monitor.mock.lastCall![0]).toBe(0));
  });
});
