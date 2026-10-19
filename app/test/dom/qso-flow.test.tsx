/* A whole QSO from your CQ to 73, QRS, and what the page says at each turn.
 * See qso-rig.tsx for how the page is driven.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXCHANGE,
  $,
  $$,
  callIn,
  ended,
  key,
  note,
  open,
  send,
  status,
  theirs,
  until,
  useQsoRig,
  yourTurn,
} from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

describe("a QSO from your CQ", () => {
  it("runs from CQ to 73, and says it is over once the last over has played", async () => {
    await open({ qsoTheirText: "before" });

    // Between your K and its first character, it says it is about to send.
    await key("CQ CQ DE W7YFR W7YFR K");
    await until("the wait before the answer", () => status() === "Waiting for the other station.");
    await until("the answer", () => theirs().length === 1);
    expect(status()).toBe("The other station is sending.");
    await until("the turn to come back", () => yourTurn());
    // It answers with its call.
    callIn(theirs()[0]!);
    // Your over, as copied. Not the first word: under load a character of it
    // can be misread, and the station still finds the CQ.
    expect($$(".qsolog li.you .text")[0]!.textContent).toContain("DE W7YFR W7YFR K");

    const exchange = await send(EXCHANGE);
    expect(exchange.textContent).toMatch(/ NAME | OP /);
    expect(note(), "no note while the QSO runs").toBe("");

    // The last over: the note must wait for it to finish playing.
    const before = theirs().length;
    await key("R TNX 73 <SK>");
    await until("the last over to start", () => theirs().length > before);
    expect(status()).toBe("The other station is sending.");
    expect(note(), "no note while the last over plays").toBe("");
    await until("the session to stop", ended);
    expect(note(), "a note once the last over has played").not.toBe("");
    expect($('[data-testid="qso-tape"]'), "the QSO can be played back").not.toBeNull();
  });

  it("sends its last over again, slower, on QRS", async () => {
    await open({ qsoTheirText: "before" });
    const first = await send("CQ CQ DE W7YFR W7YFR K");
    const again = await send("QRS K");
    expect(again.querySelector(".text")!.textContent).toBe(first.querySelector(".text")!.textContent);
    // Halfway from 45 down to the bottom step: 25, between 24 and 26, so 24.
    expect($('[data-testid="qso-their-speed"]')?.textContent).toBe("The station sends at 45/24 wpm.");
  });
});

describe("the session's own words", () => {
  it("says to call CQ between QSOs, and that it is your turn during one", async () => {
    await open({ qsoTheirText: "before" });
    expect(status()).toBe("Call CQ to make a contact.");
    // The keys, drawn as the practice page draws them.
    expect($$('[data-testid="qso-hotkeys"] kbd').map((k) => k.textContent)).toEqual([
      "R",
      "Enter",
      "Esc",
    ]);
    await send("CQ CQ DE W7YFR W7YFR K");
    expect(status()).toBe("Your turn.");
  });
});
