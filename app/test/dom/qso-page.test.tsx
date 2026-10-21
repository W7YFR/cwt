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
  mount,
  note,
  open,
  press,
  send,
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
  it("is the practice page's, in the Audio settings", async () => {
    mount({ gainDb: 6 });
    await click($('[data-testid="panel-toggle"]'));
    const level = $<HTMLInputElement>("#gain")!;
    expect(level.closest('[data-panel="audio"]'), "with the microphone").not.toBeNull();
    // The Audio settings are the practice page's own, calibration and all.
    expect($('[data-panel="audio"] #input-device')).not.toBeNull();
    expect($('[data-panel="audio"] [data-testid="calpick"] #calibration')).not.toBeNull();
    expect(level.value).toBe("6");
    await slide("gain", 12);
    expect(loadPrefs().gainDb).toBe(12);
    expect($("#gain-out")?.textContent).toContain("12");
  });
});

describe("anatomy of a QSO", () => {
  it("is on the page until the first QSO, then behind the ?", async () => {
    mount({});
    const guide = () => $('[data-testid="qso-guide"]');
    expect(guide()?.textContent).toContain("CQ CQ DE KD9XYZ K");
    expect(guide()!.querySelectorAll(".qsoexample").length).toBe(1);
    expect($('[data-testid="qso-help-open"]'), "no ? while the guide is on the page").toBeNull();

    // Its settings link opens the settings. Open, it points at them instead.
    await click($('[data-testid="qso-guide-settings"]'));
    expect($('[data-testid="panel-toggle"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($('[data-testid="qso-guide-settings"]')).toBeNull();
    expect(guide()!.textContent).toContain(
      "Change your speed and configure the QSO parameters in the settings panel.",
    );

    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    expect(guide()).toBeNull();

    await click($('[data-testid="qso-help-open"]'));
    const help = $('[data-testid="qso-help"]')!;
    expect(help.querySelector("#qsohelp-title")!.textContent).toBe("Anatomy of a QSO");
    expect(help.textContent).toContain("CQ CQ DE KD9XYZ K");
    await press("Escape");
    expect($('[data-testid="qso-help"]')).toBeNull();
  });

  it("changes the page in one step on Start", async () => {
    mount({});
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    /** Which parts are on the page. */
    const parts = () =>
      [
        $('[data-testid="qso-guide"]') ? "guide" : "",
        $('[data-testid="qso-help-open"]') ? "?" : "",
        $('[data-testid="qso-stop"]') ? "stop" : "",
      ]
        .filter(Boolean)
        .join("+");
    const seen = [parts()];
    await act(async () => {
      $<HTMLButtonElement>('[data-testid="qso-start"]')!.click();
    });
    for (let t = 0; t < 2000 && seen[seen.length - 1] !== "?+stop"; t += 16) {
      await wait(16);
      const now = parts();
      if (now !== seen[seen.length - 1]) seen.push(now);
    }
    // The guide, then the running session: never one without the other.
    expect(seen).toEqual(["guide", "?+stop"]);
  });

  it("comes back after a session that sent nothing", async () => {
    mount({});
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    expect($('[data-testid="qso-guide"]')).toBeNull();
    await click($('[data-testid="qso-stop"]'));
    expect($('[data-testid="qso-guide"]')).not.toBeNull();
    expect($('[data-testid="qso-help-open"]')).toBeNull();
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
    expect($$('[data-testid="qso-hotkeys"] kbd').map((k) => k.textContent)).toEqual(["R", "Enter"]);
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
