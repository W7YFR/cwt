/* Which of your overs the rag chew model answers, and which the scripts do:
 * a request to send again, above all a ? keyed apart from its word. */

import { describe, expect, it } from "vitest";
import { answer, chatsOn, newQso, Over, type Qso } from "@/qso/cq";
import { toCw, toEnglish } from "@/qso/ragchew";
import { failureOf } from "@/llm/engine";
import { CHAT_WORDS } from "@/qso/chatwords";
import { vocabulary } from "@/qso/vocabulary";
import { readWords, type Spaced } from "@/timing/segment";

const ear = { lenient: true, saved: "W7YFR" };

/** A standard QSO with the station partway through its exchange, piece by
 *  piece, and the same QSO with the exchange done. */
function stages(): { pieces: Qso; done: Qso } {
  const ctx = { ear, length: "pieces" as const, rand: () => 0.3, hour: 20 };
  let q = answer(newQso(() => 0.3), "CQ CQ CQ DE W7YFR K", ctx).qso;
  q = answer(q, `${q.them.call} DE W7YFR UR RST IS 5NN 5NN NAME IS ROB ROB QTH IS SEATTLE SEATTLE BK`, ctx).qso;
  return { pieces: q, done: { ...q, stage: "exchanged" } };
}

const AGAIN = ["?", "R ?", "AGN?", "SRI AGN?", "PSE AGN BK", "AB2MJ DE W7YFR AGN K", "QRZ?"];
const QUESTIONS = ["RR TU NICK X <BT> WHAT RIG ?", "WHAT RIG?", "WATTS ?", "BK ARE U USING A STRAIGHT KEY ?", "SO ANT ? DE W7YFR BK"];

describe("a request to send again", () => {
  it("is ?, AGN? or AGN with nothing else said", () => {
    for (const h of AGAIN) expect(new Over(h, ear).asksAgain(), h).toBe(true);
  });

  it("is not a ? keyed apart after a word, or AGN among other words", () => {
    for (const h of [...QUESTIONS, "GUD TO WORK U AGN BK", "PSE NAME AGN"]) expect(new Over(h, ear).asksAgain(), h).toBe(false);
  });

  it("leaves a ? keyed apart as a question the scripts cannot place", () => {
    for (const h of QUESTIONS) expect(new Over(h, ear).puzzles(), h).toBe(true);
    for (const h of AGAIN) expect(new Over(h, ear).puzzles(), h).toBe(false);
  });
});

describe("the overs the model answers", () => {
  const { pieces, done } = stages();

  it("takes a question mid-exchange and after it", () => {
    expect(pieces.stage).toBe("pieces");
    for (const h of QUESTIONS) {
      expect(chatsOn(pieces, h, ear), h).toBe(true);
      expect(chatsOn(done, h, ear), h).toBe(true);
    }
  });

  it("takes any other over once the exchange is done", () => {
    for (const h of ["R FB", "NICE TO MEET U", "GUD TO WORK U AGN BK", "PSE NAME AGN"]) expect(chatsOn(done, h, ear), h).toBe(true);
  });

  it("leaves the exchange's own overs to the scripts mid-exchange", () => {
    for (const h of ["R FB", "HW CPY?", "NICE TO MEET U"]) expect(chatsOn(pieces, h, ear), h).toBe(false);
  });

  it("never takes a request to send again, a sign-off or QRS", () => {
    for (const h of [...AGAIN, "73 TU", "QRS PSE"]) {
      expect(chatsOn(pieces, h, ear), h).toBe(false);
      expect(chatsOn(done, h, ear), h).toBe(false);
    }
  });
});

describe("your over in English for the model", () => {
  it("reads R as roger only at the start of a sentence, before a word it knows", () => {
    expect(toEnglish("BK RR NICE TO MEET U", ["W7YFR"])).toBe("roger nice to meet you");
    expect(toEnglish("R R TNX BT R FB", [])).toBe("roger thanks. roger great");
    expect(toEnglish("R", [])).toBe("roger");
  });

  it("keeps an R that may be part of a word keyed apart", () => {
    expect(toEnglish("BK RR WHAT IS THE I R W E BS I TI ?", ["W7YFR"])).toBe("roger what is the i r w e bs i ti?");
    expect(toEnglish("R OB ROB K", [])).toBe("r ob rob");
  });

  it("drops the word an error sign takes back", () => {
    expect(toEnglish("MY ANT IS DIPLE EEEEEE DIPOLE BK", [])).toBe("my antenna is dipole");
  });

  it("reads prosigns: <BT> ends a sentence, <AR> and BK hand over, <AS> is wait", () => {
    expect(toEnglish("RIG IS IC7300 <BT> ANT DIPOLE <AR>", [])).toBe("radio is ic7300. antenna dipole");
    expect(toEnglish("<AS> PHONE BK", [])).toBe("wait. phone");
  });
});

describe("reading your sending by meaning in a rag chew", () => {
  /** Characters with gaps: `|` before a character is a gap of `share` of the
   *  cut, a space a sure word break, nothing a sure letter gap. */
  const spaced = (text: string, share: number): Spaced[] => {
    const out: Spaced[] = [];
    let gap: number | null = null;
    for (const ch of text) {
      if (ch === "|") gap = share;
      else if (ch === " ") gap = 3;
      else {
        out.push({ char: ch, gap: out.length === 0 ? null : (gap ?? 0.4) });
        gap = null;
      }
    }
    return out;
  };
  const chat = new Set(vocabulary(["W7YFR", "ROB", "WA", ...CHAT_WORDS]));

  it("joins the words of a chat keyed a little apart", () => {
    for (const share of [0.8, 1.0, 1.2]) {
      expect(readWords(spaced("RIG IS YA|ES|U FT|710", share), chat)).toBe("RIG IS YAESU FT710");
      expect(readWords(spaced("ANT IS A|N E|F|HW", share), chat)).toBe("ANT IS AN EFHW");
      expect(readWords(spaced("MY R|A|D|I|O", share), chat)).toBe("MY RADIO");
      expect(readWords(spaced("VE|RT|I|CAL OR HOR|I|Z|ON|TAL", share), chat)).toBe("VERTICAL OR HORIZONTAL");
    }
  });

  it("still reads your name keyed apart", () => {
    expect(readWords(spaced("NAME IS R|OB", 1.0), chat)).toBe("NAME IS ROB");
  });
});

describe("the model's English as CW", () => {
  it("keys a contraction as one word, as an operator does", () => {
    expect(toCw("I'm glad it's sunny. That's great, I've been waiting.")).toBe("IM GLAD ITS SUNNY BT THATS FB IVE BEEN WAITING BK");
  });

  it("puts BT between sentences and lets commas go", () => {
    expect(toCw("Yes, Rob, I've used a few radios over the years. That was a long time ago, though.")).toBe(
      "YES ROB IVE USED A FEW RADIOS OVER THE YRS BT THAT WAS A LONG TIME AGO THOUGH BK",
    );
  });
});

describe("why the model did not download or load", () => {
  it("names each failure from what the browser, WebLLM or the GPU threw", () => {
    const quota = Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
    expect(failureOf(quota)).toBe("space");
    expect(failureOf(Object.assign(new Error("Integrity verification failed for x.wasm"), { name: "IntegrityError" }))).toBe("check");
    expect(failureOf(new Error("Device was lost. This can happen due to insufficient memory"))).toBe("graphics");
    expect(failureOf(new Error("Cannot initialize runtime because of requested maxBufferSize exceeds limit"))).toBe("graphics");
    expect(failureOf(new TypeError("Failed to fetch"))).toBe("network");
    expect(failureOf(new Error("Something else"))).toBe("other");
  });
});
