/* The page around a QSO: the listening level, the guide, and pausing. See
 * qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { loadPrefs } from "@/io/storage";
import {
  $,
  $$,
  click,
  fill,
  mount,
  note,
  open,
  press,
  send,
  settingsTab,
  slide,
  state,
  unmount,
  until,
  useQsoRig,
  wait,
  yourTurn,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("the listening level", () => {
  it("is the practice page's, in Sound, beside the microphone in Microphone", async () => {
    mount({ gainDb: 6 });
    // The microphone and its calibration, as on the practice page.
    await settingsTab("microphone");
    expect($('[data-panel="microphone"] #input-device')).not.toBeNull();
    expect($('[data-panel="microphone"] [data-testid="calpick"] #calibration')).not.toBeNull();
    await settingsTab("sound");
    const level = $<HTMLInputElement>("#gain")!;
    expect(level.closest('[data-panel="audio"]')).not.toBeNull();
    expect(level.value).toBe("6");
    await slide("gain", 12);
    expect(loadPrefs().gainDb).toBe(12);
    expect($("#gain-out")?.textContent).toContain("12");
  });
});

describe("anatomy of a QSO", () => {
  it("is on the page until the first QSO, and in Help always", async () => {
    mount({});
    const guide = () => $('[data-testid="qso-guide"]');
    expect(guide()?.textContent).toContain("CQ CQ DE KD9XYZ K");
    expect(guide()!.querySelectorAll(".qsoexample").length).toBe(1);

    // Its settings link opens the settings. Open, it points at them instead.
    await click($('[data-testid="qso-guide-settings"]'));
    expect($('[data-testid="panel-toggle"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($('[data-testid="qso-guide-settings"]')).toBeNull();
    await press("Escape");
    expect($('[data-testid="panel-toggle"]')!.getAttribute("aria-pressed")).toBe("false");

    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    expect(guide()).toBeNull();

    await click($('[data-testid="help-open"]'));
    expect($('[data-testid="help"]')!.textContent).toContain("CQ CQ DE KD9XYZ K");
    await press("Escape");
    await wait(200);
    expect($('[data-testid="help"]')).toBeNull();
    // Help's Esc is Help's: the session goes on.
    expect($('[data-testid="qso-stop"]')).not.toBeNull();
  });

  it("changes the page in one step on Start", async () => {
    mount({});
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    /** Which parts are on the page. */
    const parts = () =>
      [
        $('[data-testid="qso-guide"]') ? "guide" : "",
        $('[data-testid="qso-stop"]') ? "stop" : "",
      ]
        .filter(Boolean)
        .join("+");
    const seen = [parts()];
    await act(async () => {
      $<HTMLButtonElement>('[data-testid="qso-start"]')!.click();
    });
    for (let t = 0; t < 2000 && seen[seen.length - 1] !== "stop"; t += 16) {
      await wait(16);
      const now = parts();
      if (now !== seen[seen.length - 1]) seen.push(now);
    }
    // The guide, then the running session: never one without the other.
    expect(seen).toEqual(["guide", "stop"]);
  });

  it("comes back after a session that sent nothing", async () => {
    mount({});
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    expect($('[data-testid="qso-guide"]')).toBeNull();
    await click($('[data-testid="qso-stop"]'));
    expect($('[data-testid="qso-guide"]')).not.toBeNull();
  });
});

describe("pausing and going on", () => {
  it("pauses, then goes on with the station's last over played again, on its own line", async () => {
    await open({ qsoTheirText: "before" });
    await send("CQ CQ DE W7YFR W7YFR K");
    const lines = () => $$(".qsolog li").length;
    const before = lines();

    await click($('[data-testid="qso-pause"]'));
    expect($('[data-testid="qso-stop"]')).toBeNull();
    expect($('[data-testid="qso-continue"]')).not.toBeNull();
    expect($('[data-testid="qso-restart"]')).not.toBeNull();
    // Paused, the QSO is not over: the station's call stays as it was.
    expect(note()).toBe("");

    await click($('[data-testid="qso-continue"]'));
    await until("the last over to play again", () => state() === "receiving");
    await until("the turn to come back", () => yourTurn());
    expect(lines(), "played again, not added").toBe(before);
  });

  it("comes back after a reload, to go on with", async () => {
    await open({ qsoTheirText: "before" });
    await send("CQ CQ DE W7YFR W7YFR K");
    const shown = $(".qsolog")!.textContent;

    // The page goes, without a Stop, and comes back.
    unmount();
    mount({ qsoTheirText: "before" });
    expect($(".qsolog")!.textContent).toBe(shown);
    await until("the Continue button", () => {
      const b = $<HTMLButtonElement>('[data-testid="qso-continue"]');
      return !!b && !b.disabled;
    });
    expect($('[data-testid="qso-restart"]')).not.toBeNull();
    expect($('[data-testid="qso-guide"]')).toBeNull();
  });
});

describe("settings that do nothing as things are", () => {
  it("dims Typing's settings until the station's lines are copied, and slots' until you copy in slots", async () => {
    mount({ qsoTheirText: "before" });
    await settingsTab("copy");
    const choices = () => $$<HTMLButtonElement>('[data-testid="qso-copy-input"] button');
    const gradeTyping = () => $<HTMLInputElement>("#qso-grade-typing")!;
    expect(choices().every((b) => b.disabled), "Copy in, with nothing to copy").toBe(true);
    expect($<HTMLInputElement>("#qso-lock-copy")!.disabled).toBe(true);
    // Its ? says why.
    const tip = $("#qso-lock-copy")!.closest(".group")!.querySelector(".helpdot")!.getAttribute("aria-describedby")!;
    expect(document.getElementById(tip)!.textContent).toMatch(/^Needs/);

    await settingsTab("page");
    await click($$<HTMLButtonElement>('[data-testid="qso-their-text"] button').find((b) => b.textContent === "Copy")!);
    await settingsTab("copy");
    expect(choices().some((b) => b.disabled)).toBe(false);
    expect(gradeTyping().disabled, "slots' own, in a box").toBe(true);
    await click(choices().find((b) => b.textContent === "Slots")!);
    expect(gradeTyping().disabled).toBe(false);
  });
});

describe("hiding the station's call", () => {
  it("blurs its call until you copy it", async () => {
    await open({ qsoTheirText: "copy", qsoBlurCall: true });
    await send("CQ CQ DE W7YFR W7YFR K");
    const call = JSON.parse(localStorage.getItem("cwt:qso") ?? "{}").qso?.them?.call as string;
    expect($('[data-testid="qso-who-blurred"]')).not.toBeNull();

    await fill($<HTMLInputElement>('[data-testid="qso-type"]')!, call.toLowerCase());
    expect($('[data-testid="qso-who-blurred"]'), "unblurred").toBeNull();
    expect($(".qsolog li.them .who")!.textContent).toBe(call);
  });
});
