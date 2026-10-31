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

  it("shows the speed it is sent at, and follows the sliders", async () => {
    await makeUp({ copyKind: "pota", copyRunQsos: 1, copySpeed: "mine", copyCharWpm: 30, copyFarnsworthWpm: 30 });
    const shown = () => $('[data-testid="copy-sent-speed"]')?.textContent;
    expect(shown()).toBe("30 wpm");
    await click(button("panel-toggle"));
    await fill($<HTMLInputElement>("#farns")!, "20");
    expect(shown()).toBe("30/20 wpm");
  });

  it("shows the range of its stations' speeds at Format", async () => {
    await makeUp({ copyKind: "pota", copyRunQsos: 3, copySpeed: "format" });
    expect($('[data-testid="copy-sent-speed"]')!.textContent).toMatch(/^\d+(–\d+)? wpm$/);
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
  async function locked(prefs: Prefs = {}): Promise<void> {
    mount({ copyKind: "cwt", copyRunQsos: 1, copyGap: "wait", copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40, ...prefs });
    await until("the page to settle", () => state() === "none");
    await click(button("copy-new-first"));
    await until("the QSO to be ready", () => state() === "ready");
  }

  it("stops after a line, and goes on to the next when Cmd or Ctrl+Enter locks it", async () => {
    await locked();
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    expect(lines()).toHaveLength(1);
    await fill(boxes()[0]!, "CQ CWT");
    await enter(boxes()[0]!, true);
    expect(lines()[0]!.querySelector('[data-testid="copy-type"]'), "line 1 locked").toBeNull();
    await until("a stop after line 2", () => state() === "paused" && lines().length === 2);
    await wait(200);
    expect(state(), "it waits").toBe("paused");
  });

  it("locks the line and goes on, on Enter at the end of a box with every character copied", async () => {
    await locked();
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    // Right or not: a full line locks.
    await fill(boxes()[0]!, "E".repeat(80));
    await enter(boxes()[0]!);
    expect(lines()[0]!.querySelector('[data-testid="copy-type"]'), "line 1 locked").toBeNull();
    await until("a stop after line 2", () => state() === "paused" && lines().length === 2);
  });

  it("locks the line and goes on, on Enter with every slot filled", async () => {
    await locked({ copyInput: "slots" });
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    const slots = [...lines()[0]!.querySelectorAll<HTMLInputElement>('[data-testid="copy-slot"]')];
    for (const slot of slots) await fill(slot, "E");
    await enter(slots.at(-1)!);
    expect(lines()[0]!.querySelectorAll('[data-testid="copy-slot"]'), "line 1 locked").toHaveLength(0);
    await until("a stop after line 2", () => state() === "paused" && lines().length === 2);
  });

  it("goes on from the end of the line it locks, not from the slot you were in", async () => {
    await locked({ copyInput: "slots", copySeekSlot: true });
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    const slots = [...lines()[0]!.querySelectorAll<HTMLInputElement>('[data-testid="copy-slot"]')];
    for (const slot of slots) await fill(slot, "E");
    const before = plays.length;
    await enter(slots.at(-1)!);
    expect(plays.length).toBe(before + 1);
    const [from] = plays.at(-1)!;
    const ends = [...lines()[0]!.querySelectorAll<HTMLElement>("[data-t1]")].map((e) => Number(e.dataset.t1));
    expect(ends.length, "line 1's characters").toBeGreaterThan(0);
    expect(from, "nothing of line 1 again").toBeGreaterThanOrEqual(Math.max(...ends) - 0.001);
  });

  it("goes on without locking the line on Enter", async () => {
    await locked();
    await click(button("copy-play"));
    await until("a stop after line 1", () => state() === "paused");
    await enter(boxes()[0]!);
    await until("line 2", () => lines().length === 2);
    await until("a stop", () => state() === "paused");
    expect(lines()).toHaveLength(2);
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
  /** Option+R on a Mac, Alt+R elsewhere, on `el`. */
  async function altR(el: HTMLElement): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "®", code: "KeyR", altKey: true, bubbles: true, cancelable: true }));
    });
  }

  it("plays the line of the box you are in again on Option or Alt+R", async () => {
    await open();
    await playTo(1);
    const before = plays.length;
    await altR(boxes()[0]!);
    expect(plays.length).toBe(before + 1);
    const [, to] = plays[plays.length - 1]!;
    expect(to, "one line, not the rest of the recording").toBeDefined();
    expect(boxes()[0]!.value, "nothing typed").toBe("");
  });

  it("stays in the slot on Option or Alt with an arrow", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    const slot = lines()[0]!.querySelectorAll<HTMLInputElement>('[data-testid="copy-slot"]')[2]!;
    await act(async () => {
      slot.focus();
      for (const shiftKey of [false, true]) {
        slot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, shiftKey, bubbles: true, cancelable: true }));
      }
      await wait(100);
    });
    expect(document.activeElement, "the same slot").toBe(slot);
  });

  /** Option+Enter, or Alt+Enter, on `el`: where it plays from. */
  async function altEnter(el: HTMLElement): Promise<number> {
    const before = plays.length;
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
    });
    expect(plays.length).toBe(before + 1);
    await click(button("copy-play"));
    return plays.at(-1)![0];
  }

  it("plays on from the word of the selected slot on Option or Alt+Enter", async () => {
    await open({ copyInput: "slots" });
    await playTo(1);
    const firstOf = (w: number) => lines()[0]!.querySelectorAll(".slotword")[w]!.querySelector("input")!;
    await act(async () => firstOf(1).focus());
    const second = await altEnter(firstOf(1));
    await act(async () => firstOf(0).focus());
    const first = await altEnter(firstOf(0));
    expect(second, "the second word, after the first").toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it("plays on from the word at the cursor in a box on Option or Alt+Enter", async () => {
    await open();
    await playTo(1);
    const box = boxes()[0]!;
    await fill(box, "CQ CQ");
    const second = await altEnter(box);
    await fill(box, "");
    const first = await altEnter(box);
    expect(second, "the second word, after the first").toBeGreaterThan(first);
    expect(box.value, "nothing typed").toBe("");
  });

  it("plays and pauses on Option or Alt+Space in a box, with nothing typed", async () => {
    await open();
    await playTo(1);
    const box = boxes()[0]!;
    box.focus();
    const space = () =>
      act(async () => {
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "\u00a0", code: "Space", altKey: true, bubbles: true, cancelable: true }));
      });
    const was = state();
    await space();
    await until("a change", () => state() !== was);
    await space();
    await until("back", () => state() !== "playing");
    expect(box.value, "nothing typed").toBe("");
  });

  it("plays the last line heard again on Option or Alt+R, outside a box", async () => {
    await open();
    await playTo(2);
    (document.activeElement as HTMLElement | null)?.blur();
    const before = plays.length;
    await altR(document.body);
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

describe("New exchange", () => {
  const SLOW = { copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40 } as const;
  const QSO = "CQ DE W1AW K\n\nW1AW DE K7ABC\n\nNAME BOB K\n\nR R";
  const textBox = () => $<HTMLTextAreaElement>('[data-testid="copy-text-box"]');
  /** The station of each row in the dialog. */
  const rows = () => $$('[data-testid="copy-text-lines"] li');

  async function write(text: string): Promise<void> {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(textBox()!, text);
      textBox()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** Mount the page and send `text` from New exchange. */
  async function own(text: string, prefs: Prefs = {}): Promise<void> {
    mount({ ...SLOW, ...prefs });
    await until("the page to settle", () => state() === "none");
    await click(button("copy-text-open"));
    await write(text);
    await click(button("copy-text-start"));
    await until("the text to be ready", () => state() === "ready");
  }

  /** Every line on the page, by its station. */
  async function senders(): Promise<number[]> {
    await playTo(1);
    await click(button("copy-reveal"));
    return lines().map((l) => Number(l.dataset.sender));
  }

  it("puts each line on the page, sent by the station the text says", async () => {
    await own(QSO);
    expect(textBox(), "the dialog closes").toBeNull();
    expect(await senders()).toEqual([0, 1, 1, 0]);
  });

  it("sends a line by the station you set", async () => {
    mount(SLOW);
    await until("the page to settle", () => state() === "none");
    await click(button("copy-text-open"));
    await write(QSO);
    await click(rows()[3]!.querySelectorAll("button")[1] as HTMLElement);
    await click(button("copy-text-start"));
    await until("the text to be ready", () => state() === "ready");
    expect(await senders()).toEqual([0, 1, 1, 1]);
  });

  it("opens the text on the page again, to edit", async () => {
    await own(QSO);
    await click(button("copy-text-open"));
    expect(textBox()!.value).toBe(QSO);
  });

  it("comes back after a reload, with the stations you set", async () => {
    mount(SLOW);
    await until("the page to settle", () => state() === "none");
    await click(button("copy-text-open"));
    await write(QSO);
    await click(rows()[3]!.querySelectorAll("button")[1] as HTMLElement);
    await click(button("copy-text-start"));
    await until("the text to be ready", () => state() === "ready");
    await wait(300);

    act(() => root.unmount());
    root = createRoot(host);
    mount(SLOW);
    await until("the text to come back", () => state() === "ready");
    await click(button("copy-text-open"));
    expect(textBox()!.value).toBe(QSO);
    expect(rows().map((r) => Number(r.dataset.station))).toEqual([0, 1, 1, 1]);
  });

  it("opens a .txt file in New exchange, named for the file", async () => {
    mount(SLOW);
    await until("the page to settle", () => state() === "none");
    await act(async () => fileTarget.current!(new File(["CQ DE W1AW K\n\nW1AW DE K7ABC K"], "homework.txt", { type: "text/plain" })));
    await until("the dialog", () => textBox() !== null);
    expect(textBox()!.value).toBe("CQ DE W1AW K\n\nW1AW DE K7ABC K");
    await click(button("copy-text-start"));
    await until("the text to be ready", () => state() === "ready");
    expect($(".copyname")!.title).toBe("homework.txt");
  });

  it("sends your text at the sliders, with Speed at Format too", async () => {
    await own(QSO, { copySpeed: "format", copyCharWpm: 33, copyFarnsworthWpm: 33 });
    await playTo(1);
    expect($('[data-testid="copy-line-wpm"]')!.textContent).toMatch(/\b33\b/);
  });
});

describe("back to your box", () => {
  const active = () => document.activeElement;

  it("goes into the first line's box once it starts, from Start", async () => {
    await open();
    await click(button("copy-play"));
    await until("the first box", () => boxes().length > 0 && active() === boxes()[0]);
    await click(button("copy-play"));
  });

  it("goes back to your box after a playback control", async () => {
    await open();
    await playTo(1);
    (active() as HTMLElement | null)?.blur();
    await click(button("copy-back-5"));
    await until("the box", () => active() === boxes()[0]);
  });

  it("goes back to your box after a playback key off the boxes", async () => {
    await open();
    await playTo(1);
    (active() as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    await until("the box", () => active() === boxes()[0]);
  });

  it("takes a character typed off the boxes into your box", async () => {
    await open();
    await playTo(1);
    (active() as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    expect(active()).toBe(boxes()[0]);
  });
});

describe("downloads", () => {
  afterEach(() => vi.restoreAllMocks());

  const SLOW = { copySpeed: "mine", copyCharWpm: 40, copyFarnsworthWpm: 40, copyKind: "sst", copyRunQsos: 1 } as const;
  const BAND = { noiseDb: -12, qsbDb: 10, qrn: 2, qrmDb: -14 } as const;

  /** Each file the page saves: its name and what is in it. */
  function saved(): { name: string; blob: Blob }[] {
    const files: { name: string; blob: Blob }[] = [];
    const blobs = new Map<string, Blob>();
    let n = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      const url = `blob:test/${n++}`;
      blobs.set(url, b as Blob);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      files.push({ name: this.download, blob: blobs.get(this.href)! });
    });
    return files;
  }

  async function generate(prefs: Prefs = {}): Promise<void> {
    mount({ ...SLOW, ...prefs });
    await until("the page to settle", () => state() === "none");
    await click(button("copy-new-first"));
    await until("the QSO to be ready", () => state() === "ready");
  }

  /** The share of samples near silence in a 16-bit WAV. */
  async function quiet(blob: Blob): Promise<number> {
    const pcm = new Int16Array((await blob.arrayBuffer()).slice(44));
    let n = 0;
    for (const v of pcm) if (Math.abs(v) < 300) n++;
    return n / pcm.length;
  }

  it("saves a generated QSO as audio and as text, with nothing added", async () => {
    const files = saved();
    await generate();
    expect($('[data-testid="copy-download-heard"]'), "nothing added to hear").toBeNull();
    await click(button("copy-download"));
    await click(button("copy-download-text"));
    expect(files.map((f) => f.name)).toEqual([expect.stringMatching(/\.wav$/), expect.stringMatching(/\.txt$/)]);
    const text = await files[1]!.blob.text();
    await playTo(1);
    await click(button("copy-reveal"));
    expect(text.trim().split("\n\n")).toHaveLength(lines().length);
  });

  it("saves a QSO with the band clean, and as heard", async () => {
    const files = saved();
    await generate(BAND);
    await click(button("copy-download-clean"));
    await click(button("copy-download-heard"));
    const [clean, heard] = files;
    expect(clean!.name).not.toMatch(/as-heard/);
    expect(heard!.name).toMatch(/-as-heard\.wav$/);
    expect(clean!.blob.size, "the same length").toBe(heard!.blob.size);
    expect(await quiet(clean!.blob)).toBeGreaterThan(2 * (await quiet(heard!.blob)));
  });

  it("saves a recording as it was opened", async () => {
    const files = saved();
    await open();
    expect($('[data-testid="copy-sent-speed"]'), "no speed known for a recording").toBeNull();
    expect($('[data-testid="copy-download-clean"]')).toBeNull();
    await click(button("copy-download"));
    expect(files[0]!.name).toBe("qso.wav");
  });

  it("hides the downloads with the setting off", async () => {
    await generate({ copyShowDownload: false });
    expect($('[data-testid="copy-downloads"]')).toBeNull();
  });
});
