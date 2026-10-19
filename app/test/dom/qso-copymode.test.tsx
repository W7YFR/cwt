/* The Copy mode options: when your copy locks, and how it is graded. See qso-
 * page-harness.ts for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import { type Prefs } from "@/io/storage";
import {
  EXCHANGE,
  $,
  $$,
  fill,
  key,
  open,
  press,
  row,
  send,
  showTheirs,
  theirs,
  until,
  useQsoRig,
  wait,
  yourTurn,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("copy mode options", () => {
  /** A QSO in Copy mode, with the station's answer to the CQ in a box. */
  async function copyAnswer(prefs: Prefs): Promise<HTMLInputElement> {
    await open({ qsoTheirText: "copy", ...prefs });
    await send("CQ CQ DE W7YFR W7YFR K");
    const box = $<HTMLInputElement>('[data-testid="qso-type"]');
    expect(box).not.toBeNull();
    await fill(box!, "w7yfr de");
    return box!;
  }

  it("locks your copy when you start sending", async () => {
    await copyAnswer({});
    await key("QRS K");
    await until("the copy to lock", () => $('[data-testid="qso-locked"]') !== null);
    expect($('[data-testid="qso-locked"]')!.textContent).toBe("W7YFR DE");
    expect($$('[data-testid="qso-type"]')).toHaveLength(0);
    await until("the turn to come back", () => yourTurn());
  });

  it("does not lock it for a single stray character", async () => {
    await copyAnswer({});
    // One dit: a click, or the key bumped. Not you sending.
    await key("E");
    await wait(600);
    expect($$('[data-testid="qso-type"]'), "still open").toHaveLength(1);
    expect($('[data-testid="qso-locked"]')).toBeNull();
  });

  it("locks it on Enter, and grades it at once when asked", async () => {
    const box = await copyAnswer({ qsoLockedShows: "grade" });
    box.focus();
      await press("Enter");
    expect($$('[data-testid="qso-type"]')).toHaveLength(0);
    // Spaces aside: lined up with the station's answer, which varies, your
    // copy can take a column's space between its characters.
    expect(row($(".qsolog .graded")!, "yourcopy").replace(/ /g, "")).toBe("W7YFRDE");
    expect($('[data-testid="qso-stop"]'), "Enter did not stop the session").not.toBeNull();

  });

  it("shows only your copy marked, when asked, with a blank for each character left out", async () => {
    // The exchange, which always opens with your call and DE. The answer to
    // the CQ has wordings that do not.
    await open({ qsoTheirText: "before", qsoLockedShows: "right" });
    await send("CQ CQ DE W7YFR W7YFR K");
    await showTheirs("Copy");
    await send(EXCHANGE);
    const box = $<HTMLInputElement>('[data-testid="qso-type"]')!;
    await fill(box, "w7yfr de");
    box.focus();
      await press("Enter");
    const shown = $('[data-testid="qso-right-only"]');
    expect(shown).not.toBeNull();
    // Your copy, W7YFR DE, as typed: each character right. The rest of the
    // station's line is blanks, each marked missed, so the copy does not look
    // whole. Nothing of the station's characters or the count shows.
    expect(shown!.textContent!.trimEnd()).toBe("W7YFR DE");
    expect(shown!.querySelectorAll(".cright")).toHaveLength(7);
    const missed = [...shown!.querySelectorAll(".cwrong")];
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((m) => m.textContent === " "), "missed as blanks").toBe(true);
    expect($(".qsolog .sentcopy"), "the station's line kept back").toBeNull();
    expect($(".qsolog .copied"), "no count").toBeNull();
  });

  it("leaves your copy open while you send, with Lock off", async () => {
    await copyAnswer({ qsoLockCopy: false });
    const before = theirs().length;
    await key("QRS K");
    await until("the answer", () => theirs().length > before);
    expect($$('[data-testid="qso-type"]').length).toBeGreaterThan(0);
    expect($('[data-testid="qso-locked"]')).toBeNull();
    await until("the turn to come back", () => yourTurn());
  });
});
