/* The QSO page, end to end, on a fake clock: what the qso tests
 * share.
 *
 * The microphone is a keyer on the clock (qso-fakes.ts). So a test can work a
 * whole QSO the way a person does: call CQ, read what the station sent,
 * answer it, and look at the page at each turn. The decoder, the script and
 * the page are the real ones. The pure tier tests the script's answers one
 * over at a time. These are the tests that they come together in the right
 * order on the page.
 *
 * Each file that uses this mocks the microphone and the player first:
 *
 *   vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
 *   vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));
 */

import { afterEach, beforeEach, expect, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { savePrefs, type Prefs } from "@/io/storage";
import { QsoScreen } from "@/ui/QsoScreen";
import { keyOnClock, PageWorker, resetKey } from "./qso-fakes";

/** The speed the tests send at. The clock is fake, so this is not about how
 *  long a QSO takes: it is the speed the assertions about QRS count from. */
export const WPM = 45;

/** Your exchange, with no call in it. The station takes it as its own, since
 *  nobody else is on the frequency. */
export const EXCHANGE = "UR 599 NAME BOB QTH SALEM OR KN";

let host: HTMLDivElement;
let root: Root;
let errors: string[];

/** Time passing on the fake clock, inside act, so the page's updates land
 *  in it. */
export const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Wait until `ok` holds, or fail saying `what`. `ms` is on the fake clock. */
export async function until(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    if (ok()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Key `text` into the microphone, and wait until it has been keyed. */
export async function key(text: string): Promise<void> {
  const end = keyOnClock(text, WPM);
  await wait(Math.max(0, end * 1000 - performance.now()));
}

/** The element the page is mounted in. */
export const page = (): HTMLDivElement => host;

export const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
export const status = () => $(".qsostatus")?.textContent ?? "";
export const note = () => $(".qsonote")?.textContent ?? "";
/** Where the page is, as its heading's `data-state` says: ready, sending,
 *  waiting, receiving, paused or over. */
export const state = () => $('[data-testid="qso-state"]')?.dataset.state ?? "";
export const theirs = () => $$(".qsolog li.them");
/** The text of the station's last line, as the page keeps it. Shown or not,
 *  the log the page saves for a reload holds it. */
export const lastSent = (): string => {
  const kept = JSON.parse(localStorage.getItem("cwt:qso") ?? "{}") as { lines?: { you: boolean; text: string }[] };
  return (kept.lines ?? []).filter((l) => !l.you).at(-1)?.text ?? "";
};
/** The session has stopped: Start is back, as at the end of a QSO. */
export const ended = () => $('[data-testid="qso-start"]') !== null;
/** Your turn to send. */
export const yourTurn = () => state() === "sending";

export async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "a control to click").not.toBeNull();
  await act(async () => el!.click());
}

/** Type `text` into a box, over what it held, as an input event would. */
export async function fill(el: HTMLInputElement, text: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    el.focus();
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press a key, as `Enter` or `Escape`, on what has focus. */
export async function press(key: string): Promise<void> {
  const at = document.activeElement ?? document.body;
  await act(async () => {
    at.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    at.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

/** Choose what shows of the station's overs, in the settings: one of the
 *  buttons, by its label. */
export async function showTheirs(label: string): Promise<void> {
  if ($('[data-testid="panel-toggle"]')?.getAttribute("aria-pressed") !== "true") {
    await click($('[data-testid="panel-toggle"]'));
  }
  const button = $$<HTMLButtonElement>('[data-testid="qso-their-text"] button').find(
    (b) => b.textContent === label,
  );
  await click(button ?? null);
  expect(button!.getAttribute("aria-pressed")).toBe("true");
}

/** One row of a graded copy, as read: yours over the station's, each a
 *  column's text, words split where the columns are. */
export function row(graded: Element, side: "yourcopy" | "sentcopy"): string {
  return [...graded.querySelectorAll(".cword")]
    .map((w) => [...w.querySelectorAll(`.${side}`)].map((c) => c.textContent).join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Move the slider `id` to `value`, as a drag would. */
export async function slide(id: string, value: number): Promise<void> {
  const el = $<HTMLInputElement>(`#${id}`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

/** The page goes, without a Stop, as on a reload. Mount it again after. */
export function unmount(): void {
  act(() => root.unmount());
  root = createRoot(host);
}

/** Key `text`, then wait for the station's answer and for the turn to come
 *  back. Returns the station's over, as a line of the log. */
export async function send(text: string): Promise<HTMLElement> {
  const before = theirs().length;
  await key(text);
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

/** A fresh page, microphone and clock for each test in the file that calls
 *  this. */
/** How long one QSO test may run. */
const QSO_TEST_MS = 30_000;

export function useQsoRig(): void {
  /* Each test works a QSO, or most of one, on the fake clock: about a second
     and a half here, and several times that on a loaded CI runner, where the
     default 5 s cut one short. The waits inside allow 60 s; this gives the
     test as a whole room to match. */
  vi.setConfig({ testTimeout: QSO_TEST_MS });
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.stubGlobal("Worker", PageWorker);
    resetKey();

    localStorage.clear();
    errors = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const stop = $<HTMLButtonElement>('[data-testid="qso-stop"]');
    if (stop) await click(stop);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
    expect(errors, "errors the page reported").toEqual([]);
  });
}
