/* The station's pitch on the QSO page: Station pitch, the range a station's
 * pitch is picked from, one station's pitch set by hand from a line's ⋯, and
 * the sound settings' Preview. See qso-rig.tsx for how the page is driven.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrefs } from "@/io/storage";
import { heard } from "../qso-fakes";
import { $, $$, EXCHANGE, click, closeSettings, mount, open, send, settingsTab, slide, start, until, useQsoRig } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const input = (id: string) => $<HTMLInputElement>(`#${id}`)!;
const lineMores = () => $$('[data-testid="qso-line-more"]');

describe("Station pitch", () => {
  it("is 550 to 750 Hz to start, and a station sends inside it", async () => {
    mount({});
    await settingsTab("sound");
    expect(input("pitch-low").closest('[data-panel="audio"]')).not.toBeNull();
    expect(input("pitch-low").value).toBe("550");
    expect(input("pitch-high").value).toBe("750");
    await closeSettings();
    await start();
    await send("CQ CQ DE W7YFR W7YFR K");
    const hz = heard.tones.at(-1)!;
    expect(hz).toBeGreaterThanOrEqual(550);
    expect(hz).toBeLessThanOrEqual(750);
  });

  it("is kept, and sets the pitch the next station sends at", async () => {
    mount({});
    await settingsTab("sound");
    await slide("pitch-high", 900);
    await slide("pitch-low", 900);
    expect(loadPrefs().stationPitch).toEqual({ lowHz: 900, highHz: 900 });
    // One end never passes the other.
    await slide("pitch-low", 950);
    expect(loadPrefs().stationPitch).toEqual({ lowHz: 900, highHz: 900 });
    await closeSettings();
    await start();
    await send("CQ CQ DE W7YFR W7YFR K");
    expect(heard.tones.at(-1)).toBe(900);
  });
});

describe("one station's pitch, set by hand", () => {
  it("is on the station's lines only, and the station sends at it from its next line", async () => {
    await open({});
    await send("CQ CQ DE W7YFR W7YFR K");
    await click(lineMores()[0]!);
    expect($('[data-testid="qso-station-pitch"]'), "not on your own line").toBeNull();
    await click(lineMores()[1]!);
    await click($('[data-testid="qso-station-pitch"]'));
    expect($('[data-testid="station-pitch"]')).not.toBeNull();
    expect(Number(input("station-pitch-hz").value)).toBe(heard.tones.at(-1));
    await slide("station-pitch-hz", 420);
    await click($('[data-testid="station-pitch-set"]'));
    expect($('[data-testid="station-pitch"]')).toBeNull();
    const lines = heard.tones.length;
    await send(EXCHANGE);
    await until("the station's next line", () => heard.tones.length > lines);
    expect(heard.tones.at(-1)).toBe(420);
  });

  it("is left as it was on Cancel", async () => {
    await open({});
    await send("CQ CQ DE W7YFR W7YFR K");
    const was = heard.tones.at(-1);
    await click(lineMores()[1]!);
    await click($('[data-testid="qso-station-pitch"]'));
    await slide("station-pitch-hz", 420);
    await click($$("[data-testid='station-pitch'] button").find((b) => !b.dataset.testid)!);
    expect($('[data-testid="station-pitch"]')).toBeNull();
    const lines = heard.tones.length;
    await send(EXCHANGE);
    await until("the station's next line", () => heard.tones.length > lines);
    expect(heard.tones.at(-1)).toBe(was);
  });
});

describe("Preview", () => {
  /** Audio enough for the preview: jsdom has none. */
  class FakeContext {
    currentTime = 0;
    destination = {};
    createGain = () => ({ gain: { value: 1 }, connect() {} });
    createBuffer = (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => data };
    };
    createBufferSource = () => ({ buffer: null, loop: false, connect() {}, start: () => void started++, stop: () => void stopped++ });
    resume = async () => {};
    close = async () => {};
  }
  let started = 0;
  let stopped = 0;
  beforeEach(() => {
    started = stopped = 0;
    vi.stubGlobal("AudioContext", FakeContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  const pressed = () => $$("[data-testid^='sound-preview-']").filter((b) => b.getAttribute("aria-pressed") === "true");

  it("plays one of All, Pitch and Band at a time, and stops when Settings closes", async () => {
    mount({ noiseDb: -26 });
    await settingsTab("sound");
    expect(pressed()).toHaveLength(0);
    await click($('[data-testid="sound-preview-all"]'));
    await until("the preview to play", () => started > 0);
    expect(pressed().map((b) => b.dataset.testid)).toEqual(["sound-preview-all"]);
    await click($('[data-testid="sound-preview-band"]'));
    expect(pressed().map((b) => b.dataset.testid)).toEqual(["sound-preview-band"]);
    // A second press stops it.
    await click($('[data-testid="sound-preview-band"]'));
    expect(pressed()).toHaveLength(0);

    await click($('[data-testid="sound-preview-pitch"]'));
    await until("the preview to play", () => started > 1);
    await closeSettings();
    await settingsTab("sound");
    expect(pressed()).toHaveLength(0);
    expect(stopped).toBeGreaterThanOrEqual(started);
  });
});
