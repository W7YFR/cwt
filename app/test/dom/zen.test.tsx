/* The sheet that covers the page while a zen take runs.
 *
 * Two things make it more than a div with big type. It covers the record bar,
 * so every control that bar was offering has to be on it — a way out you can
 * only reach by knowing a keystroke is not a way out. And it must not swallow
 * those keystrokes: they are bound on the document precisely so they answer
 * with a hand on a paddle rather than on this dialog.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as mic from "@/capture/mic";
import { ZenMode } from "@/ui/ZenMode";
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

afterEach(() => vi.restoreAllMocks());

describe("the zen sheet", () => {
  it("offers every way out of the take that it covers", async () => {
    const user = userEvent.setup();
    const acts = { onFinish: vi.fn(), onRestart: vi.fn(), onDiscard: vi.fn() };
    render(
      <ZenMode message="CQ DE W7YFR" elapsed={() => 0} level={0} busy={false} {...acts} />,
    );

    for (const [handle, fired] of [
      ["zen-stop", acts.onFinish],
      ["zen-restart", acts.onRestart],
      ["zen-cancel", acts.onDiscard],
    ] as const) {
      await user.click(screen.getByTestId(handle));
      expect(fired, handle).toHaveBeenCalled();
    }
  });

  it("shows the message it is covering the page for", () => {
    render(
      <ZenMode
        message="CQ DE W7YFR"
        elapsed={() => 0}
        level={0}
        busy={false}
        onFinish={vi.fn()}
        onRestart={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId("zen-message").textContent).toBe("CQ DE W7YFR");
  });

  it("says so rather than showing an empty page when there is no message", () => {
    render(
      <ZenMode
        message=""
        elapsed={() => 0}
        level={0}
        busy={false}
        onFinish={vi.fn()}
        onRestart={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    // Whatever it says, it says something — a blank sheet reads as broken.
    expect(screen.getByTestId("zen-message").textContent!.trim().length).toBeGreaterThan(0);
  });

  it("bars the way out while the take is being read, like the bar it replaces", () => {
    render(
      <ZenMode
        message="CQ"
        elapsed={() => 0}
        level={0}
        busy
        onFinish={vi.fn()}
        onRestart={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId("zen-stop")).toBeDisabled();
  });

  describe("with the recorder behind it", () => {
    /** The sheet, wired to a real recorder the way the review screen wires it. */
    function Harness(): React.ReactElement | null {
      const rec = useRecorder({
        deviceId: undefined,
        onClip: vi.fn(),
        onError: vi.fn(),
        startKey: true,
      });
      if (!rec.recorder) return null;
      return (
        <ZenMode
          message="CQ DE W7YFR"
          elapsed={() => rec.recorder!.elapsed()}
          level={rec.level}
          busy={rec.busy}
          onFinish={() => void rec.finish()}
          onRestart={rec.restart}
          onDiscard={() => void rec.discard()}
        />
      );
    }

    async function recording() {
      const handle = {
        elapsed: () => 0,
        peek: () => new Float32Array(0),
        stop: vi.fn().mockResolvedValue({ samples: new Float32Array(1), rate: 8000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn(),
      };
      vi.spyOn(mic, "startRecording").mockResolvedValue(handle);
      render(<Harness />);
      await act(async () => {
        fireEvent.keyDown(document.body, { key: "r" });
      });
      await waitFor(() => expect(screen.getByTestId("zen")).toBeTruthy());
      return handle;
    }

    /* The keys are bound on the document so they work with a hand on a paddle.
       Fired at whatever the sheet focused, which is the arrangement that would
       break if this ever grew a handler that stopped them. */
    it.each([
      ["Enter", "stop"],
      ["Escape", "cancel"],
      ["r", "restart"],
    ] as const)("still answers %s with the sheet up", async (key, called) => {
      const handle = await recording();
      expect(document.activeElement, "focus is inside the sheet").toBe(
        screen.getByTestId("zen"),
      );

      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key });
      });
      await waitFor(() => expect(handle[called]).toHaveBeenCalled());
    });
  });
});
