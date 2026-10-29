/* A run on the QSO page, and the guide's examples of each kind of QSO.
 * See qso-rig.tsx for how the page is driven.
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { $, $$, callIn, click, ended, fill, key, mount, open, press, send, state, theirs, unmount, until, useQsoRig, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const tally = () => $('[data-testid="qso-tally"]');

describe("a run", () => {
  it("works one station after another, and the next one calls on its own", async () => {
    await open({ qsoTheirText: "before" });
    const call = callIn(await send("CQ CWT W7YFR"));
    expect(tally()?.dataset.format).toBe("cwt");
    expect(tally()?.dataset.made).toBe("0");

    await send(`${call} BOB 1234`);
    // Your TU ends the QSO. The station sends nothing back, the session goes
    // on, and the next station calls without being asked.
    const before = theirs().length;
    await key("TU W7YFR");
    await until("the next station", () => theirs().length > before);
    expect(ended(), "the session goes on").toBe(false);
    expect(tally()?.dataset.made).toBe("1");
    expect(callIn(theirs()[theirs().length - 1]!)).not.toBe(call);
  });

  it("answers your CQ between QSOs at once", async () => {
    await open({ qsoTheirText: "before" });
    const call = callIn(await send("CQ CWT W7YFR"));
    await send(`${call} BOB 1234`);
    // A CWT station sends nothing after your TU, so your CQ comes first.
    await key("TU W7YFR");
    const next = await send("CQ CWT W7YFR");
    expect(callIn(next)).not.toBe(call);
    expect(tally()?.dataset.made).toBe("1");
  });

  it("shows the examples beside the log on a wide screen, on the run's format", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("min-width"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await open({ qsoTheirText: "before" });
    await send("CQ SST W7YFR");
    const help = $('[data-testid="qso-help-open"]')!;
    await click(help);
    expect($('[data-testid="qso-help"]'), "no dialog where there is room").toBeNull();
    expect($('[data-testid="qso-side"] [data-testid="qso-examples"]')?.dataset.shown).toBe("sst");
    expect(help.getAttribute("aria-pressed")).toBe("true");
    await click(help);
    expect($('[data-testid="qso-side"]')).toBeNull();
  });

  it("opens the guide on the run's format", async () => {
    await open({ qsoTheirText: "before" });
    await send("CQ POTA DE W7YFR");
    await until("your turn", () => yourTurn());
    await click($('[data-testid="qso-help-open"]'));
    expect($('[data-testid="qso-examples"]')?.dataset.shown).toBe("pota");
    await press("Escape");
  });
});

describe("the report at the end of a QSO", () => {
  const rows = () => $$('[data-testid="qso-report"] tbody tr:not(.side)');

  it("shows each item both ways once the QSO is over", async () => {
    await open({ qsoTheirText: "before", user: { callsign: "W7YFR", name: "BOB" } });
    const call = callIn(await send("CQ CWT W7YFR"));
    expect($('[data-testid="qso-report"]'), "none while the QSO runs").toBeNull();
    await send(`${call} BOB 1234`);
    await key("TU W7YFR");
    await until("the report", () => $('[data-testid="qso-report"]') !== null);
    // Call, name and number from the station; call, name and number from you.
    expect(rows()).toHaveLength(6);
    expect(rows().some((r) => r.dataset.ok === "false"), "nothing wrong").toBe(false);
  });

  it("shows in a run with copy once the next station calls, under a divider", async () => {
    await open({ qsoTheirText: "copy", qsoLockCopy: false });
    await send("CQ CWT W7YFR");
    const call = JSON.parse(localStorage.getItem("cwt:qso") ?? "{}").qso?.them?.call as string;
    await send(`${call} BOB 1234`);
    const before = theirs().length;
    await key("TU W7YFR");
    await until("the next station", () => theirs().length > before);
    expect($('[data-testid="qso-report"]')).not.toBeNull();
    expect($$('[data-testid="qso-divider"]')).toHaveLength(1);
  });

  it("marks your copy of an item wrong", async () => {
    await open({ qsoTheirText: "copy", qsoLockCopy: false });
    await send("CQ CWT W7YFR");
    const box = () => $$<HTMLInputElement>('[data-testid="qso-type"]');
    await fill(box()[0]!, "w1aw");
    await click($('[data-testid="qso-stop"]'));
    await until("the report", () => $('[data-testid="qso-report"]') !== null);
    const callRow = rows()[0]!;
    expect(callRow.dataset.ok).toBe("false");
  });
});

describe("playing a line again during a session", () => {
  it("plays on your turn, with the microphone not read, then your turn starts over", async () => {
    await open({ qsoTheirText: "before", qsoPlayback: "always" });
    await send("CQ CWT W7YFR");
    const play = $$<HTMLButtonElement>('[data-testid="qso-line-play"]');
    const theirPlay = play[play.length - 1]!;
    expect(theirPlay.disabled).toBe(false);
    await click(theirPlay);
    expect(state(), "the microphone is not read while it plays").not.toBe("sending");
    await until("the line to end", () => yourTurn());
    expect(theirs()).toHaveLength(1);
  });
});

describe("playing the last line again with Cmd+Enter", () => {
  it("plays on Ctrl+Enter in the box, without locking it", async () => {
    await open({ qsoTheirText: "copy", qsoPlayback: "always" });
    await send("CQ CWT W7YFR");
    const box = $<HTMLInputElement>('[data-testid="qso-type"]')!;
    box.focus();
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(state(), "the microphone is not read while it plays").not.toBe("sending");
    await until("the line to end", () => yourTurn());
    expect($('[data-testid="qso-type"]'), "the box is still open").not.toBeNull();
  });

  it("plays on Ctrl+Enter anywhere on the page, not just in a box", async () => {
    await open({ qsoTheirText: "before", qsoPlayback: "always" });
    await send("CQ CWT W7YFR");
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(state(), "the microphone is not read while it plays").not.toBe("sending");
    await until("the line to end", () => yourTurn());
  });

  it("does nothing without the play buttons on every line", async () => {
    await open({ qsoTheirText: "copy", qsoPlayback: "end" });
    await send("CQ CWT W7YFR");
    const box = $<HTMLInputElement>('[data-testid="qso-type"]')!;
    box.focus();
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(state()).toBe("sending");
  });
});

describe("the guide's examples", () => {
  const shown = () => $('[data-testid="qso-examples"]')?.dataset.shown;
  const kind = (id: string) => $(`[data-testid="qso-guide-kinds"] [data-kind="${id}"]`);
  const lines = () => $$('[data-testid="qso-example"] li');
  /** Mount, and let the page settle as it checks the microphone. */
  const ready = async (prefs: Parameters<typeof mount>[0]) => {
    mount(prefs);
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
  };

  it("shows one kind at a time, with your call, and remembers the last one", async () => {
    await ready({ user: { callsign: "W7YFR" } });
    expect(shown()).toBe("cq");
    expect($$('[data-testid="qso-example"]').length).toBe(1);
    expect($$('[data-testid="qso-guide-kinds"] button').map((b) => b.dataset.kind)).toEqual(["cq", "pota", "sst", "mst", "cwt"]);

    await click(kind("sst"));
    expect(shown()).toBe("sst");
    expect(kind("sst")!.getAttribute("aria-pressed")).toBe("true");
    expect(kind("cq")!.getAttribute("aria-pressed")).toBe("false");
    expect(lines()[0]!.textContent).toContain("W7YFR");
    expect(lines().filter((l) => l.classList.contains("them")).length).toBeGreaterThan(0);

    unmount();
    await ready({ user: { callsign: "W7YFR" }, qsoGuide: "sst" });
    expect(shown()).toBe("sst");
  });
});
