/* Clicking through the calibration wizard, end to end.
 *
 * The arithmetic is tested against wav files in the pure tier and is not
 * repeated here. What this covers is everything between a person and that
 * arithmetic: that the prompts come in the right order with pauses between
 * them, that the recording is never stopped and restarted between drills, and
 * that what comes out the far end is a named profile which the decoder then
 * actually applies.
 *
 * The microphone is replaced by a real calibration recording — the one made a
 * few inches from a radio's speaker — so the result on screen is a genuine
 * measurement of a genuine room rather than a fixture invented to match the
 * assertions.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Calibrate, STEPS } from "@/ui/Calibrate";
import { loadProfiles, activeProfile } from "@/io/profiles";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";

const SWEEP = `${DATA_DIR}/ft710-close/ft710-sweep-close-webcam.wav`;
const HAVE = existsSync(SWEEP);

const stop = vi.fn();
const cancel = vi.fn();
const startRecording = vi.fn();
const listInputs = vi.fn();

vi.mock("@/capture/mic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/capture/mic")>()),
  startRecording: (...args: unknown[]) => startRecording(...args),
  listInputs: () => listInputs(),
}));

function clip() {
  const wav = readWav(SWEEP);
  let peak = 0;
  for (const v of wav.samples) peak = Math.max(peak, Math.abs(v));
  return { samples: wav.samples, rate: wav.rate, peak };
}

beforeEach(() => {
  localStorage.clear();
  listInputs.mockResolvedValue([
    { deviceId: "webcam", label: "HD Pro Webcam" },
    { deviceId: "loopback", label: "BlackHole 2ch" },
  ]);
  stop.mockImplementation(() => Promise.resolve(clip()));
  cancel.mockResolvedValue(undefined);
  startRecording.mockImplementation(() =>
    Promise.resolve({
      elapsed: () => 0,
      peek: () => new Float32Array(0),
      stop,
      restart: vi.fn(),
      cancel,
    }),
  );
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
  vi.clearAllMocks();
});

function renderWizard(over: Partial<React.ComponentProps<typeof Calibrate>> = {}) {
  const props = {
    deviceId: "webcam",
    onDeviceChange: vi.fn(),
    onError: vi.fn(),
    onSaved: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { ...render(<Calibrate {...props} />), props };
}

/* The device lookup is an effect that resolves a promise, so its state update
 * lands after a synchronous test body has already asserted — React reports
 * that as an un-acted update. Waiting for it once keeps the output clean. */
async function settled() {
  await waitFor(() => expect(listInputs).toHaveBeenCalled());
}

/** Click through every prompt to the end, which stops the recording. */
async function runThrough(user: ReturnType<typeof userEvent.setup>) {
  for (let i = 0; i < STEPS.length - 1; i++) {
    await user.click(screen.getByRole("button", { name: "Next" }));
  }
  await user.click(screen.getByRole("button", { name: "Done" }));
}

describe.skipIf(!HAVE)("the calibration wizard", () => {
  it("says something about placement before anything is recorded", async () => {
    /* The largest effect measured in this whole effort is where the microphone
       is, so it is said before the first button and not after the last. The
       wording is the author's to change — what this holds is that there is a
       note there at all. */
    renderWizard();
    expect(screen.getByTestId("placement-note").textContent!.length).toBeGreaterThan(20);
    await settled();
  });

  it("asks for the speed, because that is what makes it a measurement", async () => {
    renderWizard();
    const speed = screen.getByLabelText(/keyer speed/i) as HTMLInputElement;
    expect(speed.value).toBe("15");
    await settled();
  });

  it("leads every drill with a rest, so none of them starts unannounced", async () => {
    /* In front rather than between. A drill announced only when its own clock
       starts leaves no time to read it, understand it, and get a hand to the
       paddle — which is exactly how the sequence felt the first time it was
       used for real. */
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));

    // Against the step list itself, so rewording a prompt is not a test change.
    const seen: Array<{ title: string; rest: boolean }> = [];
    for (let i = 0; i < STEPS.length; i++) {
      const heading = screen.getByTestId("prompt");
      seen.push({
        title: heading.textContent!.trim(),
        rest: heading.dataset.rest === "true",
      });
      if (i < STEPS.length - 1) await user.click(screen.getByRole("button", { name: "Next" }));
    }

    expect(seen.map((x) => x.title)).toEqual(STEPS.map((x) => x.title));
    // Rests and drills strictly alternate, beginning with a rest: every drill
    // is announced before its own clock starts.
    expect(seen.map((x) => x.rest)).toEqual(STEPS.map((_, i) => i % 2 === 0));
  });

  it("names the drill it is leading up to, and keeps counting through a rest", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));

    const drills = STEPS.filter((x) => !x.rest);
    for (let i = 0; i < drills.length; i++) {
      // On the rest: the panel names the drill about to start, and the counter
      // already reads that drill's number rather than blanking out.
      expect(screen.getByTestId("upnext").dataset.step).toBe(drills[i]!.key);
      expect(screen.getByTestId("stepcount").dataset.step).toBe(String(i + 1));

      // On the drill itself: same number, no panel.
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByTestId("stepcount").dataset.step).toBe(String(i + 1));
      expect(screen.queryByTestId("upnext")).toBeNull();

      if (i < drills.length - 1) await user.click(screen.getByRole("button", { name: "Next" }));
    }
  });

  it("records once, and does not stop between drills", async () => {
    /* The design the splitter depends on. Six start-stops would produce six
       files, and the quiet between drills — which is how the sections are
       told apart — would not be in any of them. */
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await runThrough(user);

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("measures the room and offers to name it", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await runThrough(user);

    const outcome = await screen.findByTestId("outcome");
    expect(outcome.dataset.usable).toBe("true");
    // A real measurement of a real setup: a few inches from the speaker leaves
    // little enough to correct that it reads as it stands.
    expect(screen.getByTestId("verdict").dataset.verdict).toBe("good");
    expect(screen.getByTestId("nickname")).toBeTruthy();
    // The closing drill asked for a message, so the result has to show what it
    // made of it.
    expect(screen.getByTestId("readback-text").textContent).toBe("CQ DE W7YFR");
  });

  it("saves under the name given, and starts applying it", async () => {
    const user = userEvent.setup();
    const { props } = renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await runThrough(user);
    await screen.findByTestId("outcome");

    await user.type(screen.getByTestId("nickname"), "close to the rig");
    await user.click(screen.getByRole("button", { name: /save and use it/i }));

    const saved = loadProfiles();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.nickname).toBe("close to the rig");
    expect(saved[0]!.deviceId).toBe("webcam");
    expect(saved[0]!.wpm).toBe(15);
    // Saving selects it: a calibration nobody is using is a calibration that
    // did nothing.
    expect(activeProfile()?.id).toBe(saved[0]!.id);
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ nickname: "close to the rig" }));
  });

  it("falls back to the device and the date when no name is given", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await runThrough(user);
    await screen.findByTestId("outcome");
    await user.click(screen.getByRole("button", { name: /save and use it/i }));

    // The generated name is a format this code owns, not copy — it has to
    // carry the device and the day so two entries can be told apart.
    const name = loadProfiles()[0]!.nickname;
    expect(name).toContain("HD Pro Webcam");
    expect(name).toContain(new Date().toISOString().slice(0, 10));
  });

  it("refuses, and says what to change, when the recording cannot be measured", async () => {
    // Silence: nothing was keyed at all.
    stop.mockImplementation(() =>
      Promise.resolve({ samples: new Float32Array(8000 * 20), rate: 8000, peak: 0 }),
    );
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await runThrough(user);

    expect((await screen.findByTestId("outcome")).dataset.usable).toBe("false");
    expect(screen.getByRole("alert").dataset.reason).toBe("no-keying");
    // No name field, because there is nothing to name.
    expect(screen.queryByTestId("nickname")).toBeNull();
    expect(loadProfiles()).toEqual([]);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("throws the recording away when cancelled", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start calibrating/i }));
    await user.click(screen.getByRole("button", { name: "cancel" }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(stop).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /start calibrating/i })).toBeTruthy();
  });
});
