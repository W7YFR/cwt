/* The station's lines as Exchange: no lines show, a box for each item of
 * its exchange, and the log as a logbook. See qso-rig.tsx for how the page
 * is driven. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { $, $$, click, fill, key, open, press, until, useQsoRig, wait, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const USER = { callsign: "W7YFR", name: "ROB", qthRegionShort: "OR" };

/** The session as kept: its lines and the QSO under way, with the station. */
const kept = () =>
  JSON.parse(localStorage.getItem("cwt:qso") ?? "null") as {
    lines: { you: boolean; qso: number }[];
    qso: { them: { call: string; name: string; nr: string } };
    finished: number | null;
  };
const boxes = () => $$<HTMLInputElement>('[data-testid="qso-item"]');
const labels = () => boxes().map((b) => b.dataset.label);
const rows = () => $$('[data-testid="qso-book-row"]');
const hint = () => $('[data-testid="qso-hint"] code')?.textContent ?? null;

/** Key `text`, then wait for the station's next line and your turn. Its
 *  lines do not show, so the count is read from the kept session. */
async function send(text: string): Promise<void> {
  const theirs = () => (kept()?.lines ?? []).filter((l) => !l.you).length;
  const before = theirs();
  await key(text);
  await until(`an answer to ${text}`, () => theirs() > before);
  await until("the turn to come back", () => yourTurn());
}

/** A CWT QSO up to the station's exchange, with its call and name typed. */
async function cwtExchange(name?: string) {
  await send("CQ CWT W7YFR");
  const { call, name: its, nr } = kept().qso.them;
  await fill(boxes()[0]!, call);
  await send(`${call} ROB OR`);
  await fill(boxes()[1]!, name ?? its);
  return { call, nr };
}

describe("Exchange", () => {
  it("shows no boxes until the station answers, and no lines", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    await key("HI");
    await wait(3000);
    expect(boxes()).toHaveLength(0);

    await send("CQ CQ DE W7YFR K");
    expect(labels()).toEqual(["Call", "Report", "Name", "QTH"]);
    expect($$(".qsolog li.them, .qsolog li.you")).toHaveLength(0);
  });

  it("gives a CWT's number or state one box", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    await send("CQ CWT W7YFR");
    expect(labels()).toEqual(["Call", "Name", "Number or state"]);
  });

  it("grades a full copy once you stop typing, as a row of the logbook", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    const { nr } = await cwtExchange("BOO");
    await fill(boxes()[2]!, nr || "WA");
    await key("TU W7YFR");
    await until("the row", () => rows().length === 1, 10_000);

    const cells = [...rows()[0]!.querySelectorAll<HTMLElement>(".bookcell")].map((c) => c.dataset.ok);
    expect(cells[0]).toBe("true");
    expect(cells[1]).toBe("false");
    expect($('[data-testid="qso-book-score"]')?.textContent).toMatch(/^\d of 3$/);
  });

  it("waits for Enter while a box is empty", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    await cwtExchange();
    await key("TU W7YFR");
    await until("the QSO's end", () => kept().finished !== null);
    await wait(3000);
    expect(rows()).toHaveLength(0);
    // Enter in the last box grades it.
    boxes()[2]!.focus();
    await press("Enter");
    await until("the row", () => rows().length === 1);
  });

  it("opens and closes a row", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    await cwtExchange();
    await key("TU W7YFR");
    await until("the QSO's end", () => kept().finished !== null);
    boxes()[2]!.focus();
    await press("Enter");
    await until("the row", () => rows().length === 1);

    const toggle = $<HTMLButtonElement>('[data-testid="qso-book-toggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()[0]!.querySelector(".bookmore")!.hasAttribute("inert")).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows()[0]!.querySelectorAll(".bookmore li.them").length).toBeGreaterThan(0);
    expect(rows()[0]!.querySelector(".bookmore")!.hasAttribute("inert")).toBe(false);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts your turn over on Option+Shift+R from a box", async () => {
    await open({ qsoTheirText: "exchange", user: USER });
    await send("CQ CWT W7YFR");
    const { call } = kept().qso.them;
    await key("QQQ XYZ");
    const box = boxes()[0]!;
    box.focus();
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(box.value, "nothing typed into the box").toBe("");
    await send(`${call} ROB OR`);
    const yours = kept().lines.filter((l) => l.you).map((l) => (l as unknown as { text: string }).text);
    expect(yours.some((t) => t.includes("QQQ"))).toBe(false);
  });

  it("puts what you typed in the suggested reply, never what was sent", async () => {
    await open({ qsoTheirText: "exchange", qsoHints: "always", user: USER });
    await send("CQ CWT W7YFR");
    const { call } = kept().qso.them;
    expect(hint()).not.toContain(call);
    await fill(boxes()[0]!, "K1XYZ");
    expect(hint()).toContain("K1XYZ");
    expect(hint()).not.toContain(call);
  });
});
