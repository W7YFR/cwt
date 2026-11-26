/* The robot that pulses while the rag chew model writes: a row in the log
 * for the station's line, and a robot in the suggested reply for yours. The
 * model is a fake that can be held. See qso-rig.tsx for how the page is
 * driven. */

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { KEY_WORDS } from "@/qso/ragchew";
import { $, $$, callIn, click, key, open, send, theirs, until, useQsoRig, wait, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

const model = vi.hoisted(() => ({
  /** Whether the station's line and your suggested reply wait for `free`. */
  hold: { chat: false, suggest: false },
  /** The calls held, each let go by calling it. */
  held: [] as Array<() => void>,
  /** The system prompt of each station line asked for. */
  systems: [] as string[],
}));

/** Let every held call go. */
const free = () =>
  act(async () => {
    for (const go of model.held.splice(0)) go();
  });

vi.mock("@/llm/engine", async (real) => {
  const answer = <T,>(on: boolean, v: T): Promise<T> =>
    on ? new Promise<T>((done) => model.held.push(() => done(v))) : Promise.resolve(v);
  return {
    ...(await real<typeof import("@/llm/engine")>()),
    modelState: () => ({ kind: "ready" }),
    check: async () => {},
    downloaded: async () => [],
    wake: async () => {},
    chat: (system: string) => {
      model.systems.push(system);
      return answer(model.hold.chat, "Nice. My radio here is a TS590 at 100 watts.");
    },
    suggest: () => answer(model.hold.suggest, "Rob: Nice rig. What antenna do you use?"),
  };
});

useQsoRig();

const USER = { callsign: "W7YFR", name: "ROB", qthCity: "SEATTLE", qthRegionShort: "WA" };
const waitRow = () => $('[data-testid="qso-model-wait"]');
const hintRobot = () => $('[data-testid="qso-hint"] [data-key="model"]');
const lineCount = () => $$(".qsolog li[data-line]").length;

/** Your CQ and the exchange, up to the rag chew. */
async function exchange(): Promise<void> {
  model.hold = { chat: false, suggest: false };
  model.held = [];
  model.systems = [];
  localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
  // With the station's speed shown, as its line's robot sits beside it.
  await open({
    qsoTheirText: "before",
    qsoHints: "always",
    qsoRagChew: true,
    qsoRagChewHints: true,
    qsoLength: "full",
    qsoShowTheirSpeed: true,
    user: USER,
  });
  const call = callIn(await send("CQ CQ DE W7YFR W7YFR K"));
  await send(`${call} DE W7YFR UR 599 599 NAME ROB ROB QTH SEATTLE WA BK`);
}

const CHAT = "FB RIG HR IS K3 ES ANT IS DIPOLE BK";

describe("the robot while the model writes the station's line", () => {
  it("pulses in a row after your line, which the station's line takes the place of", async () => {
    await exchange();
    model.hold.chat = true;
    const before = theirs().length;
    const lines = lineCount();
    await key(CHAT);
    await until("the robot's row", () => waitRow() !== null);
    expect(waitRow()!.querySelector('[data-key="model"]')?.getAttribute("data-busy")).toBe("reply");
    // Your line is in the log, the row is after it, and the row is no line.
    expect(lineCount()).toBe(lines + 1);
    expect($$(".qsolog li").at(-2)?.classList.contains("you")).toBe(true);

    await free();
    // The row stays until the station's line is in the log, and no longer.
    await until("the robot to go", () => waitRow() === null);
    expect(theirs().length).toBe(before + 1);
    const mark = theirs().at(-1)!.querySelector('[data-key="model"]');
    expect(mark).not.toBeNull();
    expect(mark!.hasAttribute("data-busy")).toBe(false);
    expect(mark!.classList.contains("busy")).toBe(false);
  });

  it("goes on Stop, and does not come back when the model answers late", async () => {
    await exchange();
    model.hold.chat = true;
    const before = theirs().length;
    await key(CHAT);
    await until("the robot's row", () => waitRow() !== null);
    await click($('[data-testid="qso-stop"]'));
    expect(waitRow()).toBeNull();

    await free();
    await wait(5000);
    expect(waitRow()).toBeNull();
    expect(theirs().length).toBe(before);
  });
});

describe("the robot while the model writes your suggested reply", () => {
  it("pulses in the suggested reply until the model's reply takes its place", async () => {
    await exchange();
    model.hold.suggest = true;
    const before = theirs().length;
    await key(CHAT);
    await until("the station's line", () => theirs().length > before);
    await until("your turn", () => yourTurn());
    expect(hintRobot()?.getAttribute("data-busy")).toBe("hint");

    await free();
    await until("the model's reply", () => $('[data-testid="qso-hint"] code')?.textContent === "NICE RIG BT WHAT ANT DO U USE? BK");
    expect(hintRobot()).toBeNull();
  });

  it("goes on Pause, and the late reply does not bring it back", async () => {
    await exchange();
    model.hold.suggest = true;
    const before = theirs().length;
    await key(CHAT);
    await until("the station's line", () => theirs().length > before);
    await until("your turn", () => yourTurn());
    expect(hintRobot()).not.toBeNull();
    await click($('[data-testid="qso-pause"]'));
    expect(hintRobot()).toBeNull();

    await free();
    await click($('[data-testid="qso-continue"]'));
    await until("your turn", () => yourTurn());
    expect(hintRobot()).toBeNull();
  });
});

describe("the station's key in a rag chew", () => {
  it("is the key Paddle gives it, in the prompt and on the line", async () => {
    // In pieces, as a straight key sends slowly: a question goes to the model.
    model.systems = [];
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
    await open({
      qsoTheirText: "before",
      qsoRagChew: true,
      qsoLength: "pieces",
      qsoShowTheirSpeed: true,
      keyStyle: "only",
      styleKeys: ["straight"],
      user: USER,
    });
    const call = callIn(await send("CQ CQ DE W7YFR W7YFR K"));
    await send(`${call} DE W7YFR UR 599 599 BK`);
    const line = await send("WHAT RIG ?");
    expect(model.systems.at(-1)).toContain(KEY_WORDS.straight);
    expect(model.systems.at(-1)).not.toContain(KEY_WORDS.keyer);
    expect(line.querySelector('.lkey[data-key="straight"]')).not.toBeNull();
  });
});
