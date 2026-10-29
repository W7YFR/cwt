/* Copying the station: the copy boxes through a whole QSO, and the station's
 * label. See qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXCHANGE,
  $,
  $$,
  click,
  ended,
  fill,
  key,
  lastSent,
  open,
  press,
  row,
  send,
  showTheirs,
  theirs,
  until,
  useQsoRig,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("copying the station", () => {
  it("keeps the copy open after the last over, and grades it on request", async () => {
    // Lock off, so the first box is still open when the last over ends.
    await open({ qsoTheirText: "before", qsoLockCopy: false });
    await send("CQ CQ DE W7YFR W7YFR K");

    // Copy on mid-QSO: the over already read gets no box.
    await showTheirs("Copy");
    expect($$('[data-testid="qso-type"]')).toHaveLength(0);

    await send(EXCHANGE);
    const boxes = () => $$<HTMLInputElement>('[data-testid="qso-type"]');
    expect(boxes()).toHaveLength(1);
    // The first three words of the station's line, as it sent them.
    const typed = lastSent().split(" ").slice(0, 3).join(" ");
    await fill(boxes()[0]!, typed.toLowerCase());

    const before = theirs().length;
    await key("R TNX 73 <SK>");
    await until("the last over", () => theirs().length > before);
    await until("the session to stop", ended);
    expect(boxes(), "both boxes open after the last over").toHaveLength(2);
    expect($('[data-testid="qso-grade"]'), "the copy waits to be graded").not.toBeNull();
    await fill(boxes()[1]!, "tu 73");

    await click($('[data-testid="qso-grade"]'));
    expect(boxes()).toHaveLength(0);
    const graded = $$(".qsolog .graded");
    expect(graded).toHaveLength(2);
    // Your copy as typed, over what was sent, then the count.
    expect(row(graded[0]!, "yourcopy")).toBe(typed);
    expect(row(graded[0]!, "sentcopy").startsWith(`${typed} `)).toBe(true);
    expect(graded[0]!.querySelector(".copied")!.textContent).toMatch(/^\d+ of \d+ copied$/);
    expect($('[data-testid="qso-tape"]'), "the QSO can be played back").not.toBeNull();
  });

  it("labels the station's lines Station until you have its call", async () => {
    await open({ qsoTheirText: "copy" });
    await send("CQ CQ DE W7YFR W7YFR K");
    const label = () => theirs()[0]!.querySelector(".who")!.textContent;
    expect(label()).toBe("Station");
    expect($('[data-testid="qso-type"]')?.getAttribute("aria-label")).toBe("Your copy of Station");

    // Stop ends the QSO, and its call shows.
    await click($('[data-testid="qso-stop"]'));
    expect(label()).toMatch(/^[A-Z0-9]?[A-Z]\d[A-Z]+$/);
  });
});

describe("a copy put right after it locks", () => {
  it("has no Edit unless edits are allowed", async () => {
    await open({ qsoTheirText: "copy" });
    await send("CQ CQ DE W7YFR W7YFR K");
    await fill($<HTMLInputElement>('[data-testid="qso-type"]')!, "k9um");
    await press("Enter");
    expect($('[data-testid="qso-locked"]')).not.toBeNull();
    expect($('[data-testid="qso-line-edit"]')).toBeNull();
  });

  it("opens the box again with Edit, with what you typed in it", async () => {
    await open({ qsoTheirText: "copy", qsoAllowEdits: true });
    await send("CQ CQ DE W7YFR W7YFR K");
    const box = () => $<HTMLInputElement>('[data-testid="qso-type"]');
    await fill(box()!, "k9um");
    await press("Enter");
    expect(box(), "locked").toBeNull();

    await click($('[data-testid="qso-line-edit"]'));
    expect(box()!.value).toBe("k9um");
    await fill(box()!, "k4um");
    await press("Enter");
    expect($('[data-testid="qso-locked"]')?.textContent).toBe("K4UM");
  });
});
