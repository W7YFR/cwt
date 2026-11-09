/* Part of the station's line played again on the QSO page, as on the Copy
 * page: the selected slot's letter or word, on from the word you copy, and
 * a click or a selection in a line it shows. See qso-rig.tsx for how the
 * page is driven.
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { keyableSymbols } from "@/morse";
import { heard } from "../qso-fakes";
import { $, EXCHANGE, click, fill, lastSent, open, send, theirs, until, useQsoRig, yourTurn } from "../qso-rig";

vi.mock("@/capture/mic", async (real) => (await import("../qso-fakes")).fakeMic(await real()));
vi.mock("@/audio/player", async (real) => (await import("../qso-fakes")).fakePlayer(await real()));

useQsoRig();

/** Option+`code` on `el`, or Alt off a Mac. */
const alt = (el: Element, code: string, key = "") =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, code, altKey: true, bubbles: true }));
  });

/** The part of the line the last replay played, in seconds. */
const lastSpan = () => {
  const [from, to] = heard.spans.at(-1)!;
  expect(from, "a part, not the whole line").toBeTypeOf("number");
  return [from!, to!] as const;
};

/** How long the last replay's line is, in seconds: a 16-bit WAV. */
const lastSec = () => {
  const wav = heard.replays.at(-1)!;
  return (wav.byteLength - 44) / 2 / new DataView(wav).getUint32(24, true);
};

/** In the station's last line, `sel`. */
const inLast = <T extends Element = HTMLElement>(sel: string) => [...theirs().at(-1)!.querySelectorAll<T>(sel)];

const slots = () => inLast<HTMLInputElement>('[data-testid="copy-slot"]');

/** The station's exchange, of several words, and your turn. */
async function exchange(prefs: Parameters<typeof open>[0]): Promise<void> {
  await open({ qsoPlayback: "always", ...prefs });
  await send("CQ CQ DE W7YFR W7YFR K");
  await send(EXCHANGE);
  await until("your turn", yourTurn);
  expect(lastSent().split(/\s+/).length).toBeGreaterThan(2);
}

/** The station's exchange, in slots. */
const slotsAnswer = () => exchange({ qsoTheirText: "copy", qsoCopyInput: "slots" });

/** The first slot of the line's second word. */
const secondWord = () => keyableSymbols(lastSent().split(/\s+/)[0]!).length;

describe("the selected slot's letter and word", () => {
  it("play on Option+L and Option+W, the letter within the word", async () => {
    await slotsAnswer();
    const slot = slots()[secondWord()]!;
    await act(async () => slot.focus());

    await alt(slot, "KeyL");
    const letter = lastSpan();
    await alt(slot, "KeyW");
    const word = lastSpan();
    expect(heard.spans).toHaveLength(2);
    expect(letter[0]).toBeGreaterThan(0);
    expect(word[0]).toBeCloseTo(letter[0], 6);
    expect(word[1]).toBeGreaterThanOrEqual(letter[1]);
    expect(slots()[secondWord()]!.value, "nothing typed").toBe("");
  });

  it("play from the Letter and Word buttons, which keep you in the slot", async () => {
    await slotsAnswer();
    const slot = slots()[secondWord()]!;
    await act(async () => slot.focus());
    await click($('[data-testid="qso-play-letter"]'));
    const letter = lastSpan();
    await click($('[data-testid="qso-play-word"]'));
    expect(lastSpan()[0]).toBeCloseTo(letter[0], 6);
    expect(lastSpan()[1]).toBeGreaterThanOrEqual(letter[1]);
  });

  it("play on from the selected slot's word to the end of the line on Option+Enter", async () => {
    await slotsAnswer();
    const slot = slots()[secondWord()]!;
    await act(async () => slot.focus());
    await alt(slot, "KeyW");
    const word = lastSpan();
    await alt(slot, "Enter", "Enter");
    const [from, to] = lastSpan();
    expect(from).toBeCloseTo(word[0], 6);
    expect(to).toBeGreaterThan(word[1]);
    expect(to, "to the line's end").toBeCloseTo(lastSec(), 1);
  });
});

describe("on from the word you copy in a box", () => {
  it("plays from the word the cursor is in on Option+Enter", async () => {
    await exchange({ qsoTheirText: "copy" });
    const box = inLast<HTMLInputElement>('[data-testid="qso-type"]')[0]!;
    await alt(box, "Enter", "Enter");
    const first = lastSpan();
    await fill(box, `${lastSent().split(/\s+/)[0]} `);
    await alt(box, "Enter", "Enter");
    const second = lastSpan();
    expect(first[0]).toBe(0);
    expect(second[0], "from the second word").toBeGreaterThan(first[0]);
    expect(second[1]).toBeCloseTo(first[1], 6);
    expect($('[data-testid="qso-type"]'), "the box is not locked").not.toBeNull();
  });
});

describe("a click in a line that shows", () => {
  it("plays the word of the character clicked", async () => {
    await exchange({ qsoTheirText: "before" });
    const chars = inLast("[data-t0]");
    expect(chars.length).toBe(lastSent().replace(/\s+/g, "").replace(/<([A-Z]+)>/g, "#").length);
    const at = chars[secondWord()]!;
    await act(async () => {
      at.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const [from, to] = lastSpan();
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThan(Number(at.dataset.t0) + 0.1);
    expect(to).toBeGreaterThan(Number(at.dataset.t1) + 0.1);
  });
});
