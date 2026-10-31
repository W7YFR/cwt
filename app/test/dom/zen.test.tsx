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
      /* A named input: that is how the page knows the microphone has already
         been allowed, and R only records once it does. Withheld names put the
         key on its other errand — asking for access — which is a different
         test, in recordkey-access. */
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([
          { kind: "audioinput", deviceId: "default", label: "Built-in Microphone", groupId: "g" },
        ]),
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
      <ZenMode message="CQ DE W7YFR" times={1} elapsed={() => 0} level={0} busy={false} {...acts} />,
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

  it("shows every pass it is asking for, as passes", () => {
    /* Run together as one string you cannot see where a pass ends, which is
       the one thing about a repeat worth seeing. */
    render(
      <ZenMode
        message="CQ DE W7YFR"
        times={4}
        elapsed={() => 0}
        level={0}
        busy={false}
        onFinish={vi.fn()}
        onRestart={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    const passes = screen.getByTestId("zen-message").querySelectorAll(".zenpass");
    expect(passes.length).toBe(4);
    for (const pass of passes) expect(pass.textContent).toBe("CQ DE W7YFR");
  });

  it("never draws fewer passes than one", () => {
    // Clamped the way the target's own repeat is, so the sheet and the audio
    // cannot disagree about how many there are.
    for (const times of [0, -2, 0.5, Number.NaN]) {
      const view = render(
        <ZenMode
          message="CQ"
          times={times}
          elapsed={() => 0}
          level={0}
          busy={false}
          onFinish={vi.fn()}
          onRestart={vi.fn()}
          onDiscard={vi.fn()}
        />,
      );
      expect(
        view.container.querySelectorAll(".zenpass").length,
        `times ${times}`,
      ).toBe(1);
      view.unmount();
    }
  });

  it("shows the message it is covering the page for", () => {
    render(
      <ZenMode
        message="CQ DE W7YFR"
        times={1}
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
        times={1}
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
        times={1}
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
      /* Nothing to draw until a take is running — but the key is inert until
         the recorder has read the device list, so the test needs something to
         wait on before it presses R. */
      if (!rec.recorder) return rec.probing ? null : <span data-testid="armed" />;
      return (
        <ZenMode
          message="CQ DE W7YFR"
          times={1}
          elapsed={() => rec.recorder!.elapsed()}
          level={rec.level}
          busy={rec.busy}
          onFinish={() => void rec.finish()}
          onRestart={rec.restart}
          onDiscard={() => void rec.discard()}
        />
      );
    }

    /* A budget, because these wait on a chain of promises rather than on one:
       the device list, then the recorder opening, then the key being answered.
       The default second is the whole chain's and is fine on an idle machine —
       one of these failed once in a full run, where the pure tier is using
       every core, and has not since. The budget is not what is under test. */
    const SETTLE = { timeout: 5000 };

    async function recording() {
      const handle = {
        elapsed: () => 0,
        peek: () => new Float32Array(0),
        rate: 48000,
        since: () => new Float32Array(0),
        restarts: () => 0,
        stop: vi.fn().mockResolvedValue({ samples: new Float32Array(1), rate: 8000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn(),
      };
      vi.spyOn(mic, "startRecording").mockResolvedValue(handle);
      render(<Harness />);
      await screen.findByTestId("armed");
      await act(async () => {
        fireEvent.keyDown(document.body, { key: "r" });
      });
      await waitFor(() => expect(screen.getByTestId("zen")).toBeTruthy(), SETTLE);
      return handle;
    }

    /* A key pressed the moment the page changes, before React's effects for
       that render have run, as a quick hand or a busy machine can. The keys
       answered from the render before, which still saw no device list or no
       recorder, and dropped the key: on a loaded CI runner the tests below
       hung on it now and then. */
    it("answers R the moment the page shows it is ready, and Escape the moment the take shows", async () => {
      const handle = {
        elapsed: () => 0,
        peek: () => new Float32Array(0),
        rate: 48000,
        since: () => new Float32Array(0),
        restarts: () => 0,
        stop: vi.fn().mockResolvedValue({ samples: new Float32Array(1), rate: 8000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn(),
      };
      vi.spyOn(mic, "startRecording").mockResolvedValue(handle);
      /** Press `key` as soon as `testid` is in the page, from the DOM's own
       *  notice of the change. */
      const pressed: string[] = [];
      const pressOn = (testid: string, key: string) => {
        const watch = new MutationObserver(() => {
          if (!document.querySelector(`[data-testid="${testid}"]`)) return;
          watch.disconnect();
          // In act, as a key the test presses is, but before the render's
          // effects: act runs this first and flushes after.
          act(() => {
            fireEvent.keyDown(document.body, { key });
          });
          pressed.push(key);
        });
        watch.observe(document.body, { childList: true, subtree: true });
      };
      pressOn("armed", "r");
      pressOn("zen", "Escape");
      render(<Harness />);
      // Waited on as the other tests wait, so the page's own updates in
      // between are not act's to answer for.
      await waitFor(() => expect(pressed).toEqual(["r", "Escape"]), { timeout: 1000 });
      await waitFor(() => expect(handle.cancel).toHaveBeenCalled(), { timeout: 1000 });
    });

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
      await waitFor(() => expect(handle[called]).toHaveBeenCalled(), SETTLE);
    });
  });
});

describe("live progress on the zen sheet", () => {
  /** Stands in for the decode worker. The test answers for it. */
  class FakeWorker {
    static last: FakeWorker | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    sent: Array<{ type: string; gen?: number; target?: string[] }> = [];
    constructor() {
      FakeWorker.last = this;
    }
    postMessage(msg: { type: string }) {
      this.sent.push(msg);
    }
    terminate() {}
    /** `graded` as a string: + right, x wrong. */
    reply(reached: number, graded = "", done = false) {
      const gen = this.sent.filter((m) => m.type === "start").at(-1)!.gen;
      const verdicts = Array.from(graded, (c) => c === "+");
      act(() => this.onmessage?.({ data: { gen, reached, graded: verdicts, done } }));
    }
  }

  let restarts = 0;
  const recorder = {
    elapsed: () => 0,
    peek: () => new Float32Array(0),
    rate: 48000,
    since: () => new Float32Array(0),
    restarts: () => restarts,
    stop: vi.fn(),
    restart: vi.fn(),
    cancel: vi.fn(),
  };

  beforeEach(() => {
    restarts = 0;
    FakeWorker.last = null;
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  function sheet(live: boolean, grade = false, onFinish = vi.fn()) {
    return render(
      <ZenMode
        message="CQ <SK>"
        times={2}
        elapsed={() => 0}
        level={0}
        busy={false}
        live={live ? { recorder, charWpm: 20, farnsworthWpm: 20 } : null}
        grade={grade}
        onFinish={onFinish}
        onRestart={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
  }

  const drawn = (cls: string) =>
    Array.from(screen.getByTestId("zen-message").querySelectorAll(`.${cls}`)).map(
      (el) => el.textContent,
    );
  const keyed = () => drawn("zenkeyed");

  it("asks for every pass, a prosign as one character", () => {
    sheet(true);
    expect(FakeWorker.last!.sent[0]).toMatchObject({
      type: "start",
      target: ["C", "Q", "<SK>", "C", "Q", "<SK>"],
    });
  });

  it("colors the characters reached, into the next pass", () => {
    sheet(true);
    expect(keyed()).toEqual([]);
    FakeWorker.last!.reply(4);
    expect(keyed()).toEqual(["C", "Q", "<SK>", "C"]);
    // The text reads the same with the colors on.
    expect(screen.getAllByText((_, el) => el?.className === "zenpass").map((p) => p.textContent))
      .toEqual(["CQ <SK>", "CQ <SK>"]);
  });

  it("never takes a character back", () => {
    sheet(true);
    FakeWorker.last!.reply(3);
    FakeWorker.last!.reply(2);
    expect(keyed()).toEqual(["C", "Q", "<SK>"]);
  });

  it("starts over with the take", () => {
    vi.useFakeTimers();
    try {
      sheet(true);
      FakeWorker.last!.reply(3);
      restarts = 1;
      act(() => vi.advanceTimersByTime(200));
      expect(keyed()).toEqual([]);
      // A late answer about the take before is dropped.
      const stale = FakeWorker.last!;
      act(() => stale.onmessage?.({ data: { gen: 1, reached: 5, graded: [] } }));
      expect(keyed()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no worker with the option off", () => {
    sheet(false);
    expect(FakeWorker.last).toBeNull();
    expect(keyed()).toEqual([]);
  });

  it("grades a character once it is read back, with grading on", () => {
    sheet(true, true);
    FakeWorker.last!.reply(4, "+x+");
    expect(drawn("zenright")).toEqual(["C", "<SK>"]);
    expect(drawn("zenwrong")).toEqual(["Q"]);
    // The one being keyed is not known yet.
    expect(drawn("zenpending")).toEqual(["C"]);
    // The letters keep their color: the dots are the whole of it.
    expect(keyed()).toEqual([]);
  });

  it("keeps every character blue with grading off", () => {
    sheet(true, false);
    FakeWorker.last!.reply(4, "+x+");
    expect(drawn("zenright")).toEqual([]);
    expect(drawn("zenwrong")).toEqual([]);
    expect(drawn("zenpending")).toEqual([]);
    expect(keyed()).toEqual(["C", "Q", "<SK>", "C"]);
  });

  it("finishes the take once the sender is done", () => {
    const onFinish = vi.fn();
    sheet(true, false, onFinish);
    FakeWorker.last!.reply(6, "+++++");
    expect(onFinish, "the last character is still being keyed").not.toHaveBeenCalled();
    FakeWorker.last!.reply(6, "++++++");
    expect(onFinish, "read back, but the wait is not over").not.toHaveBeenCalled();
    FakeWorker.last!.reply(6, "++++++", true);
    expect(onFinish).toHaveBeenCalledTimes(1);
    // Once: a later pass that reads the same end does not finish it again.
    FakeWorker.last!.reply(6, "+++++x", true);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("finishes again after a restart", () => {
    vi.useFakeTimers();
    try {
      const onFinish = vi.fn();
      sheet(true, false, onFinish);
      FakeWorker.last!.reply(6, "++++++", true);
      restarts = 1;
      act(() => vi.advanceTimersByTime(200));
      FakeWorker.last!.reply(6, "++++++", true);
      expect(onFinish).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never finishes a take without live progress", () => {
    const onFinish = vi.fn();
    sheet(false, false, onFinish);
    expect(onFinish).not.toHaveBeenCalled();
  });
});
