/* How the QSO page looks, where jsdom cannot tell: colors from the style
 * sheet, and where things sit. The QSO runs on the fake clock, as in the dom
 * tier. See qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXCHANGE,
  $,
  click,
  fill,
  open,
  page,
  press,
  send,
  showTheirs,
  until,
  mount,
  useQsoRig,
  yourTurn,
} from "../qso-rig";
import "@/ui/base.css";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("a copy shown right only", () => {
  it("marks each right character with a blue dot, in grey as the station's side is", async () => {
    await open({ qsoTheirText: "before", qsoLockedShows: "right" });
    await send("CQ CQ DE W7YFR W7YFR K");
    await showTheirs("Copy");
    await send(EXCHANGE);
    const box = $<HTMLInputElement>('[data-testid="qso-type"]')!;
    await fill(box, "W7YFR DE");
    box.focus();
    await press("Enter");

    const right = $('[data-testid="qso-right-only"] .cright')!;
    const probe = document.createElement("span");
    probe.style.color = "var(--you)";
    page().append(probe);
    const blue = getComputedStyle(probe).color;
    probe.remove();
    expect(getComputedStyle(right, "::after").backgroundColor).toBe(blue);
    expect(getComputedStyle(right).color).not.toBe(blue);
  });
});

describe("the ? for the guide", () => {
  it("sits at the right end of its row", async () => {
    mount({});
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
    await click($('[data-testid="qso-start"]'));
    await until("the session to start", () => yourTurn());
    const row = $(".qsocontrols")!.getBoundingClientRect();
    const help = $('[data-testid="qso-help-open"]')!.getBoundingClientRect();
    expect(row.width, "laid out").toBeGreaterThan(0);
    expect(Math.abs(row.right - help.right)).toBeLessThanOrEqual(1);
  });
});
