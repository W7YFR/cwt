/* The first screen, and the wiring that carries the intended message into the
 * take that gets recorded. */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as mic from "@/capture/mic";
import userEvent from "@testing-library/user-event";
import { Landing } from "@/ui/Landing";
import { WORDMARKS, wordmarkText } from "@/ui/wordmarks";
import { resetVisitRoll } from "@/ui/wordmarks";

function renderLanding(overrides: Partial<React.ComponentProps<typeof Landing>> = {}) {
  const props = {
    expected: "",
    onExpectedChange: vi.fn(),
    onAudio: vi.fn(),
    onError: vi.fn(),
    deviceId: undefined,
    onDeviceChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<Landing {...props} />), props };
}

beforeEach(() => {
  // jsdom has no media devices at all. Absent is the honest default — these
  // tests are about what the page does, not about what the browser can do.
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

/* The device lookup is an effect that resolves a promise, so its state update
 * lands after a synchronous test body has already asserted — React reports
 * that as an un-acted update. Waiting for it once keeps the output clean and
 * the assertions honest about what has rendered. */
async function settled() {
  await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
}

/* Spies restored globally rather than at the end of each test that makes one.
 * A `mockRestore()` on the last line only runs when the test passes, so a
 * failing assertion strands the spy and takes unrelated tests down with it. */
afterEach(() => {
  vi.restoreAllMocks();
});

/* The splash copy is the author's to reword whenever they like, so nothing
 * below matches a phrase from it. Tone is the part that has to hold: a
 * practice tool should not greet someone who came here to get better with a
 * taunt. These are the words that would mean one had crept in — a short list,
 * and one that no innocent rewrite of an encouraging page would trip. */
const SCOLDING =
  /really\?|how bad|what'?s wrong|sloppy|you fail|terrible|awful|embarrass|pathetic/i;

describe("the landing screen", () => {
  it("leads with the wordmark, not with a challenge", async () => {
    const { container } = renderLanding();
    await settled();
    // The name introduces the tool on its own, without a line of copy having
    // to carry that job.
    const art = container.querySelector(".wordmark .art")!;
    expect(art.getAttribute("role")).toBe("img");
    // Five lines of slashes read aloud one character at a time is not a
    // heading, so the label carries the name instead.
    expect(art.getAttribute("aria-label")).toMatch(/CWT/);
    // Whatever it rolled, it is one of the sixteen drawings whole — not a
    // fragment of one, and not a placeholder.
    expect(WORDMARKS.map(wordmarkText)).toContain(art.textContent);
  });

  it("introduces the tool, and does it without scolding you", async () => {
    const { container } = renderLanding();
    await settled();

    // That there is an introduction at all, rather than what it says. Landing
    // on a bare wordmark and two buttons would tell a first visitor nothing
    // about what the thing is for.
    const lede = container.querySelector(".lede");
    expect(lede).not.toBeNull();
    expect((lede!.textContent ?? "").trim().length).toBeGreaterThan(40);

    // The tone, which is the part that has to hold across rewrites.
    expect(container.textContent).not.toMatch(SCOLDING);
  });

  it("keeps one drawing for the whole visit, not one per screen", async () => {
    // The review header draws the name too, and it mounts as the landing
    // screen unmounts. A roll per mount would mean the logo silently changed
    // the moment you finished a recording.
    resetVisitRoll();
    const values = [0.05, 0.95];
    let n = 0;
    const dice = vi.spyOn(Math, "random").mockImplementation(() => values[n++] ?? 0.5);
    try {
      const first = renderLanding();
      await settled();
      const before = first.container.querySelector(".wordmark .art")!.textContent;
      first.unmount();

      const second = renderLanding();
      await settled();
      // Two very different rolls are queued up; only the first should be used.
      expect(second.container.querySelector(".wordmark .art")!.textContent).toBe(before);
      expect(n).toBe(1);
    } finally {
      dice.mockRestore();
    }
  });

  it("finishes on Enter and throws the take away on Escape, from anywhere", async () => {
    // From a focused text field in particular. That is the case the usual
    // "ignore it if a control has focus" guard gets wrong: you type what you
    // are about to send, then key it — your hand is on the paddle and the
    // intended-message box is still focused. Making you find the mouse would
    // put a second of reaching at the end of every take.
    const stop = vi.fn().mockResolvedValue({ samples: new Float32Array(8), rate: 8000, peak: 1 });
    const cancel = vi.fn().mockResolvedValue(undefined);
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue({
      getTracks: () => [],
    });

    for (const [key, expected] of [["Enter", stop], ["Escape", cancel]] as const) {
      stop.mockClear();
      cancel.mockClear();
      const rec = { elapsed: () => 1, peek: () => new Float32Array(0), stop, cancel, restart: vi.fn() };
      vi.spyOn(mic, "startRecording").mockResolvedValue(rec);
      const view = renderLanding();
      await settled();
      await act(async () => {
        screen.getByRole("button", { name: /Start recording/i }).click();
      });
      // Recording, and the focus is where it would really be.
      const field = screen.getByLabelText(/going to send/i);
      field.focus();
      expect(document.activeElement).toBe(field);

      await act(async () => {
        fireEvent.keyDown(document, { key });
      });
      expect(expected, `${key} did nothing`).toHaveBeenCalled();
      expect(key === "Enter" ? cancel : stop).not.toHaveBeenCalled();

      view.unmount();
    }
  });

  it("leaves those keys alone when there is nothing being recorded", async () => {
    // Otherwise Escape and Enter would be doing something invisible on a page
    // that is mostly a text field.
    const start = vi.spyOn(mic, "startRecording");
    renderLanding();
    await settled();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter" });
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("offers both ways in, with recording first", async () => {
    const { container } = renderLanding();
    await settled();
    const headings = Array.from(container.querySelectorAll(".way h2")).map(
      (h) => h.textContent,
    );
    // Recording is the point of the tool; reading a file is how you check one
    // you already have. The order says which is which.
    expect(headings[0]).toMatch(/Record/i);
    expect(headings[1]).toMatch(/open a recording/i);
  });

  it("takes the intended message before you record, not after", async () => {
    const user = userEvent.setup();
    const onExpectedChange = vi.fn();
    renderLanding({ onExpectedChange });
    // Asking afterwards would mean typing what you meant to send once you had
    // already seen what came out, which is not the same question.
    await user.type(screen.getByLabelText(/going to send/i), "sos");
    expect(onExpectedChange).toHaveBeenLastCalledWith("S");
  });

  it("says the message is optional, because timing works without it", async () => {
    renderLanding();
    await settled();
    expect(screen.getByText(/optional/i)).toBeInTheDocument();
  });

  it("reports a denied microphone in words a person can act on", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    renderLanding({ onError });
    await user.click(screen.getByRole("button", { name: /Start recording/i }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0]).toMatch(/denied/i);
    expect(onError.mock.calls[0]![0]).toMatch(/address bar/i);
  });

  it("rejects a drop that has no audio in it", async () => {
    const onError = vi.fn();
    const { container } = renderLanding({ onError });
    const drop = container.querySelector(".way.drop")!;

    fireEvent.drop(drop, {
      dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0]).toMatch(/no audio/i);
  });

  it("highlights the drop target while something is over it", async () => {
    const { container } = renderLanding();
    await settled();
    const drop = container.querySelector(".way.drop")!;
    expect(drop.className).not.toContain("over");

    // fireEvent wraps the dispatch in act(), so the re-render has happened by
    // the time the assertion runs; a raw dispatchEvent leaves it pending.
    fireEvent.dragOver(drop, { dataTransfer: { files: [] } });
    expect(container.querySelector(".way.drop")!.className).toContain("over");

    fireEvent.dragLeave(drop);
    expect(container.querySelector(".way.drop")!.className).not.toContain("over");
  });

  it("offers a device picker only when there is a choice to make", async () => {
    const { unmount } = renderLanding();
    await waitFor(() =>
      expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled(),
    );
    expect(screen.queryByLabelText("Input device")).not.toBeInTheDocument();
    unmount();

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "audioinput", deviceId: "a", label: "Built-in Microphone" },
      { kind: "audioinput", deviceId: "b", label: "BlackHole 2ch" },
    ]);
    renderLanding();
    const picker = await screen.findByLabelText("Input device");
    expect(picker).toBeInTheDocument();
    // A loopback device is an ordinary input to the browser, which is what
    // makes keying an app on the same machine work at all.
    expect(screen.getByRole("option", { name: "BlackHole 2ch" })).toBeInTheDocument();
  });

  it("explains blank device names rather than showing a list of them", async () => {
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "audioinput", deviceId: "a", label: "" },
      { kind: "audioinput", deviceId: "b", label: "" },
    ]);
    renderLanding();
    // The browser withholds labels until permission is granted; that is not a
    // bug, but a list of blanks is useless without saying why.
    expect(await screen.findByText(/once you have allowed/i)).toBeInTheDocument();
  });
});
