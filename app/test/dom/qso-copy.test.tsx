/* Copying the station: the copy boxes through a whole QSO, and the station's
 * label. See qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXCHANGE,
  $,
  $$,
  callIn,
  click,
  fill,
  note,
  open,
  row,
  send,
  showTheirs,
  theirs,
  useQsoRig,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("copying the station", () => {
  it("keeps the copy open after the last over, and grades it on request", async () => {
    // Lock off, so the first box is still open when the last over ends.
    await open({ qsoTheirText: "before", qsoLockCopy: false });
    const call = callIn(await send("CQ CQ DE W7YFR W7YFR K"));

    // Copy on mid-QSO: the over already read gets no box.
    await showTheirs("Copy");
    expect($$('[data-testid="qso-type"]')).toHaveLength(0);

    await send(EXCHANGE);
    const boxes = () => $$<HTMLInputElement>('[data-testid="qso-type"]');
    expect(boxes()).toHaveLength(1);
    await fill(boxes()[0]!, `w7yfr de ${call}`);

    await send("R TNX 73 <SK>");
    expect(boxes(), "both boxes open after the last over").toHaveLength(2);
    expect(note()).toContain("Finish your copy");
    await fill(boxes()[1]!, "tu 73");

    await click($('[data-testid="qso-grade"]'));
    expect(boxes()).toHaveLength(0);
    const graded = $$(".qsolog .graded");
    expect(graded).toHaveLength(2);
    // Your copy as typed, over what was sent, then the count.
    expect(row(graded[0]!, "yourcopy")).toBe(`W7YFR DE ${call}`);
    expect(row(graded[0]!, "sentcopy")).toMatch(new RegExp(`^W7YFR DE ${call} `));
    expect(graded[0]!.querySelector(".copied")!.textContent).toMatch(/^\d+ of \d+ copied$/);
    expect(note()).toBe("The QSO is over. Call CQ for the next one.");
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
