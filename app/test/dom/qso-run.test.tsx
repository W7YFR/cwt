/* A run on the QSO page, and the guide's examples of each kind of QSO.
 * See qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import { $, $$, callIn, click, ended, key, mount, open, press, send, theirs, unmount, until, useQsoRig, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

const tally = () => $('[data-testid="qso-tally"]');

describe("a run", () => {
  it("works one station after another, and the next one calls on its own", async () => {
    await open({ qsoTheirText: "before" });
    const call = callIn(await send("CQ CWT W7YFR"));
    expect(tally()?.dataset.format).toBe("cwt");
    expect(tally()?.dataset.made).toBe("0");

    await send(`${call} BOB 1234`);
    // Your TU ends the QSO. The station sends nothing back, the session goes
    // on, and the next station calls without being asked.
    const before = theirs().length;
    await key("TU W7YFR");
    await until("the next station", () => theirs().length > before);
    expect(ended(), "the session goes on").toBe(false);
    expect(tally()?.dataset.made).toBe("1");
    expect(callIn(theirs()[theirs().length - 1]!)).not.toBe(call);
  });

  it("answers your CQ between QSOs at once", async () => {
    await open({ qsoTheirText: "before" });
    const call = callIn(await send("CQ CWT W7YFR"));
    await send(`${call} BOB 1234`);
    // A CWT station sends nothing after your TU, so your CQ comes first.
    await key("TU W7YFR");
    const next = await send("CQ CWT W7YFR");
    expect(callIn(next)).not.toBe(call);
    expect(tally()?.dataset.made).toBe("1");
  });

  it("shows the examples beside the log on a wide screen, on the run's format", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("min-width"),
      addEventListener() {},
      removeEventListener() {},
    }));
    await open({ qsoTheirText: "before" });
    await send("CQ SST W7YFR");
    const help = $('[data-testid="qso-help-open"]')!;
    await click(help);
    expect($('[data-testid="qso-help"]'), "no dialog where there is room").toBeNull();
    expect($('[data-testid="qso-side"] [data-testid="qso-examples"]')?.dataset.shown).toBe("sst");
    expect(help.getAttribute("aria-pressed")).toBe("true");
    await click(help);
    expect($('[data-testid="qso-side"]')).toBeNull();
  });

  it("opens the guide on the run's format", async () => {
    await open({ qsoTheirText: "before" });
    await send("CQ POTA DE W7YFR");
    await until("your turn", () => yourTurn());
    await click($('[data-testid="qso-help-open"]'));
    expect($('[data-testid="qso-examples"]')?.dataset.shown).toBe("pota");
    await press("Escape");
  });
});

describe("the guide's examples", () => {
  const shown = () => $('[data-testid="qso-examples"]')?.dataset.shown;
  const kind = (id: string) => $(`[data-testid="qso-guide-kinds"] [data-kind="${id}"]`);
  const lines = () => $$('[data-testid="qso-example"] li');
  /** Mount, and let the page settle as it checks the microphone. */
  const ready = async (prefs: Parameters<typeof mount>[0]) => {
    mount(prefs);
    await until("the Start button", () => !$<HTMLButtonElement>('[data-testid="qso-start"]')!.disabled);
  };

  it("shows one kind at a time, with your call, and remembers the last one", async () => {
    await ready({ user: { callsign: "W7YFR" } });
    expect(shown()).toBe("cq");
    expect($$('[data-testid="qso-example"]').length).toBe(1);
    expect($$('[data-testid="qso-guide-kinds"] button').map((b) => b.dataset.kind)).toEqual(["cq", "pota", "sst", "mst", "cwt"]);

    await click(kind("sst"));
    expect(shown()).toBe("sst");
    expect(kind("sst")!.getAttribute("aria-pressed")).toBe("true");
    expect(kind("cq")!.getAttribute("aria-pressed")).toBe("false");
    expect(lines()[0]!.textContent).toContain("W7YFR");
    expect(lines().filter((l) => l.classList.contains("them")).length).toBeGreaterThan(0);

    unmount();
    await ready({ user: { callsign: "W7YFR" }, qsoGuide: "sst" });
    expect(shown()).toBe("sst");
  });
});
