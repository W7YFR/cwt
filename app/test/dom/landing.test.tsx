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
    onFile: vi.fn(),
    onError: vi.fn(),
    deviceId: undefined,
    onDeviceChange: vi.fn(),
    profiles: [],
    profileId: undefined,
    onProfileChange: vi.fn(),
    onCalibrate: vi.fn(),
    onPractice: vi.fn(),
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

  it("starts the take over on R, but not while you are typing one", async () => {
    /* R is a letter, and the intended-message box is very likely focused: bound
       the way Enter and Escape are, typing the R of "W7YFR" would throw the
       take away. It gets the guard those two deliberately do without. */
    const restart = vi.fn();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue({
      getTracks: () => [],
    });
    const rec = {
      elapsed: () => 1,
      peek: () => new Float32Array(0),
      stop: vi.fn(),
      cancel: vi.fn(),
      restart,
    };
    vi.spyOn(mic, "startRecording").mockResolvedValue(rec);
    renderLanding();
    await settled();
    await act(async () => {
      screen.getByRole("button", { name: /Start recording/i }).click();
    });

    const field = screen.getByLabelText(/going to send/i);
    await act(async () => {
      fireEvent.keyDown(field, { key: "r" });
    });
    expect(restart, "R in a text field").not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(restart).toHaveBeenCalledTimes(1);

    // And the browser keeps its own reload.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter and Escape alone when there is nothing being recorded", async () => {
    // Otherwise they would be doing something invisible on a page that is
    // mostly a text field. R is the exception, and has its own test below.
    const start = vi.spyOn(mic, "startRecording");
    renderLanding();
    await settled();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter" });
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts a recording on R, under the same guard that starting one over gets", async () => {
    /* One key for one idea: R goes, from here. Nothing to remember about
       which state you are in — it starts a take, and starts a running one
       over. The guard has to hold either way, because the box you are most
       likely typing into is a call sign away from an R. */
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue({
      getTracks: () => [],
    });
    const start = vi.spyOn(mic, "startRecording").mockResolvedValue({
      elapsed: () => 0,
      peek: () => new Float32Array(0),
      stop: vi.fn(),
      cancel: vi.fn(),
      restart: vi.fn(),
    });
    renderLanding();
    await settled();

    const field = screen.getByLabelText(/going to send/i);
    await act(async () => {
      fireEvent.keyDown(field, { key: "r" });
    });
    expect(start, "R in a text field").not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    });
    expect(start, "the browser keeps its own reload").not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(start).toHaveBeenCalledTimes(1);
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

  it("says a recording can be dropped anywhere, not just on the card", async () => {
    renderLanding();
    await settled();
    // Aiming at a particular rectangle is work nobody should have to do; the
    // page answers a drop wherever it lands. See test/dom/filedrop.test.tsx.
    expect(screen.getByText(/drop one anywhere on the page/i)).toBeInTheDocument();
  });

  it("hands a file picked from the dialog up to be opened", async () => {
    const { props } = renderLanding();
    await settled();
    const file = new File(["RIFF"], "take.wav", { type: "audio/wav" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.onFile).toHaveBeenCalledWith(file);
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


  /* Whether a calibration is being applied changes every number the review
     reports, by about the size of the room. Somebody who cannot tell at a
     glance which state they are in is one click from a measurement they will
     misread — and the first report from real use was that the way in was hard
     to find at all. */
  describe("the calibration panel", () => {
    const PROFILE = {
      id: "p1",
      nickname: "close to the rig",
      deviceId: "webcam",
      deviceLabel: "HD Pro Webcam",
      wpm: 15,
      releaseOffsetSec: 0.0131,
      spreadSec: 0.0005,
      elements: 60,
      verdict: "good" as const,
      decaySec: 0.03,
      maxWpm: 30,
      recordedAt: "2026-09-12T10:00:00+00:00",
    };

    it("says so, in a real button, when nothing has been calibrated", async () => {
      const { props } = renderLanding();
      expect(screen.getByTestId("calstatus").dataset.state).toBe("none");
      // A button, not link-shaped text: the first report from real use was
      // that the way in could not be found.
      const buttons = screen.getAllByRole("button");
      const calibrate = buttons.find((b) => b.textContent?.match(/calibrat/i))!;
      await userEvent.click(calibrate);
      expect(props.onCalibrate).toHaveBeenCalled();
      await settled();
    });

    it("names the one in use, with what it measured", async () => {
      // The number belongs beside the name: two positions of one microphone
      // have equally plausible names and nothing alike in their measurements.
      renderLanding({ profiles: [PROFILE], profileId: "p1", deviceId: "webcam" });
      expect(screen.getByTestId("calstatus").dataset.state).toBe("active");
      expect(screen.getByTestId("calname").textContent).toBe(PROFILE.nickname);
      const numbers = screen.getByTestId("calnum").textContent!;
      expect(numbers).toContain((PROFILE.releaseOffsetSec * 1000).toFixed(1));
      expect(numbers).toContain(PROFILE.verdict);
      await settled();
    });

    describe("starting a practice", () => {
    /* Recording without hearing the target first, and without a cursor to keep
       time against, is keying blind — and everything that fixes that lives one
       screen in. This is the door to it. */
    it("opens with a message", async () => {
      const user = userEvent.setup();
      const { props } = renderLanding({ expected: "CQ DE W7YFR" });
      await user.click(screen.getByTestId("practice"));
      expect(props.onPractice).toHaveBeenCalled();
    });

    it("opens without one too", async () => {
      /* The target is built from the intended message and there is little to
         practice against without one — but the box for it is right there on
         the next screen, and a door that will not open is a worse way to say
         so than the room itself saying it. */
      const user = userEvent.setup();
      const { props } = renderLanding({ expected: "" });
      expect(screen.getByTestId("practice")).toBeEnabled();
      await user.click(screen.getByTestId("practice"));
      expect(props.onPractice).toHaveBeenCalled();
    });
  });

    it("flags a profile in use that was measured on another input", async () => {
      // The exact mistake named profiles exist to prevent.
      renderLanding({ profiles: [PROFILE], profileId: "p1", deviceId: "yeti" });
      expect(screen.getByTestId("calstatus").dataset.state).toBe("elsewhere");
      await settled();
    });

    it("offers the saved ones, and no calibration among them", async () => {
      const { props } = renderLanding({ profiles: [PROFILE], profileId: "p1" });
      const select = screen.getByLabelText(/microphone calibration/i);
      await userEvent.selectOptions(select, "");
      expect(props.onProfileChange).toHaveBeenCalledWith(undefined);
      await settled();
    });

    describe("what the app is listening through", () => {
      /* Offered beside calibration because that is where somebody first
         wonders, and the answer is often that they should not be calibrating
         at all. It reads and closes and changes nothing — the only thing that
         can go wrong is a way in with no way back out. */
      it("opens from the calibration panel and gives the screen back", async () => {
        const user = userEvent.setup();
        renderLanding();
        expect(screen.queryByTestId("sound-path")).toBeNull();

        await user.click(screen.getByTestId("sound-path-open"));
        expect(screen.getByTestId("sound-path")).toBeTruthy();

        await user.click(screen.getByTestId("sound-path-close"));
        expect(screen.queryByTestId("sound-path")).toBeNull();
        await settled();
      });

      it("closes on Escape, like every other sheet", async () => {
        const user = userEvent.setup();
        renderLanding();
        await user.click(screen.getByTestId("sound-path-open"));
        // Focus has to be inside it or the key never reaches the handler.
        expect(screen.getByTestId("sound-path")).toBe(document.activeElement);
        await user.keyboard("{Escape}");
        expect(screen.queryByTestId("sound-path")).toBeNull();
        await settled();
      });

      it("leaves the calibration alone", async () => {
        // A page to read. Nothing in it is a control over the recording.
        const user = userEvent.setup();
        const { props } = renderLanding({ profiles: [PROFILE], profileId: "p1" });
        await user.click(screen.getByTestId("sound-path-open"));
        await user.click(screen.getByTestId("sound-path-close"));
        expect(props.onProfileChange).not.toHaveBeenCalled();
        expect(props.onCalibrate).not.toHaveBeenCalled();
        await settled();
      });
    });
  });
});
