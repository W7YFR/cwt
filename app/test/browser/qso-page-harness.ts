/* The QSO page, end to end, in real audio: what qso.browser.test.ts uses.
 *
 * The microphone is a keyer: a tone the test keys any text into while the
 * page runs. So a test can work a whole QSO the way a person does: call CQ,
 * read what the station sent, answer it, and look at the page at each turn.
 * The decoder worker, the script and the player are the real ones. The pure
 * tier tests the script's answers one over at a time. This is the test that
 * they come together in the right order on the page.
 *
 * A QSO here plays in real time. The other QSO tests use qso-rig.tsx, on a
 * fake clock.
 */

import { afterEach, beforeEach, expect } from "vitest";
import { userEvent } from "vitest/browser";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { keyingPlan } from "@/audio/synth";
import { savePrefs, type Prefs } from "@/io/storage";
import { targetTiming } from "@/timing";
import { QsoScreen } from "@/ui/QsoScreen";
import "@/ui/base.css";

/** Fast enough that a QSO fits in a test, slow enough to copy cleanly. Even
 *  so, a Short QSO runs most of a minute: the station's exchange alone is some
 *  fifty characters, and each over waits two seconds after its K. */
export const WPM = 45;

/** Long enough for a whole QSO. */
export const QSO_MS = 120_000;

export { EXCHANGE } from "../qso-rig";

/** A stream the test keys text into. */
function keyer(): { key(text: string): Promise<void>; restore(): void } {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 600;
  const gate = ctx.createGain();
  gate.gain.value = 0;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gate).connect(dest);
  osc.start();
  const was = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = () => Promise.resolve(dest.stream);
  return {
    async key(text) {
      let t = ctx.currentTime + 0.1;
      for (const [on, sec] of keyingPlan(text, targetTiming(WPM, WPM))) {
        gate.gain.setValueAtTime(on ? 0.5 : 0, t);
        t += sec;
      }
      gate.gain.setValueAtTime(0, t);
      await wait((t - ctx.currentTime) * 1000);
    },
    restore() {
      navigator.mediaDevices.getUserMedia = was;
      void ctx.close();
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let mic: ReturnType<typeof keyer>;
let errors: string[];

/** Key `text` into the microphone, and wait until it has played. */
export const key = (text: string): Promise<void> => mic.key(text);

/** Time passing, inside act, so the page's updates land in it. */
export const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** Wait until `ok` holds, or fail saying `what`. */
export async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    if (ok()) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
export const status = () => $(".qsostatus")?.textContent ?? "";
export const note = () => $(".qsonote")?.textContent ?? "";
/** Where the page is, as its heading's `data-state` says: ready, sending,
 *  waiting, receiving, paused or over. */
export const state = () => $('[data-testid="qso-state"]')?.dataset.state ?? "";
export const theirs = () => $$(".qsolog li.them");
/** The session has stopped: Start is back, as at the end of a QSO. */
export const ended = () => $('[data-testid="qso-start"]') !== null;
/** Your turn to send. */
export const yourTurn = () => state() === "sending";

export async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "a control to click").not.toBeNull();
  await act(async () => el!.click());
}

/** Mount the page with these choices and press Start. */
export async function open(prefs: Prefs): Promise<void> {
  mount(prefs);
  await until("the Start button", () => {
    const b = $<HTMLButtonElement>('[data-testid="qso-start"]');
    return !!b && !b.disabled;
  });
  await click($('[data-testid="qso-start"]'));
  await until("the session to start", () => yourTurn());
  // A moment before the first over, as a person takes. Keyed the instant the
  // device opens, the first character can come out wrong under load.
  await wait(500);
}

/** Mount the page with these choices. */
export function mount(prefs: Prefs): void {
  savePrefs({ charWpm: WPM, farnsworthWpm: WPM, qsoLength: "short", ...prefs });
  act(() =>
    root.render(
      createElement(QsoScreen, {
        deviceId: undefined,
        onDeviceChange: () => {},
        profiles: [],
        profileId: undefined,
        onProfileChange: () => {},
        onCalibrate: () => {},
        onError: (m: string) => errors.push(m),
        onConfigure: () => {},
        onPage: () => {},
        onHome: () => {},
      }),
    ),
  );
}

/** Key `text`, then wait for the station's answer and for the turn to come
 *  back. Returns the station's over, as a line of the log. */
export async function send(text: string): Promise<HTMLElement> {
  const before = theirs().length;
  await mic.key(text);
  await until(`an answer to ${text}`, () => theirs().length > before);
  await until("the turn to come back", () => yourTurn());
  return theirs()[theirs().length - 1]!;
}

/** The station's call, read off an over that shows whole. */
export function callIn(line: HTMLElement): string {
  const text = line.querySelector(".text")?.textContent ?? "";
  const call = text.split(" ").find((w) => /^[A-Z0-9]?[A-Z]\d[A-Z]+$/.test(w) && w !== "W7YFR");
  expect(call, `a call in "${text}"`).toBeDefined();
  return call!;
}

/** A fresh page and microphone for each test in the file that calls this. */
export function useQsoPage(): void {
  beforeEach(async () => {
    // A real click first: the browser holds audio until a gesture.
    const go = document.createElement("button");
    go.textContent = "go";
    document.body.append(go);
    await userEvent.click(go);
    go.remove();

    localStorage.clear();
    errors = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mic = keyer();
  });

  afterEach(async () => {
    const stop = $<HTMLButtonElement>('[data-testid="qso-stop"]');
    if (stop) await click(stop);
    act(() => root.unmount());
    host.remove();
    mic.restore();
    localStorage.clear();
    expect(errors, "errors the page reported").toEqual([]);
  });
}
