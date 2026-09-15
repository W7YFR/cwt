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
 *
 * The sequence is driven by the recorder's clock, which is the only way it can
 * be driven: the drills are timed rather than clicked through, so there is no
 * button that advances a step. The mocked recorder's level callback is held
 * onto and the time
 * is fed in, which is exactly what the real one does a few times a second.
 * Nothing here schedules anything of its own — the boundaries come from the
 * step list, so the drills can be re-timed without touching this file.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BOUNDS, Calibrate, STEPS, TOTAL_SEC } from "@/ui/Calibrate";
import { DRILLS, cueCount } from "@/io/calibration";
import { loadProfiles, activeProfile } from "@/io/profiles";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";

const SWEEP = `${DATA_DIR}/ft710-close/ft710-sweep-close-webcam.wav`;
/** The same sweep captured through the loopback: nothing in the path at all. */
const LOOPBACK = `${DATA_DIR}/ft710-close/ft710-sweep-close-virtual.wav`;
const HAVE = existsSync(SWEEP) && existsSync(LOOPBACK);

const stop = vi.fn();
const cancel = vi.fn();
const restart = vi.fn();
const startRecording = vi.fn();
const listInputs = vi.fn();

/** The recorder's level callback, as handed to it by the component. */
let report: ((peak: number, seconds: number) => void) | null = null;

/** Move the recorder's clock to `seconds` since the recording began. */
async function clockTo(seconds: number) {
  await act(async () => {
    report?.(0.4, seconds);
  });
}

const TOTAL = TOTAL_SEC;

/* The preview is a canvas, and jsdom has none.
 *
 * Stubbed rather than worked around, because the seam is the point: everything
 * else on the result screen is ordinary DOM and belongs in this tier, and the
 * drawing belongs in the browser tier where a real canvas exists. What is
 * asserted here is that the preview is given the recording and the text — not
 * what it draws with them. */
const preview = vi.fn();
vi.mock("@/ui/CalPreview", () => ({
  CalPreview: (props: { expected: string }) => {
    preview(props);
    return <div data-testid="calpreview" data-expected={props.expected} />;
  },
}));

vi.mock("@/capture/mic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/capture/mic")>()),
  startRecording: (...args: unknown[]) => startRecording(...args),
  listInputs: () => listInputs(),
}));

function clip(path = SWEEP) {
  const wav = readWav(path);
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
  report = null;
  startRecording.mockImplementation((options: { onLevel?: typeof report } = {}) => {
    report = options.onLevel ?? null;
    return Promise.resolve({
      elapsed: () => 0,
      peek: () => new Float32Array(0),
      stop,
      restart,
      cancel,
    });
  });
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

const PROFILE = {
  id: "p1",
  nickname: "shack desk",
  deviceId: "webcam",
  deviceLabel: "HD Pro Webcam",
  wpm: 15,
  releaseOffsetSec: 0.013,
  spreadSec: 0.0004,
  elements: 120,
  verdict: "good" as const,
  decaySec: 0.03,
  maxWpm: 30,
  recordedAt: "2026-09-01T10:00:00+00:00",
};

function renderWizard(over: Partial<React.ComponentProps<typeof Calibrate>> = {}) {
  const props = {
    current: null,
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

/** Let the clock run out on every prompt, which stops the recording. */
async function runThrough() {
  for (const at of BOUNDS) await clockTo(at);
}

/** Start recording, and wait for the device to actually be open — the clock
 *  does not move, and no step advances, until it is. */
async function begin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /start calibrating/i }));
  await waitFor(() => expect(startRecording).toHaveBeenCalled());
}

describe.skipIf(!HAVE)("the calibration wizard", () => {
  it("says what it is for before anything is recorded", async () => {
    /* A calibration is the second-best way to use this and the screen says so
       before the first button, not after the last. The wording is the
       author's to change — what this holds is that there is a note there at
       all. */
    renderWizard();
    expect(screen.getByTestId("setup-note").textContent!.length).toBeGreaterThan(40);
    await settled();
  });

  it("lists the whole sequence, in the order it will be asked for", async () => {
    /* Against the drill list rather than against the words, so re-timing or
       reordering the sequence updates the promise on this screen by
       construction. Nothing on the preamble is retyped beside the constants
       the recording actually runs on. */
    renderWizard();
    const items = [...screen.getByTestId("drilllist").querySelectorAll("li")];
    expect(items.map((li) => li.dataset.step)).toEqual(DRILLS.map((d) => d.key));
    await settled();
  });

  it("asks for the speed, because that is what makes it a measurement", async () => {
    renderWizard();
    const speed = screen.getByLabelText(/keyer speed/i) as HTMLInputElement;
    expect(speed.value).toBe("15");
    await settled();
  });

  it("remembers the keyer speed, which belongs to the equipment", async () => {
    /* Retyping it is the sort of friction that stops somebody recalibrating
       after they have moved the microphone — which is the one moment a
       calibration most needs redoing. */
    const user = userEvent.setup();
    const first = renderWizard();
    const speed = screen.getByLabelText(/keyer speed/i);
    await user.clear(speed);
    await user.type(speed, "22");
    await begin(user);
    first.unmount();

    renderWizard();
    expect((screen.getByLabelText(/keyer speed/i) as HTMLInputElement).value).toBe("22");
    await settled();
  });

  it("says it is making a new calibration rather than replacing the one in use", async () => {
    /* Nothing is ever overwritten — `save` mints a fresh id every time — and
       the word "recalibrate" implies the opposite. A calibration is a
       measurement of a microphone in a position, and replacing one in place
       would change the numbers behind every report already produced under it. */
    renderWizard({ current: PROFILE });
    expect(screen.getByTestId("keeps-current").textContent).toContain(PROFILE.nickname);
    renderWizard({ current: null });
    expect(screen.queryAllByTestId("keeps-current")).toHaveLength(1);
    await settled();
  });

  it("leads every drill with a rest, so none of them starts unannounced", async () => {
    /* In front rather than between. A drill announced only when its own clock
       starts leaves no time to read it, understand it, and get a hand to the
       paddle — which is exactly how the sequence felt the first time it was
       used for real. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);

    // Against the step list itself, so rewording a prompt is not a test change.
    const seen: Array<{ title: string; rest: boolean }> = [];
    for (let i = 0; i < STEPS.length; i++) {
      const heading = screen.getByTestId("prompt");
      seen.push({
        title: heading.textContent!.trim(),
        rest: heading.dataset.rest === "true",
      });
      if (i < STEPS.length - 1) await clockTo(BOUNDS[i]!);
    }

    expect(seen.map((x) => x.title)).toEqual(STEPS.map((x) => x.title));
    // Rests and drills strictly alternate, beginning with a rest: every drill
    // is announced before its own clock starts.
    expect(seen.map((x) => x.rest)).toEqual(STEPS.map((_, i) => i % 2 === 0));
  });

  it("names the drill it is leading up to, and keeps counting through a rest", async () => {
    const user = userEvent.setup();
    renderWizard();
    await begin(user);

    const drills = STEPS.filter((x) => !x.rest);
    for (let i = 0; i < drills.length; i++) {
      // On the rest: the panel names the drill about to start, and the counter
      // already reads that drill's number rather than blanking out.
      expect(screen.getByTestId("upnext").dataset.step).toBe(drills[i]!.key);
      expect(screen.getByTestId("stepcount").dataset.step).toBe(String(i + 1));

      // On the drill itself: same number, no panel.
      await clockTo(BOUNDS[i * 2]!);
      expect(screen.getByTestId("stepcount").dataset.step).toBe(String(i + 1));
      expect(screen.queryByTestId("upnext")).toBeNull();

      if (i < drills.length - 1) await clockTo(BOUNDS[i * 2 + 1]!);
    }
  });

  it("records once, and does not stop between drills", async () => {
    /* The design the splitter depends on. Six start-stops would produce six
       files, and the quiet between drills — which is how the sections are
       told apart — would not be in any of them. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("measures the room and offers to name it", async () => {
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();

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
    await begin(user);
    await runThrough();
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
    await begin(user);
    await runThrough();
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
    await begin(user);
    await runThrough();

    expect((await screen.findByTestId("outcome")).dataset.usable).toBe("false");
    expect(screen.getByRole("alert").dataset.reason).toBe("no-keying");
    // No name field, because there is nothing to name.
    expect(screen.queryByTestId("nickname")).toBeNull();
    expect(loadProfiles()).toEqual([]);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();

    /* And nothing claiming to have judged the setup. A verdict of "unknown"
       reads as a finding on a screen already reporting that something went
       wrong, and it is not one. */
    expect(screen.queryByTestId("verdict")).toBeNull();
    // Nothing to play back either — every section of it is silence.
    expect(screen.queryByTestId("sections")).toBeNull();
  });

  it("offers each stretch of the recording back, named", async () => {
    /* The wizard's own account of what it heard. On a refusal this is the
       most useful thing on the screen: hearing the dah drill play back
       somebody's dits explains "the drills disagree" in a way the number
       cannot. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");

    const buttons = screen.getAllByTestId("section-play");
    expect(buttons.length).toBeGreaterThanOrEqual(DRILLS.length);
    // Named, not numbered — the label is what makes hearing it useful.
    for (const b of buttons) expect(b.textContent!.trim().length).toBeGreaterThan(2);
  });

  it("runs on its own clock, with nothing to skip a step with", async () => {
    /* Every drill is either a measurement or the thing a measurement is
       checked against, so a sequence run halfway produces a refusal rather
       than a shorter answer. Offering "next" and "stop here and measure"
       implied there was a useful result on the other side of them. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);

    for (const name of [/^next$/i, /^done$/i, /stop here/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // Halfway through, still nothing keyed and nothing measured.
    await clockTo(TOTAL / 2);
    expect(stop).not.toHaveBeenCalled();
    // And it finishes itself when the clock runs out, with no click at all.
    await clockTo(TOTAL);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts a second attempt at the beginning, not where the last one ended", async () => {
    /* The regression. `elapsed` is only written by the level callback, so
       after a recording ends it holds that recording's length until the next
       one reports. A wizard scheduling itself against it saw every step
       already out of time and ran the whole sequence in one render — landing
       on the last step with the clock reading the length of the take before
       it. */
    stop.mockImplementation(() =>
      Promise.resolve({ samples: new Float32Array(8000 * 20), rate: 8000, peak: 0 }),
    );
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    expect((await screen.findByTestId("outcome")).dataset.usable).toBe("false");

    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.queryByTestId("stepcount")).not.toBeNull());

    expect(screen.getByTestId("stepcount").dataset.step).toBe("1");
    expect(screen.getByTestId("prompt").dataset.rest).toBe("true");
    expect(screen.getByTestId("upnext").dataset.step).toBe(STEPS[1]!.key);
  });

  it("lets you end the closing message early, and only that one", async () => {
    /* The drills before it are each a measurement or the thing a measurement
       is checked against, so cutting one short would produce a refusal rather
       than a shorter answer. The message feeds no measurement — it is where
       you watch the thing work — so there is nothing to be short of once you
       have run out of things to send. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    const offered = () => screen.queryByTestId("finish-early") !== null;
    expect(offered(), "before anything has been measured").toBe(false);

    for (const at of BOUNDS.slice(0, -2)) {
      await clockTo(at);
      expect(offered(), `at ${at}s`).toBe(false);
    }

    // The last step, which is the closing message.
    await clockTo(BOUNDS[BOUNDS.length - 2]!);
    expect(screen.getByTestId("stepcount").dataset.step).toBe(String(DRILLS.length));
    expect(offered()).toBe(true);

    await user.click(screen.getByTestId("finish-early"));
    // Ended, not abandoned: what was recorded goes off to be measured.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await screen.findByTestId("outcome")).not.toBeNull();
  });

  it("restarts from the lead-in, keeping the device open", async () => {
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await clockTo(BOUNDS[2]!);
    expect(screen.getByTestId("stepcount").dataset.step).toBe("2");

    await user.click(screen.getByRole("button", { name: /restart/i }));

    // Back to the first lead-in, with what was captured thrown away — and no
    // second device open, which would mean a second permission prompt and a
    // gap in the middle of a sequence.
    expect(screen.getByTestId("stepcount").dataset.step).toBe("1");
    expect(screen.getByTestId("prompt").dataset.rest).toBe("true");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("says whether it is your turn, by the same signal throughout", async () => {
    /* Two states, one pair of colors, read out of the corner of an eye by
       somebody looking at a paddle: counting toward a drill is holding off,
       counting through one is sending. The cued drill alternates between the
       same two on every beat rather than inventing a third thing. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);

    const state = () =>
      (screen.queryByTestId("countdown") ?? screen.getByTestId("cue")).dataset.state;

    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i]!;
      /* A rest is always "hold off". An uncued drill is always "send". The
         cued one opens on "hold off" too — there is a cue to wait for — and
         flips on the beat, which is the whole reason it exists. */
      const want = step.rest || step.cueSec ? "waiting" : "sending";
      expect(state(), step.key).toBe(want);
      if (step.cueSec) {
        await clockTo(BOUNDS[i - 1]! + step.cueSec);
        expect(state(), `${step.key} on the beat`).toBe("sending");
      }
      if (i < STEPS.length - 1) await clockTo(BOUNDS[i]!);
    }
  });

  it("calls each dit in the isolated drill instead of leaving you to count", async () => {
    /* The drill the setup verdict is measured from. Asking somebody to keep
       two seconds in their head against a single number counting down gets
       back whatever their sense of two seconds is; calling each one takes the
       guesswork out of the only part of the recording that has to have room
       around every release. */
    const drill = DRILLS.find((d) => d.cueSec)!;
    const at = BOUNDS[STEPS.findIndex((s) => s.key === drill.key) - 1]!;
    const every = drill.cueSec!;

    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await clockTo(at);

    // Before the first call there is something to wait for, not a cue already
    // missed by the time it has been read.
    expect(screen.getByTestId("cue").dataset.cue).toBe("wait");

    const calls = cueCount(drill);
    for (let n = 1; n <= calls; n++) {
      await clockTo(at + n * every);
      const cue = screen.getByTestId("cue");
      expect(cue.dataset.cue, `cue ${n}`).toBe("now");
      expect(cue.dataset.fired).toBe(String(n));

      // Between calls it goes back to counting toward the next one.
      if (n < calls) {
        await clockTo(at + n * every + every * 0.6);
        expect(screen.getByTestId("cue").dataset.cue, `between ${n}`).toBe("wait");
      }
    }

    /* After the last one the call stays up for the rest of the drill rather
       than reverting to a countdown for a dit that is never coming. That
       trailing second is why the drill runs a second past its last cue: a cue
       that vanishes as you act on it is one you are always slightly late
       for. */
    await clockTo(at + calls * every + (drill.seconds - calls * every) * 0.9);
    expect(screen.getByTestId("cue").dataset.cue).toBe("now");
  });

  it("shows the closing message drawn, raw and corrected", async () => {
    /* The readback says whether the decode came out right. A calibration is
       about whether the element *lengths* came out right, and only the chart
       shows that — so the result screen hands the preview the recording it
       just made rather than describing it. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");

    expect(screen.getByTestId("calpreview")).toBeTruthy();
    const given = preview.mock.calls[preview.mock.calls.length - 1]![0];
    expect(given.clip.samples.length).toBeGreaterThan(0);
    expect(given.run.usable).toBe(true);
  });

  it("takes the intended message so the chart has something to aim at", async () => {
    /* The drill asks for "anything you like", so nothing in the recording says
       what was meant. Without it the chart grades against its own decode,
       which still shows the lengths — with it, it shows them against what was
       actually intended. */
    localStorage.setItem(
      "cwt:prefs",
      JSON.stringify({ expected: "CQ DE W7YFR" }),
    );
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");

    // Prefilled from the landing screen: somebody who has typed what they are
    // practicing has almost certainly just sent it again.
    const box = screen.getByTestId("cal-expected") as HTMLInputElement;
    expect(box.value).toBe("CQ DE W7YFR");

    await user.clear(box);
    await user.type(box, "w1aw");
    expect(screen.getByTestId("calpreview").dataset.expected).toBe("W1AW");
  });

  it("lets the measured correction be overridden, and says so", async () => {
    /* For the case an algorithm taking a median cannot handle: noticing the
       answer looks wrong. One control, because a calibration carries four
       numbers and only one of them is an input to anything — the other three
       are evidence about the measurement. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");

    // Behind a disclosure: the measured answer is right nearly always, and a
    // knob on screen invites turning.
    expect(screen.getByTestId("advanced").dataset.open).toBe("false");
    await user.click(screen.getByRole("button", { name: /^advanced$/i }));

    const slider = screen.getByTestId("offset") as HTMLInputElement;
    const asMeasured = slider.value;
    expect(screen.getByTestId("offset-state").dataset.adjusted).toBe("false");

    fireEvent.change(slider, { target: { value: String(Number(asMeasured) + 40) } });
    expect(screen.getByTestId("offset-state").dataset.adjusted).toBe("true");
    // The preview follows it, or the slider is guesswork with extra steps.
    const shown = preview.mock.calls[preview.mock.calls.length - 1]![0];
    expect(shown.run.calibration.releaseOffsetSec).toBeCloseTo(
      (Number(asMeasured) + 40) / 10000,
      6,
    );

    // Saved as what is in force, with what was measured kept beside it, so a
    // report can say which kind of number it leaned on.
    await user.click(screen.getByRole("button", { name: /save and use it/i }));
    const saved = loadProfiles()[0]!;
    expect(saved.releaseOffsetSec).toBeCloseTo((Number(asMeasured) + 40) / 10000, 6);
    /* The measurement is kept exactly as it was measured, not as the slider
       rounded it — the slider moves in tenths of a millisecond and the drills
       do not. */
    expect(Math.round(saved.measuredOffsetSec! * 10000)).toBe(Number(asMeasured));
    expect(saved.measuredOffsetSec).not.toBe(saved.releaseOffsetSec);
  });

  it("takes the correction as a typed number too", async () => {
    /* A slider is the right control for hunting — drag it and watch the chart
       — and the wrong one for landing on a figure you already have in mind,
       which is what somebody comparing two calibrations is doing. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");
    await user.click(screen.getByRole("button", { name: /^advanced$/i }));

    const box = screen.getByTestId("offset-ms") as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "7.5");

    expect(screen.getByTestId("offset-state").dataset.adjusted).toBe("true");
    // The slider follows it: one value, two ways at it.
    expect(Number((screen.getByTestId("offset") as HTMLInputElement).value)).toBe(75);
    const shown = preview.mock.calls[preview.mock.calls.length - 1]![0];
    expect(shown.run.calibration.releaseOffsetSec).toBeCloseTo(0.0075, 6);

    await user.click(screen.getByRole("button", { name: /save and use it/i }));
    expect(loadProfiles()[0]!.releaseOffsetSec).toBeCloseTo(0.0075, 6);
  });

  it("does not fight the caret while a correction is being typed", async () => {
    /* The same trap as the keyer-speed field. A box showing "10.8" that
       rewrote itself to "1.0" the moment "1" was typed would put the next
       digit in the wrong place — so what is being typed stays on screen until
       the field is left. */
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");
    await user.click(screen.getByRole("button", { name: /^advanced$/i }));

    const box = screen.getByTestId("offset-ms") as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "12.4");
    expect(box.value).toBe("12.4");
  });

  it("resets to the measurement, and saves it unmarked", async () => {
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await runThrough();
    await screen.findByTestId("outcome");
    await user.click(screen.getByRole("button", { name: /^advanced$/i }));

    const slider = screen.getByTestId("offset") as HTMLInputElement;
    const asMeasured = slider.value;
    fireEvent.change(slider, { target: { value: String(Number(asMeasured) + 40) } });
    await user.click(screen.getByRole("button", { name: /^reset$/i }));

    expect(screen.getByTestId("offset-state").dataset.adjusted).toBe("false");
    expect((screen.getByTestId("offset") as HTMLInputElement).value).toBe(asMeasured);

    await user.click(screen.getByRole("button", { name: /save and use it/i }));
    const saved = loadProfiles()[0]!;
    expect(saved.releaseOffsetSec).toBe(saved.measuredOffsetSec);
  });

  describe("when there is nothing to correct", () => {
    /* The loopback capture of the same sweep. Not a failure and not a small
       correction — the answer "there is nothing here", which is what every
       direct connection gives and what the app has to stop short of storing.
       A profile whose offset is inside its own noise corrects nothing when
       applied, while every report made under it claims a calibration was in
       force. */
    const measure = async (user: ReturnType<typeof userEvent.setup>) => {
      stop.mockImplementation(() => Promise.resolve(clip(LOOPBACK)));
      const rendered = renderWizard();
      await begin(user);
      await runThrough();
      await screen.findByTestId("outcome");
      return rendered;
    };

    it("says so, and does not offer to save it", async () => {
      const user = userEvent.setup();
      await measure(user);
      const outcome = screen.getByTestId("outcome");
      // Measured, not failed — the distinction the screen has to carry.
      expect(outcome.dataset.usable).toBe("true");
      expect(outcome.dataset.nothing).toBe("true");

      expect(screen.queryByTestId("nickname")).toBeNull();
      expect(screen.queryByRole("button", { name: /save and use it/i })).toBeNull();
      expect(screen.getByRole("button", { name: /^skip$/i })).toBeTruthy();
    });

    it("leaves without storing anything", async () => {
      const user = userEvent.setup();
      const { props } = await measure(user);

      await user.click(screen.getByRole("button", { name: /^skip$/i }));
      expect(loadProfiles()).toEqual([]);
      expect(props.onClose).toHaveBeenCalled();
    });

    it("does not report a correction it is not making", async () => {
      const user = userEvent.setup();
      await measure(user);
      // A "0.0 ms" row is a claim that something was measured and applied.
      expect(screen.queryByText(/moves from the mark to the gap/i)).toBeNull();
    });

    it("still lets one be dialed in deliberately", async () => {
      /* Refusing to store a measurement of nothing is not the same as
         refusing to let somebody set a correction on purpose. The Advanced
         panel is the one place the app's own answer can be overruled, and
         overruling it has to bring saving back. */
      const user = userEvent.setup();
      await measure(user);
      await user.click(screen.getByRole("button", { name: /^advanced$/i }));

      const box = screen.getByTestId("offset-ms") as HTMLInputElement;
      await user.clear(box);
      await user.type(box, "6");

      expect(screen.getByTestId("outcome").dataset.nothing).toBe("false");
      expect(screen.getByTestId("nickname")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: /save and use it/i }));
      expect(loadProfiles()[0]!.releaseOffsetSec).toBeCloseTo(0.006, 6);
    });
  });

  it("throws the recording away when canceled", async () => {
    const user = userEvent.setup();
    renderWizard();
    await begin(user);
    await user.click(screen.getByRole("button", { name: "cancel" }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(stop).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /start calibrating/i })).toBeTruthy();
  });
});
