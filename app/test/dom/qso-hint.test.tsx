/* The suggested reply on the QSO page. See qso-rig.tsx for how the page is
 * driven. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { $, $$, callIn, click, fill, lastSent, open, send, until, useQsoRig, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const hint = () => $('[data-testid="qso-hint"] code')?.textContent ?? null;
const USER = { callsign: "W7YFR", name: "ROB", qthRegionShort: "OR" };

describe("the suggested reply", () => {
  it("is off unless chosen", async () => {
    await open({ qsoTheirText: "before", user: USER });
    expect(hint()).toBeNull();
  });

  it("shows on each turn, with your details, when always on", async () => {
    await open({ qsoTheirText: "before", qsoHints: "always", user: USER });
    // The wording varies by the over: what it holds does not.
    expect(hint()).toMatch(/^CQ .*W7YFR/);
    callIn(await send("CQ SST W7YFR"));
    expect(hint()).toMatch(/ROB OR$/);
  });

  it("suggests the CQ of the kind the examples show", async () => {
    await open({ qsoTheirText: "before", qsoHints: "always", qsoGuide: "pota", user: USER });
    expect(hint()).toMatch(/^CQ .*POTA .*W7YFR/);
  });

  it("waits for your copy of the station's line to be right, once copied", async () => {
    await open({ qsoTheirText: "copy", qsoHints: "copied", qsoLockCopy: false, user: USER });
    expect(hint(), "nothing to copy before the first line").not.toBeNull();
    await send("CQ SST W7YFR");
    expect(hint(), "not yet copied").toBeNull();
    const box = $$<HTMLInputElement>('[data-testid="qso-type"]')[0]!;
    await fill(box, "x");
    expect(hint(), "copied wrong").toBeNull();
    await fill(box, lastSent().toLowerCase());
    expect(hint()).toMatch(/ ROB OR$/);
  });

  it("leaves out the station's call until you have it, unless its lines show", async () => {
    const callOf = (text: string) => text.split(" ").find((w) => /^[A-Z0-9]?[A-Z]\d[A-Z]+$/.test(w) && w !== "W7YFR")!;
    await open({ qsoTheirText: "copy", qsoHints: "always", qsoLockCopy: false, user: USER });
    // POTA: every reply to a caller starts with its call.
    await send("CQ POTA W7YFR");
    const call = callOf(lastSent());
    expect(hint(), "not yet copied").not.toContain(call);
    await fill($$<HTMLInputElement>('[data-testid="qso-type"]')[0]!, call.toLowerCase());
    expect(hint(), "copied").toContain(call);
  });

  it("puts in the station's call when its lines show whole", async () => {
    await open({ qsoTheirText: "before", qsoHints: "always", user: USER });
    const call = callIn(await send("CQ POTA W7YFR"));
    expect(hint()).toContain(call);
  });

  it("stays while a line plays again", async () => {
    await open({ qsoTheirText: "before", qsoHints: "always", qsoPlayback: "always", user: USER });
    await send("CQ CWT W7YFR");
    const before = hint();
    expect(before).not.toBeNull();
    const play = $$<HTMLButtonElement>('[data-testid="qso-line-play"]');
    await click(play[play.length - 1]!);
    expect(hint()).toBe(before);
    await until("the line to end", () => yourTurn());
    expect(hint()).toBe(before);
  });
});

/** A helper on the console's `__cwt`, called as it would be there. */
const cwt = (name: string, ...args: unknown[]) =>
  act(async () => {
    (window as unknown as { __cwt: Record<string, (...a: unknown[]) => unknown> }).__cwt[name]!(...args);
  });

describe("__cwt.suggestedReplies() on the console", () => {
  it("shows the reply suggested before each line you sent, above it, with the suggested reply off", async () => {
    await open({ qsoTheirText: "before", qsoHints: "off", user: USER });
    const call = callIn(await send("CQ SST W7YFR"));
    await send(`${call} ROB OR`);
    expect($('[data-testid="qso-past-hint"]'), "not until asked").toBeNull();
    // Lines sent before it was called show theirs too.
    await cwt("suggestedReplies");
    const log = [...$$('[data-testid="qso-past-hint"], li[data-line]')];
    const past = log.filter((li) => li.matches('[data-testid="qso-past-hint"]'));
    expect(past).toHaveLength(2);
    for (const li of past) expect(log[log.indexOf(li) + 1]!.classList.contains("you")).toBe(true);
    await cwt("suggestedReplies", false);
    expect($('[data-testid="qso-past-hint"]')).toBeNull();
  });

  it("is listed by __cwt.help(), with the other helpers", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await cwt("help");
      const text = String(info.mock.calls.at(-1)?.[0]);
      expect(text).toContain("__cwt.suggestedReplies");
      expect(text).toContain("__cwt.micDebug");
    } finally {
      info.mockRestore();
    }
  });
});

describe("Save session, with the debug buttons on", () => {
  it("saves every line, the suggested reply before each of yours, and the clean audio, in one file", async () => {
    window.history.replaceState({}, "", "/?micdebug");
    const saved: Blob[] = [];
    const real = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => {
      saved.push(b as Blob);
      return "blob:saved";
    };
    try {
      await open({ qsoTheirText: "before", qsoHints: "off", user: USER });
      const call = callIn(await send("CQ SST W7YFR"));
      await send(`${call} ROB OR`);
      await click($('[data-testid="debug-session"]'));
      await until("the file", () => saved.length > 0);
      // jsdom's Blob has no text(): read it as a FileReader would.
      const text = await new Promise<string>((done) => {
        const reader = new FileReader();
        reader.onload = () => done(reader.result as string);
        reader.readAsText(saved[0]!);
      });
      const file = JSON.parse(text) as {
        lines: { you: boolean; text: string; hint?: string }[];
        wav: string | null;
      };
      const yours = file.lines.filter((l) => l.you);
      expect(yours.length).toBe(2);
      // Kept even with the suggested reply off.
      expect(yours.every((l) => typeof l.hint === "string" && l.hint.length > 0)).toBe(true);
      expect(file.lines.some((l) => !l.you)).toBe(true);
      expect(file.wav, "the clean audio").toMatch(/^UklGR/);
    } finally {
      URL.createObjectURL = real;
      window.history.replaceState({}, "", "/");
    }
  });
});
