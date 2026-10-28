/* Copy in slots on the QSO page, and Clear. See qso-rig.tsx for how the page
 * is driven.
 */

import { describe, expect, it, vi } from "vitest";
import { keyableSymbols } from "@/morse";
import {
  $,
  $$,
  click,
  fill,
  key,
  lastSent,
  open,
  press,
  send,
  state,
  until,
  useQsoRig,
  yourTurn,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

/** What each slot of the station's last line wants typed, in order. */
function wanted(): string[] {
  return lastSent()
    .split(/\s+/)
    .flatMap((w) => keyableSymbols(w))
    .map((c) => c.replace(/[<>]/g, ""));
}

const slots = () => $$<HTMLInputElement>('[data-testid="copy-slot"]');

/** A QSO in Copy mode with slots, with the station's answer to the CQ. */
async function slotsAnswer(prefs: Parameters<typeof open>[0] = {}): Promise<void> {
  await open({ qsoTheirText: "copy", qsoCopyInput: "slots", ...prefs });
  await send("CQ CQ DE W7YFR W7YFR K");
}

/** Fill every slot right, in order. */
async function fillRight(): Promise<void> {
  const want = wanted();
  const open = slots();
  expect(open).toHaveLength(want.length);
  for (let i = 0; i < open.length; i++) await fill(open[i]!, want[i]!);
}

/** Choose how you enter copy, in the settings. */
async function enterAs(label: string): Promise<void> {
  if ($('[data-testid="panel-toggle"]')?.getAttribute("aria-pressed") !== "true") {
    await click($('[data-testid="panel-toggle"]'));
  }
  const button = $$<HTMLButtonElement>('[data-testid="qso-copy-input"] button').find((b) => b.textContent === label);
  await click(button ?? null);
  expect(button!.getAttribute("aria-pressed")).toBe("true");
}

describe("copy in slots", () => {
  it("gives a slot for each character the station sent, and no box", async () => {
    await slotsAnswer();
    expect(slots()).toHaveLength(wanted().length);
    expect($('[data-testid="qso-type"]')).toBeNull();
  });

  it("shows the station's call once your slots hold it", async () => {
    await slotsAnswer();
    expect($(".qsolog li.them .who")!.textContent).toBe("Station");
    await fillRight();
    const call = lastSent().split(/\s+/).find((w) => /\d/.test(w) && w !== "W7YFR")!;
    expect($(".qsolog li.them .who")!.textContent).toBe(call);
  });

  it("locks on Enter, and grades every slot right", async () => {
    await slotsAnswer({ qsoLockedShows: "grade" });
    await fillRight();
    slots()[0]!.focus();
    await press("Enter");
    expect(slots()).toHaveLength(0);
    const locked = $('[data-testid="copy-slots-locked"]')!;
    expect(locked).not.toBeNull();
    expect(locked.querySelectorAll(".yourcopy .cright")).toHaveLength(wanted().length);
    expect(locked.querySelectorAll(".cwrong")).toHaveLength(0);
    expect($('[data-testid="qso-stop"]'), "Enter did not stop the session").not.toBeNull();
  });

  it("marks a slot left empty as missed", async () => {
    await slotsAnswer({ qsoLockedShows: "grade" });
    await fill(slots()[0]!, wanted()[0]!);
    slots()[0]!.focus();
    await press("Enter");
    const locked = $('[data-testid="copy-slots-locked"]')!;
    expect(locked.querySelectorAll(".yourcopy .cright")).toHaveLength(1);
    expect(locked.querySelectorAll(".sentcopy .cwrong")).toHaveLength(wanted().length - 1);
  });

  it("locks the slots when you start sending", async () => {
    await slotsAnswer();
    await fill(slots()[0]!, wanted()[0]!);
    await key("QRS K");
    await until("the slots to lock", () => $('[data-testid="copy-slots-locked"]') !== null);
    expect(slots()).toHaveLength(0);
    await until("the turn to come back", () => yourTurn());
  });

  it("keeps what you typed in a box apart, when you switch to it mid-line", async () => {
    await slotsAnswer();
    await enterAs("Box");
    expect(slots()).toHaveLength(0);
    expect($('[data-testid="qso-type"]')).not.toBeNull();
    await enterAs("Slots");
    expect(slots()).toHaveLength(wanted().length);
  });
});

describe("Clear", () => {
  const clear = () => $<HTMLButtonElement>('[data-testid="qso-clear"]')!;

  it("is off while a session runs, and clears the log once it is stopped", async () => {
    await open({ qsoTheirText: "before" });
    expect(clear().disabled, "off with nothing in the log").toBe(true);
    await send("CQ CQ DE W7YFR W7YFR K");
    expect(clear().disabled, "off while the session runs").toBe(true);

    await click($('[data-testid="qso-stop"]'));
    await until("the session to stop", () => state() === "over");
    expect(clear().disabled).toBe(false);

    await click(clear());
    expect($$(".qsolog li")).toHaveLength(0);
    expect($('[data-testid="qso-guide"]')).not.toBeNull();
    expect(state()).toBe("ready");
    expect(clear().disabled).toBe(true);
    expect(localStorage.getItem("cwt:qso"), "a reload does not bring it back").toBeNull();
  });
});

describe("a slot copy put right after it locks", () => {
  it("opens again with Edit, keeps what you typed, and locks again on Enter", async () => {
    await slotsAnswer({ qsoAllowEdits: true });
    await fill(slots()[0]!, "x");
    await press("Enter");
    expect(slots(), "locked").toHaveLength(0);

    await click($('[data-testid="qso-line-edit"]'));
    expect(slots().length).toBeGreaterThan(0);
    expect(slots()[0]!.value).toBe("X");
    expect($('[data-testid="qso-line-edit"]'), "no Edit on an open copy").toBeNull();
    await fillRight();
    await press("Enter");
    expect(slots()).toHaveLength(0);
  });
});

describe("grading slots as you type", () => {
  it("marks each filled slot right or wrong, only when on", async () => {
    await slotsAnswer({ qsoGradeTyping: true });
    const want = wanted();
    await fill(slots()[0]!, want[0]!);
    await fill(slots()[1]!, want[1] === "Q" ? "X" : "Q");
    // The mark is on the slot's cell, around the box.
    const mark = (i: number) => slots()[i]!.parentElement!.className;
    expect(mark(0)).toContain("cright");
    expect(mark(1)).toContain("cwrong");
    expect(mark(2)).not.toMatch(/cright|cwrong/);
  });

  it("leaves the slots unmarked when off", async () => {
    await slotsAnswer();
    await fill(slots()[0]!, wanted()[0]!);
    expect(slots()[0]!.parentElement!.className).not.toMatch(/cright|cwrong/);
  });
});
