/* The first screen: the front door. */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as mic from "@/capture/mic";
import { Landing } from "@/ui/Landing";
import { WORDMARKS, wordmarkText } from "@/ui/wordmarks";
import { resetVisitRoll } from "@/ui/wordmarks";

function renderLanding(overrides: Partial<React.ComponentProps<typeof Landing>> = {}) {
  const props = {
    onPractice: vi.fn(),
    onFile: vi.fn(),
    onError: vi.fn(),
    deviceId: undefined,
    onDeviceChange: vi.fn(),
    profiles: [],
    profileId: undefined,
    onCalibrate: vi.fn(),
    ...overrides,
  };
  return { ...render(<Landing {...props} />), props };
}

/** One microphone, named. The browser withholds names until permission has
 *  been granted, so a named list is how the page knows it is past that gate. */
const GRANTED = [
  { deviceId: "default", kind: "audioinput", label: "Built-in Microphone", groupId: "g" },
];

/** What a browser hands back before it has been allowed the microphone: the
 *  inputs are there, with the names stripped off. */
const UNGRANTED = [{ deviceId: "", kind: "audioinput", label: "", groupId: "" }];

function mockDevices(devices: unknown[]) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(devices),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

beforeEach(() => {
  // jsdom has no media devices at all, so every test says what it wants the
  // browser to be. Granted is the default.
  mockDevices(GRANTED);
});

/* The device lookup is an effect that resolves a promise. Waiting for its
 * answer keeps the assertions honest about what has rendered. */
async function settled() {
  await waitFor(() =>
    expect(
      screen.queryByTestId("mic-name") ??
        screen.queryByLabelText("Input device") ??
        screen.queryByTestId("grant-mic") ??
        screen.queryByTestId("mic-denied"),
    ).not.toBeNull(),
  );
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

  describe("the way in", () => {
    it("is the first control on the screen", async () => {
      renderLanding();
      await settled();
      // Before the calibration line, the file link and anything else. The
      // callsign in the corner is a link out, not a control on this screen.
      const first = screen.getAllByRole("button")[0];
      expect(first).toBe(screen.getByTestId("practice"));
      expect(first).toHaveTextContent(/start practicing/i);
    });

    it("opens the practice screen", async () => {
      const user = userEvent.setup();
      const { props } = renderLanding();
      await settled();
      await user.click(screen.getByTestId("practice"));
      expect(props.onPractice).toHaveBeenCalledTimes(1);
    });

    it("opens on Enter, from nowhere in particular", async () => {
      const user = userEvent.setup();
      const { props } = renderLanding();
      await settled();
      await user.keyboard("{Enter}");
      expect(props.onPractice).toHaveBeenCalledTimes(1);
    });

    it("leaves Enter to a control that has the focus", async () => {
      // Enter on Calibrate calibrates. Taking the key from it would do
      // something other than what the focus ring says.
      const user = userEvent.setup();
      const { props } = renderLanding();
      await settled();
      screen.getByRole("button", { name: /^calibrate$/i }).focus();
      await user.keyboard("{Enter}");
      expect(props.onCalibrate).toHaveBeenCalledTimes(1);
      expect(props.onPractice).not.toHaveBeenCalled();
    });

    it("leaves Enter alone while the help is open", async () => {
      const user = userEvent.setup();
      const { props } = renderLanding();
      await settled();
      await user.click(screen.getByTestId("sound-path-open"));
      await user.keyboard("{Enter}");
      expect(props.onPractice).not.toHaveBeenCalled();
    });

    it("asks nothing else first", async () => {
      // Recording and the intended message are on the practice screen.
      renderLanding();
      await settled();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: /start recording/i })).toBeNull();
    });
  });

  describe("opening a recording", () => {
    it("is a link, not a card", async () => {
      renderLanding();
      await settled();
      const open = screen.getByRole("button", { name: /open a recording/i });
      expect(open).toHaveClass("link");
    });

    it("hands a file picked from the dialog up to be opened", async () => {
      const user = userEvent.setup();
      const { props, container } = renderLanding();
      await settled();
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File(["x"], "take.wav", { type: "audio/wav" });
      await user.upload(input, file);
      expect(props.onFile).toHaveBeenCalledWith(file);
    });
  });

  describe("the way back to the site this one lives on", () => {
    /* The tests run on the dev server's terms — `import.meta.env.DEV` is true
       under vitest — so the built page is the case that has to be asked for.
       Both are asked for here: which of them is being described is the whole
       difference between the two tests below. */
    const asBuilt = () => vi.stubEnv("DEV", false);

    afterEach(() => vi.unstubAllEnvs());

    it("draws the callsign, and points it home", async () => {
      asBuilt();
      renderLanding();
      await settled();
      const link = document.querySelector<HTMLAnchorElement>("a.callsign")!;
      expect(link, "the callsign is a link").toBeTruthy();
      expect(link.getAttribute("href")).toBe("https://www.w7yfr.com");
      expect(link.getAttribute("aria-label")).toMatch(/W7YFR/);
    });

    it("goes nowhere on the dev server", async () => {
      /* It sits in the corner a thumb reaches for, and following it on a phone
         means leaving the LAN for the public site — with the way back being an
         address with a port in it, retyped. The drawing stays; only the
         destination goes.

         Not an `<a>` without an href either: that is still announced as a link
         and then does nothing. */
      renderLanding();
      await settled();
      expect(document.querySelector("a.callsign")).toBeNull();
      const mark = document.querySelector<HTMLElement>(".callsign")!;
      expect(mark, "the drawing is still there").toBeTruthy();
      expect(mark.getAttribute("role")).toBe("img");
      expect(mark.getAttribute("aria-label")).toMatch(/W7YFR/);
    });

    it("says the name rather than reading the drawing out", async () => {
      renderLanding();
      await settled();
      /* Six rows of box-drawing characters read aloud one at a time is not a
         name. Whatever wraps the art carries it; the art is scenery. */
      const art = document.querySelector<HTMLElement>(".callsign .art")!;
      expect(art.getAttribute("aria-hidden")).toBe("true");
      expect(art.textContent).toContain("█");
    });

    it("keeps the drawing a rectangle, which is what sizes it", async () => {
      renderLanding();
      await settled();
      /* Every row padded to one width, so `--cols` is as wide as the block
         looks — the font size is derived from it. A row truncated in an edit
         shows up here rather than as a letter quietly out of place. */
      const art = document.querySelector<HTMLElement>(".callsign .art")!;
      const rows = art.textContent!.split("\n");
      expect(new Set(rows.map((r) => r.length)).size, "rows differ in width").toBe(1);
      expect(art.style.getPropertyValue("--rows")).toBe(String(rows.length));
      expect(art.style.getPropertyValue("--cols")).toBe(String(rows[0]!.length));
    });
  });

  /* Before the browser has said yes, the inputs are there but anonymous — so
     the picker has nothing to show and the record button would be doing two
     things at once. This is the screen that separates them. */
  describe("the microphone", () => {
    it("names the one input there is", async () => {
      // Calibrating means nothing without knowing which input it is for.
      renderLanding();
      await settled();
      expect(screen.getByTestId("mic-name")).toHaveTextContent("Built-in Microphone");
      expect(screen.queryByLabelText("Input device")).toBeNull();
    });

    it("offers a choice where there is one", async () => {
      mockDevices([
        { kind: "audioinput", deviceId: "a", label: "Built-in Microphone", groupId: "g" },
        { kind: "audioinput", deviceId: "b", label: "BlackHole 2ch", groupId: "g" },
      ]);
      const user = userEvent.setup();
      const { props } = renderLanding();
      await settled();
      await user.selectOptions(screen.getByLabelText("Input device"), "b");
      expect(props.onDeviceChange).toHaveBeenCalledWith("b");
    });

    it("never records from it", async () => {
      const start = vi.spyOn(mic, "startRecording");
      const user = userEvent.setup();
      renderLanding();
      await settled();
      await user.keyboard("r");
      expect(start).not.toHaveBeenCalled();
    });

    describe("before access has been granted", () => {
      it("asks, and offers no choice while the names are withheld", async () => {
        mockDevices(UNGRANTED);
        renderLanding();
        await settled();
        expect(screen.getByTestId("grant-mic")).toBeInTheDocument();
        expect(screen.queryByLabelText("Input device")).toBeNull();
      });

      it("asks without recording anything", async () => {
        mockDevices(UNGRANTED);
        const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
        const stop = vi.fn();
        getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
        const start = vi.spyOn(mic, "startRecording");
        const user = userEvent.setup();
        renderLanding();
        await settled();
        await user.click(screen.getByTestId("grant-mic"));
        // A stream opened only to be told yes, and handed straight back.
        expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(stop).toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
      });

      it("shows the picker once the names arrive", async () => {
        mockDevices(UNGRANTED);
        const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
        getUserMedia.mockImplementation(async () => {
          (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
            { kind: "audioinput", deviceId: "a", label: "Built-in Microphone", groupId: "g" },
            { kind: "audioinput", deviceId: "b", label: "BlackHole 2ch", groupId: "g" },
          ]);
          return { getTracks: () => [{ stop: vi.fn() }] };
        });
        const user = userEvent.setup();
        renderLanding();
        await settled();
        await user.click(screen.getByTestId("grant-mic"));
        expect(await screen.findByLabelText("Input device")).toBeInTheDocument();
        expect(screen.queryByTestId("grant-mic")).toBeNull();
      });

      it("says so, and stops asking, once the browser has refused", async () => {
        mockDevices(UNGRANTED);
        (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
          new DOMException("Permission denied", "NotAllowedError"),
        );
        const user = userEvent.setup();
        const { props } = renderLanding();
        await settled();
        await user.click(screen.getByTestId("grant-mic"));
        expect(await screen.findByTestId("mic-denied")).toHaveTextContent(/blocked/i);
        expect(screen.queryByTestId("grant-mic")).toBeNull();
        expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(/denied/i));
        // A file does not need a microphone.
        expect(screen.getByRole("button", { name: /open a recording/i })).toBeInTheDocument();
      });
    });
  });

  describe("the calibration line", () => {
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

    it("says so, and offers to calibrate, when nothing has been calibrated", async () => {
      const { props } = renderLanding();
      await settled();
      expect(screen.getByTestId("calstatus").dataset.state).toBe("none");
      const buttons = screen.getAllByRole("button");
      const calibrate = buttons.find((b) => b.textContent?.match(/calibrat/i))!;
      await userEvent.click(calibrate);
      expect(props.onCalibrate).toHaveBeenCalled();
    });

    it("names the one in use, with what it measured", async () => {
      // The number belongs beside the name: two positions of one microphone
      // have equally plausible names and nothing alike in their measurements.
      renderLanding({ profiles: [PROFILE], profileId: "p1", deviceId: "webcam" });
      await settled();
      expect(screen.getByTestId("calstatus").dataset.state).toBe("active");
      expect(screen.getByTestId("calname").textContent).toBe(PROFILE.nickname);
      const numbers = screen.getByTestId("calnum").textContent!;
      expect(numbers).toContain((PROFILE.releaseOffsetSec * 1000).toFixed(1));
      expect(numbers).toContain(PROFILE.verdict);
    });

    it("flags a profile in use that was measured on another input", async () => {
      // The exact mistake named profiles exist to prevent.
      renderLanding({ profiles: [PROFILE], profileId: "p1", deviceId: "yeti" });
      await settled();
      expect(screen.getByTestId("calstatus").dataset.state).toBe("elsewhere");
    });

    describe("what the app is listening through", () => {
      /* Offered beside calibration because that is where somebody first
         wonders, and the answer is often that they should not be calibrating
         at all. It reads and closes and changes nothing — the only thing that
         can go wrong is a way in with no way back out. */
      it("opens from the calibration panel and gives the screen back", async () => {
        const user = userEvent.setup();
        renderLanding();
        await settled();
        expect(screen.queryByTestId("sound-path")).toBeNull();

        await user.click(screen.getByTestId("sound-path-open"));
        expect(screen.getByTestId("sound-path")).toBeTruthy();

        await user.click(screen.getByTestId("sound-path-close"));
        expect(screen.queryByTestId("sound-path")).toBeNull();
      });

      it("closes on Escape, like every other sheet", async () => {
        const user = userEvent.setup();
        renderLanding();
        await settled();
        await user.click(screen.getByTestId("sound-path-open"));
        // Focus has to be inside it or the key never reaches the handler.
        expect(screen.getByTestId("sound-path")).toBe(document.activeElement);
        await user.keyboard("{Escape}");
        expect(screen.queryByTestId("sound-path")).toBeNull();
      });

      it("leaves the calibration alone", async () => {
        // A page to read. Nothing in it is a control over the recording.
        const user = userEvent.setup();
        const { props } = renderLanding({ profiles: [PROFILE], profileId: "p1" });
        await settled();
        await user.click(screen.getByTestId("sound-path-open"));
        await user.click(screen.getByTestId("sound-path-close"));
        expect(props.onCalibrate).not.toHaveBeenCalled();
      });
    });
  });
});
