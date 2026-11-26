/* The suggested reply in a rag chew: once the model writes the station's
 * lines, it writes your suggested reply too. The model is a fake. See
 * qso-rig.tsx for how the page is driven. */

import { describe, expect, it, vi } from "vitest";
import { $, callIn, open, send, until, useQsoRig } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

const model = vi.hoisted(() => ({
  /** Your reply, as the fake model writes it, or null for none. */
  yours: "Rob: Nice rig. What antenna do you use?" as string | null,
  asked: 0,
}));

vi.mock("@/llm/engine", async (real) => ({
  ...(await real<typeof import("@/llm/engine")>()),
  modelState: () => ({ kind: "ready" }),
  check: async () => {},
  downloaded: async () => [],
  wake: async () => {},
  chat: async () => "Nice. My radio here is a TS590 at 100 watts.",
  suggest: async () => {
    model.asked++;
    return model.yours;
  },
}));

useQsoRig();

const hint = () => $('[data-testid="qso-hint"] code')?.textContent ?? null;
const USER = { callsign: "W7YFR", name: "ROB", qthCity: "SEATTLE", qthRegionShort: "WA" };

/** Into the rag chew: your CQ, the exchange, then a line of chat, which the
 *  model answers. */
async function chatting(hints = true): Promise<HTMLElement> {
  localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
  await open({ qsoTheirText: "before", qsoHints: "always", qsoRagChew: true, qsoRagChewHints: hints, qsoLength: "full", user: USER });
  const call = callIn(await send("CQ CQ DE W7YFR W7YFR K"));
  await send(`${call} DE W7YFR UR 599 599 NAME ROB ROB QTH SEATTLE WA BK`);
  return send("FB RIG HR IS K3 ES ANT IS DIPOLE BK");
}

describe("the suggested reply in a rag chew", () => {
  it("is the model's reply to the station's line, in CW words", async () => {
    model.yours = "Rob: Nice rig. What antenna do you use?";
    const line = await chatting();
    expect(line.querySelector(".text")?.textContent).toContain("TS590");
    await until("the model's reply", () => hint() !== null);
    expect(hint()).toBe("NICE RIG BT WHAT ANT DO U USE? BK");
  });

  it("is none, not a sign-off, when the model has no reply", async () => {
    model.yours = null;
    const asked = model.asked;
    await chatting();
    await until("the model asked", () => model.asked > asked);
    expect(hint()).toBeNull();
  });

  it("is not asked of the model when the setting is off", async () => {
    model.yours = "Rob: Nice rig. What antenna do you use?";
    const asked = model.asked;
    await chatting(false);
    await until("a suggested reply", () => hint() !== null);
    expect(model.asked).toBe(asked);
    expect(hint()).not.toBe("NICE RIG BT WHAT ANT DO U USE? BK");
  });
});
