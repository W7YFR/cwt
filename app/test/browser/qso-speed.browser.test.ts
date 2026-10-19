/* Speeds: yours on the sliders, and the speed shown on each line. See qso-
 * page-harness.ts for how the page is driven.
 */

import { describe, expect, it } from "vitest";
import { loadSpeed } from "@/io/storage";
import {
  WPM,
  QSO_MS,
  $,
  $$,
  click,
  mount,
  open,
  send,
  slide,
  until,
  useQsoPage,
  yourTurn,
} from "./qso-page-harness";

useQsoPage();

describe("your speed", () => {
  it("is the practice page's speed, on its sliders in the settings, and locks while a session runs", async () => {
    mount({ charWpm: 20, farnsworthWpm: 15 });
    const field = (id: string) => $<HTMLInputElement>(`#${id}`)!;
    // In the settings, as their own Speed section.
    expect(field("wpm").closest("[inert]"), "closed with the settings").not.toBeNull();
    await click($('[data-testid="panel-toggle"]'));
    expect(field("wpm").closest('[data-panel="speed"]')).not.toBeNull();
    expect(field("wpm").closest("[inert]"), "open to change").toBeNull();
    expect(field("wpm").value).toBe("20");
    expect(field("farns").value).toBe("15");
    expect($("#wpm-out")?.textContent).toContain("20");
    expect($('[data-testid="qso-their-speed"]'), "no speed line until QRS or QRQ").toBeNull();

    await slide("wpm", 30);
    expect(loadSpeed()).toEqual({ charWpm: 30, farnsworthWpm: 15 });
    // Overall cannot pass character speed: its slider stops there.
    expect(field("farns").max).toBe("30");
    await slide("wpm", 12);
    expect(loadSpeed()).toEqual({ charWpm: 12, farnsworthWpm: 12 });

    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    expect(field("wpm").closest("[inert]"), "locked while it runs").not.toBeNull();
    expect(field("input-device").closest("[inert]"), "the microphone too").not.toBeNull();
    expect(field("calibration").closest("[inert]"), "and its calibration").not.toBeNull();
    expect($('[data-testid="qso-length"]')!.closest("[inert]"), "the rest can still change").toBeNull();
    expect($('[data-testid="qso-their-text"]')!.closest("[inert]"), "and what shows").toBeNull();
  }, QSO_MS);
});

describe("the station's speed on its lines", () => {
  it("shows the speed the station sent each line at, and follows QRS", async () => {
    await open({ qsoTheirText: "before", qsoShowTheirSpeed: true });
    await send("CQ CQ DE W7YFR W7YFR K");
    const speeds = () => $$('.qsolog li.them [data-testid="qso-line-wpm"]').map((e) => e.textContent);
    expect(speeds()).toEqual([`${WPM} wpm`]);
    expect($('.qsolog li.you [data-testid="qso-line-wpm"]'), "yours stays off").toBeNull();
    await send("QRS K");
    expect(speeds()).toEqual([`${WPM} wpm`, `${WPM}/24 wpm`]);
  }, QSO_MS);
});

describe("your speed on each line", () => {
  it("shows the speed you sent each over at", async () => {
    await open({ qsoTheirText: "before", qsoShowSpeed: true });
    await send("CQ CQ DE W7YFR W7YFR K");
    const shown = $('[data-testid="qso-line-wpm"]')?.textContent ?? "";
    const wpm = Number(/^(\d+)/.exec(shown)?.[1]);
    expect(shown).toMatch(/ wpm$/);
    expect(Math.abs(wpm - WPM), `measured ${shown} for ${WPM}`).toBeLessThanOrEqual(3);
  }, QSO_MS);
});
