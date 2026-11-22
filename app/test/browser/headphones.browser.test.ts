/* The Copy page on a phone: playback through an <audio> element, and the
 * headphone buttons through the Media Session API.
 *
 * The phone's player runs against a real element. The page's tests use a
 * stand-in for it that plays nothing and runs its clock fast, as the Copy
 * page's own tests do, and press the buttons by calling the handlers the
 * page gave the Media Session.
 */

import { withSettings } from "../settings-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { act, createElement, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMediaPlayer, createSessionPlayer } from "@/audio/mediaPlayer";
import { encodeWavBuffer } from "@/audio/wav";
import { forgetCopyFile, savePrefs, type Prefs } from "@/io/storage";
import { CopyScreen } from "@/ui/CopyScreen";
import "@/ui/base.css";

/** How much faster than real time the stand-in player runs. */
const SPEED = 8;

/* The page's phone player, as a stand-in. The real one is under test below,
   from its own module. */
vi.mock("@/audio/mediaPlayer", async (real) => {
  const actual = await real<typeof import("@/audio/mediaPlayer")>();
  /** How long a WAV file made by encodeWavBuffer plays, in seconds. */
  const lengthOf = (data: ArrayBuffer | AudioBuffer): number => {
    if (!(data instanceof ArrayBuffer)) return data.duration;
    const d = new DataView(data);
    return d.getUint32(40, true) / 2 / d.getUint32(24, true);
  };
  return {
    ...actual,
    realMediaPlayer: actual.createMediaPlayer,
    createMediaPlayer(callbacks: import("@/audio/player").PlayerCallbacks = {}): import("@/audio/player").Player {
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
          (globalThis as { phonePlays?: unknown[] }).phonePlays?.push({ data, from });
          const stop = to ?? lengthOf(data);
          let t = from;
          frame = setInterval(() => {
            t = Math.min(stop, t + 0.016 * SPEED);
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

const realMediaPlayer = async () =>
  ((await import("@/audio/mediaPlayer")) as unknown as { realMediaPlayer: typeof createMediaPlayer }).realMediaPlayer;

/** A WAV file of silence, `sec` long. */
const silence = (sec: number, rate = 8000) => encodeWavBuffer(new Float32Array(Math.round(sec * rate)), rate);

/** Run `fn` from a real click, since a browser holds audio back until a
 *  gesture. */
async function fromClick(fn: () => void): Promise<void> {
  const go = document.createElement("button");
  go.textContent = "go";
  go.onclick = fn;
  document.body.append(go);
  await userEvent.click(go);
  go.remove();
}

describe("the computer's player", () => {
  /** The silent element beside the Web Audio player. */
  const silentEl = () => [...document.querySelectorAll("audio")].at(-1);

  it("plays silence while the QSO plays, and pauses it when the QSO stops or ends", async () => {
    const ended = vi.fn();
    const player = createSessionPlayer({ onEnded: ended });
    try {
      await fromClick(() => void player.playBuffer(silence(3)));
      await vi.waitFor(() => expect(player.playing()).toBe("you"));
      expect(silentEl()?.paused).toBe(false);
      player.stop();
      expect(silentEl()?.paused).toBe(true);
      await fromClick(() => void player.playBuffer(silence(0.5)));
      await vi.waitFor(() => expect(ended).toHaveBeenLastCalledWith("done"), { timeout: 3000 });
      expect(silentEl()?.paused).toBe(true);
    } finally {
      player.destroy();
    }
  });

  it("plays silence and pauses on the first tap once the page names what it plays", async () => {
    const pauses = vi.spyOn(HTMLMediaElement.prototype, "pause");
    navigator.mediaSession.metadata = new MediaMetadata({ title: "a QSO" });
    const player = createSessionPlayer();
    try {
      await fromClick(() => {});
      await vi.waitFor(() => expect(pauses).toHaveBeenCalled());
      expect(silentEl()?.paused).toBe(true);
      expect(player.playing()).toBeNull();
    } finally {
      player.destroy();
      navigator.mediaSession.metadata = null;
      vi.restoreAllMocks();
    }
  });
});

describe("the phone's player", () => {
  it("plays from a point and stops at its end, saying where it is on the way", async () => {
    const play = await realMediaPlayer();
    const ended = vi.fn();
    const at: number[] = [];
    const player = play({ onEnded: ended, onProgress: (t) => at.push(t) });
    try {
      await fromClick(() => void player.playBuffer(silence(3), 0.5, 1.1));
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("done"), { timeout: 3000 });
      expect(at.length).toBeGreaterThan(0);
      expect(Math.min(...at)).toBeGreaterThanOrEqual(0.45);
      expect(Math.max(...at)).toBeLessThan(1.1);
      expect(player.playing()).toBeNull();
    } finally {
      player.destroy();
    }
  });

  it("plays to the end of the file", async () => {
    const play = await realMediaPlayer();
    const ended = vi.fn();
    const player = play({ onEnded: ended });
    try {
      await fromClick(() => void player.playBuffer(silence(0.6)));
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("done"), { timeout: 3000 });
      expect(ended).toHaveBeenCalledTimes(1);
    } finally {
      player.destroy();
    }
  });

  it("plays silence and pauses on the first tap once the page names what it plays, and then plays the QSO", async () => {
    const play = await realMediaPlayer();
    const ended = vi.fn();
    const progress = vi.fn();
    const plays = vi.spyOn(HTMLMediaElement.prototype, "play");
    const pauses = vi.spyOn(HTMLMediaElement.prototype, "pause");
    navigator.mediaSession.metadata = new MediaMetadata({ title: "a QSO" });
    const player = play({ onEnded: ended, onProgress: progress });
    try {
      await fromClick(() => {});
      await vi.waitFor(() => expect(pauses).toHaveBeenCalled());
      expect(plays).toHaveBeenCalledTimes(1);
      expect(player.playing()).toBeNull();
      expect(ended).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
      // Only the first tap.
      await fromClick(() => {});
      expect(plays).toHaveBeenCalledTimes(1);
      await fromClick(() => void player.playBuffer(silence(0.6)));
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("done"), { timeout: 3000 });
    } finally {
      player.destroy();
      navigator.mediaSession.metadata = null;
      vi.restoreAllMocks();
    }
  });

  it("plays nothing on a tap while the page names nothing", async () => {
    const play = await realMediaPlayer();
    const plays = vi.spyOn(HTMLMediaElement.prototype, "play");
    navigator.mediaSession.metadata = null;
    const player = play();
    try {
      await fromClick(() => {});
      expect(plays).not.toHaveBeenCalled();
    } finally {
      player.destroy();
      vi.restoreAllMocks();
    }
  });

  it("plays the QSO when the first tap is the one that plays it", async () => {
    const play = await realMediaPlayer();
    const ended = vi.fn();
    navigator.mediaSession.metadata = new MediaMetadata({ title: "a QSO" });
    const player = play({ onEnded: ended });
    try {
      await fromClick(() => void player.playBuffer(silence(3), 0.5, 1.1));
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("done"), { timeout: 3000 });
      expect(ended).toHaveBeenCalledTimes(1);
    } finally {
      player.destroy();
      navigator.mediaSession.metadata = null;
    }
  });

  it("says it was stopped, and then plays nothing", async () => {
    const play = await realMediaPlayer();
    const ended = vi.fn();
    const player = play({ onEnded: ended });
    try {
      await fromClick(() => void player.playBuffer(silence(3)));
      await vi.waitFor(() => expect(player.playing()).toBe("you"));
      player.stop();
      expect(ended).toHaveBeenLastCalledWith("stopped");
      expect(player.playing()).toBeNull();
    } finally {
      player.destroy();
    }
  });
});

let host: HTMLDivElement;
let root: Root;
let errors: string[];
const fileTarget: MutableRefObject<((file: File) => void) | null> = { current: null };

/** What the stand-in was asked to play: the file, and from where. */
let phonePlays: { data: ArrayBuffer; from: number }[];
/** The handlers the page gave the Media Session, by button. */
let buttons: Map<string, (() => void) | null>;
/** Whether this is a phone, as the page asks. */
let phone: boolean;

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

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const button = (id: string) => $<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const state = () => $('[data-testid="copy-state"]')?.dataset.state ?? "";

async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "a control to click").not.toBeNull();
  await act(async () => el!.click());
}

/** Press a headphone button. */
async function press(name: string): Promise<void> {
  const handler = buttons.get(name);
  expect(handler, `the page's ${name} handler`).toBeTruthy();
  await act(async () => handler!());
}

/** Mount the page and generate a QSO. */
async function generate(prefs: Prefs = {}): Promise<void> {
  savePrefs({ ...prefs });
  act(() =>
    root.render(
      withSettings(
        createElement(CopyScreen, {
          onError: (m: string) => errors.push(m),
          onPage: () => {},
          onHome: () => {},
          fileTarget,
        }),
      ),
    ),
  );
  await until("the page to settle", () => state() === "none");
  await click(button("copy-new"));
  await until("the QSO to be ready", () => state() === "ready");
}

beforeEach(async () => {
  phonePlays = [];
  (globalThis as { phonePlays?: typeof phonePlays }).phonePlays = phonePlays;
  buttons = new Map();
  phone = true;
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((q) =>
    q.includes("pointer: coarse") ? ({ ...matchMedia(q), matches: phone } as MediaQueryList) : matchMedia(q),
  );
  vi.spyOn(navigator.mediaSession, "setActionHandler").mockImplementation((action, handler) => {
    buttons.set(action, handler as (() => void) | null);
  });
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
  vi.restoreAllMocks();
  navigator.mediaSession.metadata = null;
  localStorage.clear();
  await forgetCopyFile();
  expect(errors, "errors the page reported").toEqual([]);
});

describe("the headphone buttons on the Copy page", () => {
  it("are taken on a phone, and named on the lock screen", async () => {
    await generate();
    expect(buttons.get("play")).toBeTruthy();
    expect(buttons.get("pause")).toBeTruthy();
    expect(buttons.get("nexttrack")).toBeTruthy();
    expect(navigator.mediaSession.metadata?.title).toBeTruthy();
  });

  it("are taken on a computer too, and play and pause the QSO there", async () => {
    phone = false;
    await generate();
    expect(buttons.get("nexttrack")).toBeTruthy();
    await press("play");
    expect(state()).toBe("playing");
    await wait(500);
    await press("pause");
    expect(state()).toBe("paused");
    expect(phonePlays, "the phone's player").toEqual([]);
  });

  it("play and pause the QSO", async () => {
    await generate();
    await press("play");
    expect(state()).toBe("playing");
    expect(navigator.mediaSession.playbackState).toBe("playing");
    await wait(300);
    await press("pause");
    expect(state()).toBe("paused");
    expect(navigator.mediaSession.playbackState).toBe("paused");
    await press("play");
    expect(state()).toBe("playing");
    expect(phonePlays.at(-1)!.from).toBeGreaterThan(0);
  });

  it("start the QSO over with next track while it plays", async () => {
    await generate();
    await press("play");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    await press("nexttrack");
    await until("the QSO to play from the top", () => phonePlays.length === 2);
    expect(phonePlays[1]!.from).toBe(0);
    expect(phonePlays[1]!.data).toBe(was);
    expect(state()).toBe("playing");
  });

  it("play a new QSO with next track while paused", async () => {
    await generate();
    await press("play");
    await wait(300);
    await press("pause");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    await press("nexttrack");
    await until("a new QSO to play", () => phonePlays.length === 2);
    expect(phonePlays[1]!.from).toBe(0);
    expect(phonePlays[1]!.data).not.toBe(was);
    expect(state()).toBe("playing");
  });

  /* iOS sends the first press of a double press as play or pause, just
     before next track. */
  it("play a new QSO on a double press while paused", async () => {
    await generate();
    await press("play");
    await wait(300);
    await press("pause");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    await press("play");
    await press("nexttrack");
    await until("a new QSO to play", () => phonePlays.at(-1)!.data !== was);
    expect(phonePlays.at(-1)!.from).toBe(0);
    expect(state()).toBe("playing");
  });

  it("start the QSO over on a double press while it plays", async () => {
    await generate();
    await press("play");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    const before = phonePlays.length;
    await press("pause");
    await press("nexttrack");
    await until("the QSO to play from the top", () => phonePlays.length === before + 1);
    expect(phonePlays.at(-1)!.from).toBe(0);
    expect(phonePlays.at(-1)!.data).toBe(was);
    expect(state()).toBe("playing");
  });

  it("play a new QSO on next track twice within 2 seconds while it plays", async () => {
    await generate();
    await press("play");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    const before = phonePlays.length;
    // Each double press as iOS sends it: pause, then next track.
    await press("pause");
    await press("nexttrack");
    await until("the QSO to play from the top", () => phonePlays.length === before + 1);
    expect(phonePlays.at(-1)!.from).toBe(0);
    expect(phonePlays.at(-1)!.data).toBe(was);
    await wait(500);
    await press("pause");
    await press("nexttrack");
    await until("a new QSO to play", () => phonePlays.at(-1)!.data !== was);
    expect(phonePlays.at(-1)!.from).toBe(0);
    expect(state()).toBe("playing");
  });

  it("start the QSO over again on next track more than 2 seconds later", async () => {
    await generate();
    await press("play");
    await wait(1200);
    const was = phonePlays.at(-1)!.data;
    await press("nexttrack");
    await wait(2200);
    const before = phonePlays.length;
    await press("nexttrack");
    await until("the QSO to play from the top again", () => phonePlays.length === before + 1);
    expect(phonePlays.at(-1)!.from).toBe(0);
    expect(phonePlays.at(-1)!.data).toBe(was);
  });
});
