/* The band on the QSO page: QSB, noise, QRN and QRM, where the station's
 * lines play it, and the recorder's gate that cuts it as you key. See
 * qso-rig.tsx for how the page is driven.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { NOISE_OFF_DB } from "@/audio/qsb";
import { QRM_OFF_DB } from "@/copy/band";
import { loadPrefs } from "@/io/storage";
import { heard } from "../qso-fakes";
import { $, EXCHANGE, click, ended, key, mount, open, send, slide, theirs, until, useQsoRig, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const input = (id: string) => $<HTMLInputElement>(`#${id}`)!;

describe("the band's settings", () => {
  it("are in the Audio settings, off to start, and kept", async () => {
    mount({});
    await click($('[data-testid="panel-toggle"]'));
    for (const id of ["qsb", "noise", "qrn", "qrm", "break-in", "qso-band-noise"]) {
      expect(input(id).closest('[data-panel="audio"]'), id).not.toBeNull();
    }
    expect(input("qsb").value).toBe("0");
    expect(input("noise").value).toBe(String(NOISE_OFF_DB));
    expect(input("qrn").value).toBe("0");
    expect(input("qrm").value).toBe(String(QRM_OFF_DB));
    expect(input("break-in").value).toBe("800");
    expect(input("qso-band-noise").checked).toBe(true);

    // With nothing in the band, there is no band to play or to cut.
    expect(input("qso-band-noise").disabled).toBe(true);
    expect(input("break-in").disabled).toBe(true);

    await slide("noise", -26);
    expect(loadPrefs().noiseDb).toBe(-26);
    expect(input("qso-band-noise").disabled).toBe(false);
    expect(input("break-in").disabled).toBe(false);

    // The delay is the band's between lines: off with it.
    await click(input("qso-band-noise"));
    expect(loadPrefs().qsoBandNoise).toBe(false);
    expect(input("break-in").disabled).toBe(true);
    await click(input("qso-band-noise"));

    await slide("break-in", 300);
    expect(loadPrefs().qsoBreakInMs).toBe(300);
    await slide("qsb", 12);
    await slide("qrn", 2);
    await slide("qrm", -20);
    expect(loadPrefs()).toMatchObject({ qsbDb: 12, qrn: 2, qrmDb: -20 });
  });
});

describe("the band in a QSO", () => {
  it("is not there with everything off", async () => {
    await open({});
    await send("CQ CQ DE W7YFR W7YFR K");
    expect(heard.gate.band).toBeNull();
    const air = heard.airs.at(-1);
    expect(air?.fade).toBeUndefined();
    expect(air?.band).toBeUndefined();
  });

  it("plays from the recorder all through, cut as you key for the break-in delay", async () => {
    await open({ noiseDb: -26, qsoBreakInMs: 300, gainDb: 6 });
    await until("the band", () => heard.gate.band !== null);
    expect(heard.gate.band!.samples.some((x) => x !== 0)).toBe(true);
    expect(heard.gate.delaySec).toBeCloseTo(0.3);
    expect(heard.gate.level).toBeCloseTo(Math.pow(10, 6 / 20));
    // Armed while the page listens for you.
    expect(yourTurn()).toBe(true);
    expect(heard.gate.armed).toBe(true);

    await send("CQ CQ DE W7YFR W7YFR K");
    // The station's line does not carry the band: the recorder plays it.
    expect(heard.airs.at(-1)?.band).toBeUndefined();
    expect(heard.gate.band).not.toBeNull();
  });

  it("comes with each of the station's lines, and its fading, when not played between them", async () => {
    await open({ noiseDb: -26, qsbDb: 12, qsoBandNoise: false });
    await send("CQ CQ DE W7YFR W7YFR K");
    expect(heard.gate.band).toBeNull();
    const air = heard.airs.at(-1)!;
    expect(air.band?.samples.some((x) => x !== 0)).toBe(true);
    const fade = air.fade!.fade;
    for (let t = 0; t < 60; t += 0.5) {
      expect(fade(t)).toBeLessThanOrEqual(1);
      expect(fade(t)).toBeGreaterThanOrEqual(Math.pow(10, -12 / 20) - 1e-9);
    }
  });
});

describe("downloading a QSO", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The names of the files saved, as the page hands them to the browser. */
  function saved(): string[] {
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    return names;
  }

  /** A whole QSO, to its end. */
  async function qso(prefs: Parameters<typeof open>[0]): Promise<void> {
    await open(prefs);
    await send("CQ CQ DE W7YFR W7YFR K");
    await send(EXCHANGE);
    const before = theirs().length;
    await key("R TNX 73 <SK>");
    await until("the last over", () => theirs().length > before);
    await until("the session to stop", ended);
  }

  it("offers only Download with nothing added", async () => {
    await qso({});
    expect($('[data-testid="qso-download"]')).not.toBeNull();
    expect($('[data-testid="qso-download-heard"]')).toBeNull();
  });

  /** The share of a 16-bit WAV's samples near silence. */
  const quiet = (wav: ArrayBuffer): number => {
    const pcm = new Int16Array(wav.slice(44));
    let n = 0;
    for (const v of pcm) if (Math.abs(v) < 300) n++;
    return n / pcm.length;
  };

  it("plays the QSO with Play QSO alone, clean, with nothing added", async () => {
    await qso({});
    expect($('[data-testid="qso-play-heard"]')).toBeNull();
    await click($('[data-testid="qso-play"]'));
    expect(quiet(heard.replays.at(-1)!)).toBeGreaterThan(0.2);
  });

  it("plays the QSO clean or as heard, with the band on", async () => {
    await qso({ noiseDb: -12 });
    await click($('[data-testid="qso-play"]'));
    const clean = heard.replays.at(-1)!;
    await click($('[data-testid="qso-play"]'));
    await click($('[data-testid="qso-play-heard"]'));
    const noisy = heard.replays.at(-1)!;
    expect(noisy).not.toBe(clean);
    expect(quiet(clean)).toBeGreaterThan(0.2);
    expect(quiet(noisy), "the band in the gaps").toBeLessThan(quiet(clean) / 2);
  });

  it("offers Download as heard with the band on, and saves both", async () => {
    await qso({ noiseDb: -20, qsbDb: 10 });
    const names = saved();
    await click($('[data-testid="qso-download"]'));
    await click($('[data-testid="qso-download-heard"]'));
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/\.wav$/);
    expect(names[0]).not.toMatch(/as-heard/);
    expect(names[1]).toMatch(/-as-heard\.wav$/);
  });
});
