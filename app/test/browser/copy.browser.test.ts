/* The Copy page, end to end: open a recording of a QSO, play it, copy it,
 * and go again.
 *
 * The recording is a QSO made from text, two stations at two pitches, as a
 * WAV file. The file reader, the decoder worker and the browser's storage are
 * the real ones. The player is a stand-in that plays nothing and runs its
 * clock fast, so a recording plays in a fraction of its length. It reports
 * where it is as the real one does, and the page moves on that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { synthesize } from "@/audio/synth";
import { encodeWavBuffer } from "@/audio/wav";
import { forgetCopyFile, loadPrefs, recallCopy, savePrefs, type Prefs } from "@/io/storage";
import { targetTiming } from "@/timing/model";
import { CopyScreen } from "@/ui/CopyScreen";
import "@/ui/base.css";

/** How much faster than real time the stand-in player runs. */
const SPEED = 8;

vi.mock("@/audio/player", async (real) => {
  const actual = await real<typeof import("@/audio/player")>();
  /** How long a WAV file made by encodeWavBuffer plays, in seconds. */
  const lengthOf = (data: ArrayBuffer | AudioBuffer): number => {
    if (!(data instanceof ArrayBuffer)) return data.duration;
    const d = new DataView(data);
    return d.getUint32(40, true) / 2 / d.getUint32(24, true);
  };
  return {
    ...actual,
    createPlayer(callbacks: import("@/audio/player").PlayerCallbacks = {}): import("@/audio/player").Player {
      let frame: ReturnType<typeof setInterval> | null = null;
      const end = (reason: "done" | "stopped") => {
        if (frame === null) return;
        clearInterval(frame);
        frame = null;
        callbacks.onEnded?.(reason);
      };
      let gain = 0;
      return {
        async playBuffer(data, from = 0, to) {
          end("stopped");
          (globalThis as { plays?: [number, number | undefined][] }).plays?.push([from, to]);
          (globalThis as { played?: unknown }).played = data;
          const stop = to ?? lengthOf(data);
          let t = from;
          frame = setInterval(() => {
            t = Math.min(stop, t + (0.016 * SPEED));
            callbacks.onProgress?.(t, "you");
            if (t >= stop) end("done");
          }, 16);
        },
        playTarget() {
          throw new Error("the Copy page plays no target");
        },
        stop: () => end("stopped"),
        wake() {},
        setGainDb(db) {
          gain = db;
        },
        gainDb: () => gain,
        playing: () => (frame === null ? null : "you"),
        renderTarget: () => Promise.reject(new Error("not here")),
        destroy: () => end("stopped"),
      };
    },
  };
});

const RATE = 8000;
const WPM = 20;

/** The QSO on the recording: each over, and which station sends it. */
/** How many characters a line sends, as its grade counts them. */
const keyed = (text: string) => text.replace(/ /g, "").length;

const QSO = [
  { text: "CQ CQ DE W7YFR K", toneHz: 600 },
  { text: "W7YFR DE N1AK KN", toneHz: 640 },
  { text: "N1AK DE W7YFR UR 599 BK", toneHz: 600 },
];

/** The QSO as a WAV file: each over at its station's pitch, with a pause
 *  between overs. */
function recording(name = "qso.wav"): File {
  const timing = targetTiming(WPM, WPM);
  const parts = QSO.map(
    (o) => synthesize(o.text, timing, { toneHz: o.toneHz, rate: RATE, padSec: 0.6, amplitude: 0.5 }).samples,
  );
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    samples.set(p, k);
    k += p.length;
  }
  return new File([encodeWavBuffer(samples, RATE)], name, { type: "audio/wav" });
}

let host: HTMLDivElement;
let root: Root;
let errors: string[];
const fileTarget: MutableRefObject<((file: File) => void) | null> = { current: null };

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    if (ok()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
const button = (id: string) => $<HTMLButtonElement>(`[data-testid="${id}"]`)!;
/** Where the page is, as its heading's `data-state` says. */
const state = () => $('[data-testid="copy-state"]')?.dataset.state ?? "";
const lines = () => $$('[data-testid="copy-line"]');
const boxes = () => $$<HTMLInputElement>('[data-testid="copy-type"]');

async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "a control to click").not.toBeNull();
  await act(async () => el!.click());
}

/** Type `text` into a box, as typing would. */
async function fill(el: HTMLInputElement, text: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    el.focus();
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press Enter in a box. With `mod`, Cmd+Enter on a Mac, Ctrl+Enter
 *  elsewhere. */
async function enter(el: HTMLElement, mod = false): Promise<void> {
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: mod && mac,
        ctrlKey: mod && !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function mount(prefs: Prefs = {}): void {
  savePrefs({ ...prefs });
  act(() =>
    root.render(
      createElement(CopyScreen, {
        onError: (m: string) => errors.push(m),
        onConfigure: () => {},
        onPage: () => {},
        onHome: () => {},
        fileTarget,
      }),
    ),
  );
}

/** Mount the page and open the recording, as a drop on the page does. */
async function open(prefs: Prefs = {}): Promise<void> {
  mount(prefs);
  await until("the page to settle", () => state() === "none");
  await act(async () => fileTarget.current!(recording()));
  await until("the recording to be read", () => state() === "ready");
}

/** Play to the end of the recording. */
async function playThrough(): Promise<void> {
  await click(button("copy-play"));
  await until("the recording to end", () => state() === "over");
}

/** Play until `n` lines show, then pause. */
async function playTo(n: number): Promise<void> {
  await click(button("copy-play"));
  await until(`line ${n}`, () => lines().length >= n);
  await click(button("copy-play"));
  expect(state()).toBe("paused");
}

/** What the player was asked to play: from, and to where it was given. */
let plays: [number, number | undefined][];

beforeEach(async () => {
  plays = [];
  (globalThis as { plays?: typeof plays }).plays = plays;
  localStorage.clear();
  await forgetCopyFile();
  errors = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  await forgetCopyFile();
  expect(errors, "errors the page reported").toEqual([]);
});

describe("opening a recording", () => {
  it("shows the guide and Open a recording until there is one", async () => {
    mount();
    await until("the page to settle", () => state() === "none");
    expect($('[data-testid="copy-guide"]')).not.toBeNull();
    expect($('[data-testid="copy-open-first"]')).not.toBeNull();
    expect(lines()).toHaveLength(0);
  });

  it("reads the file, and shows each line once the recording reaches it", async () => {
    await open();
    expect($('[data-testid="copy-guide"]')).toBeNull();
    expect(lines(), "nothing shows before it plays").toHaveLength(0);
    await playThrough();
    expect(lines()).toHaveLength(QSO.length);
    expect(lines().map((l) => l.dataset.sender)).toEqual(["0", "1", "0"]);
  });
});

describe("copying a line", () => {
  it("locks a line when the next one starts, and marks what you got right", async () => {
    await open();
    await playTo(1);
    await fill(boxes()[0]!, QSO[0]!.text);
    await playTo(2);
    expect(boxes(), "only the second line's box").toHaveLength(1);
    const first = lines()[0]!;
    expect(first.querySelector('[data-testid="copy-right-only"]')).not.toBeNull();
    expect(first.querySelectorAll(".cwrong")).toHaveLength(0);
    expect(first.querySelector('[data-testid="copy-line-score"]')!.textContent).toBe(`${keyed(QSO[0]!.text)}/${keyed(QSO[0]!.text)}`);
  });

  it("plays and pauses on Enter in its box, and leaves the line open", async () => {
    await open();
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await enter(boxes()[0]!);
    expect(state()).toBe("playing");
    await enter(boxes()[0]!);
    expect(state()).toBe("paused");
    expect(boxes()).toHaveLength(1);
    expect(lines()[0]!.querySelector('[data-testid="copy-line-score"]')).toBeNull();
  });

  it("plays and pauses on Enter in a slot, and leaves the line open", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    const slot = lines()[0]!.querySelector<HTMLInputElement>('[data-testid="copy-slot"]')!;
    await fill(slot, "C");
    await enter(slot);
    expect(state()).toBe("playing");
    await enter(slot);
    expect(state()).toBe("paused");
    expect(lines()[0]!.querySelectorAll('[data-testid="copy-slot"]')).toHaveLength(keyed(QSO[0]!.text));
  });

  it("locks a line on Cmd or Ctrl+Enter in its box", async () => {
    await open();
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await enter(boxes()[0]!, true);
    expect(boxes()).toHaveLength(0);
    expect(lines()[0]!.querySelector('[data-testid="copy-line-score"]')!.textContent).toBe(`4/${keyed(QSO[0]!.text)}`);
  });

  it("locks a line on Cmd or Ctrl+Enter in a slot", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    const slot = lines()[0]!.querySelector<HTMLInputElement>('[data-testid="copy-slot"]')!;
    await fill(slot, "C");
    await enter(slot, true);
    expect(lines()[0]!.querySelectorAll('[data-testid="copy-slot"]')).toHaveLength(0);
    expect(lines()[0]!.querySelector('[data-testid="copy-line-score"]')).not.toBeNull();
  });

  it("names a station Station 1 until you copy its call", async () => {
    await open();
    await playTo(1);
    const who = () => lines()[0]!.querySelector(".who")!.textContent;
    expect(who()).toBe("Station 1");
    await fill(boxes()[0]!, "CQ CQ DE W7YFR");
    expect(who()).toBe("W7YFR");
  });

  it("gives a slot for each character, with Slots", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    expect(boxes()).toHaveLength(0);
    expect(lines()[0]!.querySelectorAll('[data-testid="copy-slot"]')).toHaveLength(keyed(QSO[0]!.text));
  });

  /** Which slots of line 1 are highlighted as playing, each time that
   *  changes, until line 2 shows. */
  async function playingSlots(): Promise<number[][]> {
    const seen: number[][] = [];
    const look = () => {
      const line = lines()[0];
      if (!line) return;
      const slots = [...line.querySelectorAll(".slot")];
      seen.push(slots.flatMap((el, i) => (el.classList.contains("playing") ? [i] : [])));
    };
    const watch = new MutationObserver(look);
    watch.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    await click(button("copy-play"));
    await until("line 2", () => lines().length >= 2);
    watch.disconnect();
    return seen;
  }

  it("highlights the slot playing, with Highlight the active slot", async () => {
    await open({ copyInput: "slots", copyFollow: true });
    const seen = await playingSlots();
    expect(seen.every((s) => s.length <= 1), "one slot at a time").toBe(true);
    const order = seen.flat();
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBeGreaterThan(keyed(QSO[0]!.text) / 2);
    await click(button("copy-play"));
    expect(state()).toBe("paused");
    expect($$(".slot.playing")).toHaveLength(0);
  });

  it("highlights no slot without Highlight the active slot", async () => {
    await open({ copyInput: "slots" });
    const seen = await playingSlots();
    await click(button("copy-play"));
    expect(seen.flat()).toEqual([]);
  });
});

describe("a click on a locked line", () => {
  it("plays the word clicked in your copy, in a box", async () => {
    await open();
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await enter(boxes()[0]!, true);
    const chars = [...lines()[0]!.querySelectorAll('[data-testid="copy-right-only"] [data-t0]')];
    expect(chars.length).toBeGreaterThan(0);
    const before = plays.length;
    await act(async () => {
      chars.at(-1)!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(plays.length).toBe(before + 1);
    const [from, to] = plays.at(-1)!;
    expect(to).toBeDefined();
    expect(to! - from).toBeLessThan(2);
  });

  it("plays the word clicked in your copy, in slots", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    const slot = lines()[0]!.querySelector<HTMLInputElement>('[data-testid="copy-slot"]')!;
    await fill(slot, "C");
    await enter(slot, true);
    const chars = [...lines()[0]!.querySelectorAll('[data-testid="copy-slots-locked"] .yourcopy [data-t0]')];
    expect(chars).toHaveLength(keyed(QSO[0]!.text));
    const before = plays.length;
    await act(async () => {
      chars.at(-1)!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(plays.length).toBe(before + 1);
    const [from, to] = plays.at(-1)!;
    expect(to! - from).toBeLessThan(2);
  });
});

describe("going again", () => {
  it("starts a new attempt with Copy again, and shows the last one over each line", async () => {
    await open();
    expect(button("copy-again").disabled, "off until a line is locked").toBe(true);
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await playThrough();
    await click(button("copy-again"));
    expect($('[data-testid="copy-attempt"]')).not.toBeNull();
    await until("the first line again", () => lines().length >= 1);
    expect(lines()[0]!.querySelector('[data-testid="copy-past"]')).not.toBeNull();
  });

  it("keeps each line open with Lock off, and locks the attempt with Copy again", async () => {
    await open({ copyLock: false });
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    expect(button("copy-again").disabled, "off before the end").toBe(true);
    await playThrough();
    expect(boxes()).toHaveLength(QSO.length);
    expect(button("copy-again").disabled, "on at the end").toBe(false);
    await click(button("copy-again"));
    await click(button("copy-play"));
    const saved = recallCopy() as { attempts: { lines: { locked: boolean }[] }[] };
    expect(saved.attempts).toHaveLength(2);
    expect(saved.attempts[0]!.lines.every((l) => l.locked)).toBe(true);
    expect(saved.attempts[1]!.lines.some((l) => l.locked)).toBe(false);
  });

  it("offers Copy again after a perfect copy, and starts the next attempt clean", async () => {
    await open();
    for (let n = 1; n <= QSO.length; n++) {
      await playTo(n);
      await fill(boxes().at(-1)!, QSO[n - 1]!.text);
    }
    await enter(boxes().at(-1)!, true);
    await playThrough();
    expect(button("copy-again").classList.contains("primary")).toBe(true);
    await click(button("copy-again"));
    await until("the first line again", () => boxes().length >= 1);
    await click(button("copy-play"));
    expect(boxes()[0]!.value).toBe("");
  });

  it("shows what was sent under each line with Show answers", async () => {
    await open();
    expect(button("copy-reveal").disabled, "off before there is a copy").toBe(true);
    await playTo(1);
    expect(button("copy-reveal").disabled).toBe(false);
    await click(button("copy-reveal"));
    expect(button("copy-reveal").getAttribute("aria-pressed")).toBe("true");
    expect(lines(), "every line shows").toHaveLength(QSO.length);
    expect($$('[data-testid="copy-answer"]')).toHaveLength(QSO.length);
    await click(button("copy-reveal"));
    expect($$('[data-testid="copy-answer"]')).toHaveLength(0);
  });

  it("clears every attempt with Start over, and keeps the recording", async () => {
    await open();
    expect(button("copy-restart").disabled, "off before there is a copy").toBe(true);
    await playTo(1);
    await fill(boxes()[0]!, "CQ");
    expect(button("copy-restart").disabled).toBe(false);
    await click(button("copy-restart"));
    expect(lines()).toHaveLength(0);
    expect(state()).toBe("ready");
    expect(button("copy-restart").disabled).toBe(true);
  });
});

describe("Clear", () => {
  it("is off with no recording and while one plays, and closes the recording", async () => {
    mount();
    await until("the page to settle", () => state() === "none");
    expect(button("copy-clear").disabled, "off with no recording").toBe(true);
    await act(async () => fileTarget.current!(recording()));
    await until("the recording to be read", () => state() === "ready");
    expect(button("copy-clear").disabled).toBe(false);
    await click(button("copy-play"));
    expect(button("copy-clear").disabled, "off while it plays").toBe(true);
    await click(button("copy-play"));

    await click(button("copy-clear"));
    expect(state()).toBe("none");
    expect($('[data-testid="copy-guide"]')).not.toBeNull();

    // A reload does not bring it back.
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    await until("the page to settle", () => state() === "none");
    await wait(300);
    expect(state()).toBe("none");
  });
});

describe("copying in another way", () => {
  /** Pick Copy in from the settings: Box or Slots. */
  async function copyIn(label: "Box" | "Slots"): Promise<void> {
    const pick = $$<HTMLButtonElement>('[data-testid="copy-input"] button').find((b) => b.textContent === label);
    await click(pick ?? null);
  }
  const slots = () => $$('[data-testid="copy-slot"]');

  it("takes Copy in at once while nothing is copied", async () => {
    await open({ copySettingsOpen: true });
    await copyIn("Slots");
    await playTo(1);
    expect(boxes()).toHaveLength(0);
    expect(slots().length).toBeGreaterThan(0);
  });

  it("keeps the attempt under way as it is, and copies the next attempt the new way", async () => {
    await open({ copyInput: "slots", copySettingsOpen: true });
    await playTo(1);
    await fill(slots()[0] as HTMLInputElement, "C");
    await copyIn("Box");
    expect(boxes()).toHaveLength(0);
    expect(slots().length).toBeGreaterThan(0);
    await enter(slots()[0]!, true);
    await playThrough();
    await click(button("copy-again"));
    await until("the first line again", () => lines().length >= 1);
    await click(button("copy-play"));
    expect(boxes()).toHaveLength(1);
    // The attempt made in slots shows as text, as the box under it does.
    expect(lines()[0]!.querySelector('.pastcopy [data-testid="copy-past-slots-text"]')).not.toBeNull();
    expect(lines()[0]!.querySelector('.pastcopy .rowscore')!.textContent).toBe(`#1 · 1/${keyed(QSO[0]!.text)}`);
  });

  it("shows an attempt made in the box as slots over slots", async () => {
    await open({ copySettingsOpen: true });
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await enter(boxes()[0]!, true);
    await copyIn("Slots");
    await playThrough();
    await click(button("copy-again"));
    await until("the first line again", () => lines().length >= 1);
    await click(button("copy-play"));
    const past = [...lines()[0]!.querySelectorAll('.pastcopy [data-testid="copy-past-slots"] .slot')];
    expect(past.map((el) => el.textContent?.trim()).join("")).toBe("CQCQ");
    expect(past.slice(0, 4).every((el) => el.classList.contains("cright"))).toBe(true);
  });

  it("brings back an attempt kept before attempts knew how they were copied, as it was copied", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    await fill(slots()[0] as HTMLInputElement, "C");
    await wait(300);
    act(() => root.unmount());
    const saved = JSON.parse(localStorage.getItem("cwt:copy")!) as { attempts: { input?: string }[] };
    for (const a of saved.attempts) delete a.input;
    localStorage.setItem("cwt:copy", JSON.stringify(saved));
    root = createRoot(host);
    mount({ copyInput: "text" });
    await until("the recording to come back", () => state() === "paused");
    expect(boxes()).toHaveLength(0);
    expect((slots()[0] as HTMLInputElement).value).toBe("C");
  });
});

describe("a reload", () => {
  it("brings back the recording and your copy", async () => {
    await open();
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ DE");
    // The recording is kept as the file opens, in the background.
    await wait(300);

    act(() => root.unmount());
    root = createRoot(host);
    mount();
    await until("the recording to come back", () => state() === "paused");
    expect(lines()).toHaveLength(1);
    expect(boxes()[0]!.value).toBe("CQ CQ DE");
  });
});

describe("a generated QSO", () => {
  /** The length shown in the clock, in seconds. */
  const length = () => {
    const [m, s] = $('[data-testid="copy-clock"]')!.textContent!.split("/")[1]!.trim().split(":");
    return Number(m) * 60 + Number(s);
  };

  /** Mount the page and generate a QSO, as Generate QSO does. */
  async function makeUp(prefs: Prefs = {}): Promise<void> {
    mount(prefs);
    await until("the page to settle", () => state() === "none");
    await click(button("copy-new-first"));
    await until("the QSO to be ready", () => state() === "ready");
  }

  it("is generated in the kind chosen, a line per over, the station that calls CQ first", async () => {
    await makeUp({ copyKind: "sst", copyRunQsos: 1, copyGap: "1", copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await playThrough();
    expect(lines().length).toBeGreaterThanOrEqual(5);
    expect(lines()[0]!.dataset.sender).toBe("0");
    expect(new Set(lines().map((l) => l.dataset.sender))).toEqual(new Set(["0", "1"]));
  });

  it("is sent again at a new speed, with your copy and the attempt kept", async () => {
    await makeUp({ copyKind: "cwt", copyRunQsos: 1, copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await playTo(1);
    await fill(boxes()[0]!, "CQ CWT");
    const before = length();
    await click(button("panel-toggle"));
    await fill($<HTMLInputElement>("#wpm")!, "15");
    await until("the QSO to be sent again", () => length() > before);
    expect(boxes()[0]!.value).toBe("CQ CWT");
    expect(lines()).toHaveLength(1);
  });

  it("is sent again through QSB and the band, with your copy kept and its timing the same", async () => {
    await makeUp({ copyKind: "cwt", copyRunQsos: 1, copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await playTo(1);
    await fill(boxes()[0]!, "CQ CWT");
    const played = () => new Uint8Array((globalThis as { played?: ArrayBuffer }).played!);
    const clean = played();
    const before = length();
    await click(button("panel-toggle"));
    for (const [id, value] of [["qsb", "12"], ["noise", "-20"], ["qrn", "2"], ["qrm", "-20"]] as const) {
      await fill($<HTMLInputElement>(`#${id}`)!, value);
    }
    expect(loadPrefs()).toMatchObject({ qsbDb: 12, noiseDb: -20, qrn: 2, qrmDb: -20 });
    // Sent again once the sliders settle: what plays next is not the clean QSO.
    await wait(400);
    expect(boxes()[0]!.value).toBe("CQ CWT");
    expect(length()).toBe(before);
    await playTo(2);
    const aired = played();
    expect(aired.length).toBe(clean.length);
    expect(aired.some((b, i) => b !== clean[i])).toBe(true);
  });

  it("chooses Mine when a slider moves", async () => {
    await makeUp({ copyKind: "pota", copyRunQsos: 1 });
    await click(button("panel-toggle"));
    const pressed = () => $('[data-testid="copy-speed"] [aria-pressed="true"]')?.textContent;
    const was = pressed();
    await fill($<HTMLInputElement>("#farns")!, "8");
    expect(pressed()).not.toBe(was);
  });

  it("comes back after a reload, as it was sent", async () => {
    await makeUp({ copyKind: "mst", copyRunQsos: 3, copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await playTo(1);
    await fill(boxes()[0]!, "CQ MST");
    const was = length();
    await wait(300);

    act(() => root.unmount());
    root = createRoot(host);
    mount({ copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await until("the QSO to come back", () => state() === "paused");
    expect(length()).toBe(was);
    expect(boxes()[0]!.value).toBe("CQ MST");
  });
});

describe("Wait between lines", () => {
  /** Mount the page and generate a QSO that stops after each line. */
  async function locked(): Promise<void> {
    mount({ copyKind: "cwt", copyRunQsos: 1, copyGap: "wait", copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 });
    await until("the page to settle", () => state() === "none");
    await click(button("copy-new-first"));
    await until("the QSO to be ready", () => state() === "ready");
  }

  it("stops after a line, and goes on to the next when Enter locks it", async () => {
    await locked();
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    expect(lines()).toHaveLength(1);
    await fill(boxes()[0]!, "CQ CWT");
    await enter(boxes()[0]!);
    expect(lines()[0]!.querySelector('[data-testid="copy-type"]'), "line 1 locked").toBeNull();
    await until("a stop after line 2", () => state() === "paused" && lines().length === 2);
    await wait(200);
    expect(state(), "it waits").toBe("paused");
  });

  it("goes on without locking the line on Play", async () => {
    await locked();
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    await click(button("copy-play"));
    await until("line 2", () => lines().length === 2);
    await until("a stop", () => state() === "paused");
    expect(lines()).toHaveLength(2);
  });
});

describe("the keys the pages share", () => {
  /** Cmd+. on a Mac, Ctrl+. elsewhere, on `el`. */
  async function modDot(el: HTMLElement): Promise<void> {
    const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
    });
  }

  it("plays the line of the box you are in again on Cmd or Ctrl+.", async () => {
    await open();
    await playTo(1);
    const before = plays.length;
    await modDot(boxes()[0]!);
    expect(plays.length).toBe(before + 1);
    const [, to] = plays[plays.length - 1]!;
    expect(to, "one line, not the rest of the recording").toBeDefined();
    expect(boxes()[0]!.value, "nothing typed").toBe("");
  });

  it("plays the last line heard again on Cmd or Ctrl+., outside a box", async () => {
    await open();
    await playTo(2);
    (document.activeElement as HTMLElement | null)?.blur();
    const before = plays.length;
    await modDot(document.body);
    expect(plays.length).toBe(before + 1);
    expect(plays[plays.length - 1]![1]).toBeDefined();
  });
});

describe("Allow edits", () => {
  it("opens a locked line again, and locks it again on Cmd or Ctrl+Enter", async () => {
    await open({ copyAllowEdits: true });
    await playTo(1);
    await fill(boxes()[0]!, "CQ CQ");
    await enter(boxes()[0]!, true);
    expect(boxes()).toHaveLength(0);
    await click(lines()[0]!.querySelector<HTMLElement>('[data-testid="copy-line-edit"]'));
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]!.value, "your copy as you left it").toBe("CQ CQ");
    await fill(boxes()[0]!, "CQ CQ DE");
    await enter(boxes()[0]!, true);
    expect(boxes()).toHaveLength(0);
    expect(lines()[0]!.querySelector('[data-testid="copy-line-score"]')!.textContent).toBe(`6/${keyed(QSO[0]!.text)}`);
  });

  it("locks an edited line again when the recording plays on", async () => {
    await open({ copyAllowEdits: true });
    await playTo(2);
    expect(boxes()).toHaveLength(1);
    await click(lines()[0]!.querySelector<HTMLElement>('[data-testid="copy-line-edit"]'));
    expect(boxes()).toHaveLength(2);
    await click(button("copy-play"));
    await until("line 1 to lock again", () => !lines()[0]!.querySelector('[data-testid="copy-type"]'));
  });

  it("shows no Edit unless allowed", async () => {
    await open();
    await playTo(2);
    expect($('[data-testid="copy-line-edit"]')).toBeNull();
  });
});
