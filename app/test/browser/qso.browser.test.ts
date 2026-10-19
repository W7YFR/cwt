/* A whole QSO in real audio: the real microphone path, copy worker and
 * player, on the real clock. The one QSO test that runs this way. The rest
 * run on a fake clock with those three stood in for, in the dom tier and in
 * qso-look.browser.test.ts. This one shows that the parts stood in for do
 * their part. See qso-page-harness.ts for how the page is driven.
 */

import { describe, expect, it } from "vitest";
import {
  EXCHANGE,
  QSO_MS,
  $$,
  callIn,
  key,
  note,
  open,
  send,
  status,
  theirs,
  until,
  useQsoPage,
  yourTurn,
} from "./qso-page-harness";

useQsoPage();

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
    await until("the turn to come back", () => yourTurn());
    expect(note()).toBe("The QSO is over. Call CQ for the next one.");
  }, QSO_MS);
});
