/* The QSO page, end to end.
 *
 * The microphone is a keyer: a tone the test keys any text into while the
 * page runs. So a test can work a whole QSO the way a person does: call CQ,
 * read what the station sent, answer it, and look at the page at each turn.
 * The decoder worker, the script and the player are the real ones. The pure
 * tier tests the script's answers one over at a time. This is the test that
 * they come together in the right order on the page.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { keyingPlan } from "@/audio/synth";
import { loadSpeed, savePrefs, type Prefs } from "@/io/storage";
import { targetTiming } from "@/timing";
import { QsoScreen } from "@/ui/QsoScreen";
import "@/ui/base.css";

/** Fast enough that a QSO fits in a test, slow enough to copy cleanly. Even
 *  so, a Short QSO runs most of a minute: the station's exchange alone is some
 *  fifty characters, and each over waits two seconds after its K. */
const WPM = 45;

/** Long enough for a whole QSO. */
const QSO_MS = 120_000;

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

/** Time passing, inside act, so the page's updates land in it. */
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** Wait until `ok` holds, or fail saying `what`. */
async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    if (ok()) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
const status = () => $(".qsostatus")?.textContent ?? "";
const note = () => $(".qsonote")?.textContent ?? "";
const theirs = () => $$(".qsolog li.them");

async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "a control to click").not.toBeNull();
  await act(async () => el!.click());
}

/** Pick `value` in the select `id`. */
async function choose(id: string, value: string): Promise<void> {
  await act(async () => {
    await userEvent.selectOptions($<HTMLSelectElement>(`#${id}`)!, value);
  });
}

/** Move the slider `id` to `value`, as a drag would. */
async function slide(id: string, value: number): Promise<void> {
  const el = $<HTMLInputElement>(`#${id}`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Mount the page with these choices and press Start. */
async function open(prefs: Prefs): Promise<void> {
  mount(prefs);
  await until("the Start button", () => {
    const b = $<HTMLButtonElement>('[data-testid="qso-start"]');
    return !!b && !b.disabled;
  });
  await click($('[data-testid="qso-start"]'));
  await until("the session to start", () => status().startsWith("Your turn"));
  // A moment before the first over, as a person takes. Keyed the instant the
  // device opens, the first character can come out wrong under load.
  await wait(500);
}

/** Mount the page with these choices. */
function mount(prefs: Prefs): void {
  savePrefs({ charWpm: WPM, farnsworthWpm: WPM, qsoLength: "short", ...prefs });
  act(() =>
    root.render(
      createElement(QsoScreen, {
        deviceId: undefined,
        onDeviceChange: () => {},
        onError: (m: string) => errors.push(m),
        onConfigure: () => {},
        onPage: () => {},
      }),
    ),
  );
}

/** Key `text`, then wait for the station's answer and for the turn to come
 *  back. Returns the station's over, as a line of the log. */
async function send(text: string): Promise<HTMLElement> {
  const before = theirs().length;
  await mic.key(text);
  await until(`an answer to ${text}`, () => theirs().length > before);
  await until("the turn to come back", () => status().startsWith("Your turn"));
  return theirs()[theirs().length - 1]!;
}

/** The station's call, read off an over that shows whole. */
function callIn(line: HTMLElement): string {
  const text = line.querySelector(".text")?.textContent ?? "";
  const call = text.split(" ").find((w) => /^[A-Z0-9]?[A-Z]\d[A-Z]+$/.test(w) && w !== "W7YFR");
  expect(call, `a call in "${text}"`).toBeDefined();
  return call!;
}

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

describe("a QSO from your CQ", () => {
  it("runs from CQ to 73, and says it is over once the last over has played", async () => {
    await open({ qsoTheirText: "before" });

    // Between your K and its first character, it says it is about to send.
    await mic.key("CQ CQ DE W7YFR W7YFR K");
    await until("the wait before the answer", () => status() === "Waiting for the other station.");
    await until("the answer", () => theirs().length === 1);
    expect(status()).toBe("The other station is sending.");
    await until("the turn to come back", () => status().startsWith("Your turn"));
    const answered = theirs()[0]!;
    const call = callIn(answered);
    // Your over, as copied. Not the first word: under load a character of it
    // can be misread, and the station still finds the CQ.
    expect($$(".qsolog li.you .text")[0]!.textContent).toContain("DE W7YFR W7YFR K");

    const exchange = await send(`${call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`);
    expect(exchange.textContent).toMatch(/ NAME | OP /);
    expect(note(), "no note while the QSO runs").toBe("");

    // The last over: the note must wait for it to finish playing.
    const before = theirs().length;
    await mic.key("R TNX 73 <SK>");
    await until("the last over to start", () => theirs().length > before);
    expect(status()).toBe("The other station is sending.");
    expect(note(), "no note while the last over plays").toBe("");
    await until("the turn to come back", () => status().startsWith("Your turn"));
    expect(note()).toBe("The QSO is over. Call CQ for the next one.");
  }, QSO_MS);

  it("sends its last over again, slower, on QRS", async () => {
    await open({ qsoTheirText: "before" });
    const first = await send("CQ CQ DE W7YFR W7YFR K");
    const again = await send("QRS K");
    expect(again.querySelector(".text")!.textContent).toBe(first.querySelector(".text")!.textContent);
    // Halfway from 45 down to the bottom step: 25, between 24 and 26, so 24.
    expect($('[data-testid="qso-their-speed"]')?.textContent).toBe("The station sends at 45/24 wpm.");
  }, QSO_MS);
});

describe("copying the station", () => {
  it("keeps the copy open after the last over, and grades it on request", async () => {
    await open({ qsoTheirText: "before" });
    const call = callIn(await send("CQ CQ DE W7YFR W7YFR K"));

    // Copy on mid-QSO: the over already read gets no box.
    await choose("qso-their-text", "copy");
    expect($$('[data-testid="qso-type"]')).toHaveLength(0);

    await send(`${call} DE W7YFR UR 599 NAME BOB QTH SALEM OR KN`);
    const boxes = () => $$<HTMLInputElement>('[data-testid="qso-type"]');
    expect(boxes()).toHaveLength(1);
    await act(async () => {
      await userEvent.fill(boxes()[0]!, `w7yfr de ${call}`);
    });

    await send("R TNX 73 <SK>");
    expect(boxes(), "both boxes open after the last over").toHaveLength(2);
    expect(note()).toContain("Finish your copy");
    await act(async () => {
      await userEvent.fill(boxes()[1]!, "tu 73");
    });

    await click($('[data-testid="qso-grade"]'));
    expect(boxes()).toHaveLength(0);
    const graded = $$(".qsolog .graded");
    expect(graded).toHaveLength(2);
    expect(graded[0]!.textContent).toContain(`You copied W7YFR DE ${call}`);
    expect(note()).toBe("The QSO is over. Call CQ for the next one.");
  }, QSO_MS);

  it("labels the station's lines Station until you have its call", async () => {
    await open({ qsoTheirText: "copy" });
    await send("CQ CQ DE W7YFR W7YFR K");
    const label = () => theirs()[0]!.querySelector(".who")!.textContent;
    expect(label()).toBe("Station");
    expect($('[data-testid="qso-type"]')?.getAttribute("aria-label")).toBe("Your copy of Station");

    // Stop ends the QSO, and its call shows.
    await click($('[data-testid="qso-stop"]'));
    expect(label()).toMatch(/^[A-Z0-9]?[A-Z]\d[A-Z]+$/);
  }, QSO_MS);
});

describe("your speed", () => {
  it("is the practice page's speed, on its sliders, and locks while a session runs", async () => {
    mount({ charWpm: 20, farnsworthWpm: 15 });
    const field = (id: string) => $<HTMLInputElement>(`#${id}`)!;
    expect(field("wpm").value).toBe("20");
    expect(field("farns").value).toBe("15");
    expect($("#wpm-out")?.textContent).toContain("20");
    expect($('[data-testid="qso-their-speed"]')?.textContent).toBe("The station answers at your speed.");

    await slide("wpm", 30);
    expect(loadSpeed()).toEqual({ charWpm: 30, farnsworthWpm: 15 });
    // Overall cannot pass character speed: its slider stops there.
    expect(field("farns").max).toBe("30");
    await slide("wpm", 12);
    expect(loadSpeed()).toEqual({ charWpm: 12, farnsworthWpm: 12 });

    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => status().startsWith("Your turn"));
    expect(field("wpm").closest("[inert]"), "locked while it runs").not.toBeNull();
    expect(field("input-device").closest("[inert]"), "the microphone too").not.toBeNull();
    expect($("#qso-their-text")!.closest("[inert]"), "what shows can still change").toBeNull();
  }, QSO_MS);
});
