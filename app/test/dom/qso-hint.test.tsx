/* The suggested reply on the QSO page. See qso-rig.tsx for how the page is
 * driven. */

import { describe, expect, it, vi } from "vitest";
import { $, $$, callIn, fill, lastSent, open, send, useQsoRig } from "../qso-rig";

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
    expect(hint()).toBe("CQ CQ DE W7YFR W7YFR K");
    const call = callIn(await send("CQ SST W7YFR"));
    expect(hint()).toBe(`${call} ROB OR`);
  });

  it("suggests the CQ of the kind the examples show", async () => {
    await open({ qsoTheirText: "before", qsoHints: "always", qsoGuide: "pota", user: USER });
    expect(hint()).toBe("CQ POTA DE W7YFR");
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
});
