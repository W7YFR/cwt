/* Which of your overs the rag chew model answers, and which the scripts do:
 * a request to send again, above all a ? keyed apart from its word. */

import { describe, expect, it } from "vitest";
import { answer, chatsOn, newQso, Over, type Qso } from "@/qso/cq";
import { detailsOf, rejected, replyPrompt, systemPrompt, toCw, toEnglish, unlabeled, yourTurn } from "@/qso/ragchew";
import { randomStation } from "@/qso/station";
import { fistFor } from "@/timing/fist";
import { EMPTY_USER } from "@/io/storage";
import { failureOf } from "@/llm/engine";
import { CHAT_WORDS } from "@/qso/chatwords";
import { vocabulary } from "@/qso/vocabulary";
import { readWords, type Spaced } from "@/timing/segment";

const ear = { lenient: true, saved: "W7YFR" };

/** A fixed sequence, so the stations are the same every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

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

  it("keeps a short CW word beside a piece of a word keyed apart", () => {
    expect(toEnglish("IS THAT HARD ON UR CR OP S", [])).toBe("is that hard on ur cr op s");
    expect(toEnglish("GUD OP", [])).toBe("good operator");
    expect(toEnglish("OP HR IS BOB", [])).toBe("operator here is bob");
    expect(toEnglish("UR SIG IS 599", [])).toBe("your signal is 599");
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

describe("a reply that is not words", () => {
  /** Replies the model wrote in Morse code on the live site. */
  const MORSE = [
    "..-.-. ..- .. --- .-.. / -.-. --- -.. .-.. -.-. .-.. -..- / ..- -.-. -..- -..- / ..-.. --- / ..-.-. --- -.. .-.. -.-. .-.. -..-",
    ".-.. --- ..- / -.-. --- -.. .-.. -.-. .-.. -..-",
    "...-.. --- / ..-.. --- / ..-.-. --- -..- / ..- -..- -.-. .-.. -..-",
  ];

  it("keys nothing for Morse code, or for a reply with no letter in it", () => {
    for (const m of [...MORSE, "/ . / . /", "599 599", "   "]) expect(toCw(m), m).toBe("");
  });

  it("still keys a sentence, and one with a stray dash or slash", () => {
    expect(toCw("Snow here today. How is the weather there?")).toBe("SNOW HR TODAY BT HOW IS THE WX THERE? BK");
    expect(toCw("My antenna is a 40/80 dipole - it works well.")).toBe("MY ANT IS A 40/80 DIPOLE IT WORKS WELL BK");
    expect(toCw("I run 5 W - just a KX2 / and a wire.")).not.toBe("");
  });

  it("says why the station does not send a line", () => {
    const them = stages().done.them;
    const d = detailsOf(them);
    expect(rejected(null, "", "", d, "")).toBe("error");
    expect(rejected("  ", "", "", d, "")).toBe("empty");
    expect(rejected(MORSE[0]!, toCw(MORSE[0]!), "", d, "")).toBe("morse");
    expect(rejected("Nice rig.", "NICE RIG BK", "RIG HR IS FT9999", d, "")).toBe(null);
    expect(rejected("My FT9999 is great.", "MY FT9999 IS FB BK", "RIG HR IS FT9999", d, "")).toBe("borrows");
    expect(rejected("Nice rig here.", "NICE RIG HR BK", "", d, "NICE RIG HR BT WX SUNNY BK")).toBe("opening");
  });

  it("does not send a line that reads yours back to you", () => {
    const d = detailsOf(stages().done.them);
    const heard = "IS THAT HARD ON UR CR OP S OR IS THAT THE C OR R E CT CL IM AT I FOR THE W";
    const back =
      'You\'re asking if the dry weather is hard on my crops, or if that\'s the correct claim for the word "operator". ' +
      "The dry weather can be tough on my crops, but I've learned to manage it.";
    expect(rejected(back, toCw(back), heard, d, "")).toBe("restates");
    for (const e of ["Lynn: you said it was hard?", "If I understand you, yes.", "It sounds like you have rain."]) {
      expect(rejected(e, toCw(unlabeled(e)), heard, d, ""), e).toBe("restates");
    }
    const kept = "Yes, the dry weather is hard on the crops some years.";
    expect(rejected(kept, toCw(kept), heard, d, "")).toBe(null);
  });
});

describe("the station's prompt", () => {
  const user = { ...EMPTY_USER, name: "ROB", qthCity: "SEATTLE", qthRegionShort: "WA" };
  const stations = Array.from({ length: 200 }, (_, i) => randomStation(seeded(i + 1)));

  it("says plain English and no Morse code before the facts", () => {
    const them = stations[0]!;
    const p = systemPrompt(them, detailsOf(them), user, { wpm: 15, yourWpm: null });
    const rule = p.indexOf("Never write dots, dashes or Morse code");
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(p.indexOf("Facts about you"));
    expect(p).not.toContain("by Morse code");
  });

  it("gives a bug as an interest only to a station that sends with one", () => {
    let bugs = 0;
    for (const them of stations) {
      const { fist: _, ...rest } = them;
      const keyer = detailsOf(rest);
      const bug = detailsOf({ ...rest, fist: fistFor("bug", 1)! });
      const straight = detailsOf({ ...rest, fist: fistFor("straight", 1)! });
      expect(keyer.interest).not.toBe("USE A BUG");
      expect(keyer.interest).not.toBe("ARE IN THE SKCC");
      expect(straight.interest).not.toBe("USE A BUG");
      // The other details stay as they were.
      expect({ ...keyer, interest: "" }).toEqual({ ...bug, interest: "" });
      if (bug.interest === "USE A BUG") {
        bugs++;
        // In its place: contests on a keyer, the Straight Key Century Club on a straight key.
        expect(keyer.interest).toBe("LIKE CONTESTS");
        expect(straight.interest).toBe("ARE IN THE SKCC");
      }
    }
    expect(bugs).toBeGreaterThan(0);
  });

  it("gives the SKCC to a straight key or a bug, and contests to a keyer in its place", () => {
    let skcc = 0;
    for (const them of stations) {
      const { fist: _, ...rest } = them;
      const straight = detailsOf({ ...rest, fist: fistFor("straight", 1)! });
      const bug = detailsOf({ ...rest, fist: fistFor("bug", 1)! });
      if (straight.interest !== "ARE IN THE SKCC" || bug.interest !== "ARE IN THE SKCC") continue;
      skcc++;
      expect(detailsOf(rest).interest).toBe("LIKE CONTESTS");
    }
    expect(skcc).toBeGreaterThan(0);
  });

  it("says each interest as the station's own, in the second person", () => {
    for (const them of stations) {
      const p = systemPrompt(them, detailsOf(them), user, { wpm: 15, yourWpm: null });
      expect(p).not.toMatch(/\bYou (uses|builds|is|chases|restores|likes|also likes)\b/);
    }
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

describe("a sign-off, with Lenient on", () => {
  it("is a 73 in a word or keyed apart, but not one inside a number", () => {
    for (const h of ["TNX 73", "R73", "73SK", "UR 599 R73", "7 3 SK", "TNX FERQSO"]) expect(new Over(h, ear).closing(), h).toBe(true);
    for (const h of ["FB RIG HR IS IC7300", "LIC IN 1973", "RIG IC 7300"]) expect(new Over(h, ear).closing(), h).toBe(false);
  });

  it("leaves a rag chew about an IC7300 going", () => {
    expect(chatsOn(stages().done, "FB RIG HR IS IC7300 BK", ear)).toBe(true);
  });
});

describe("your suggested reply in a rag chew", () => {
  const them = stages().done.them;
  const user = { ...EMPTY_USER, name: "ROB", qthCity: "SEATTLE", qthRegionShort: "WA", rigManufacturer: "ICOM", rigModel: "IC7300", rigPower: "100" };

  it("gives the model only the facts User holds", () => {
    const p = replyPrompt(them, user);
    expect(p).toContain("ICOM IC7300 at 100W");
    expect(p).not.toContain("Antenna:");
    expect(replyPrompt(them, EMPTY_USER)).not.toContain("Facts about you");
  });

  it("sends the chat as one message from you, with the station's last line set apart at the end", () => {
    const name = `${them.name.charAt(0)}${them.name.slice(1).toLowerCase()}`;
    const turns = yourTurn(them, user, [
      { role: "user", content: "great rig here is ic7300" },
      { role: "assistant", content: "Nice radio. What antenna?" },
      { role: "user", content: "a dipole" },
      { role: "assistant", content: "Dipoles work well. How high is it?" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("user");
    const text = turns[0]!.content;
    expect(text).toContain("Rob: great rig here is ic7300");
    expect(text).toContain(`${name}: Nice radio. What antenna?`);
    expect(text).not.toContain(`${name}: Dipoles work well`);
    expect(text).toContain(`${name} just said: Dipoles work well. How high is it?`);
    expect(text.indexOf("just said")).toBeGreaterThan(text.indexOf("Rob: a dipole"));
  });

  it("drops a speaker's name the model writes before the line", () => {
    expect(unlabeled("Rob: My antenna is a dipole.")).toBe("My antenna is a dipole.");
    expect(unlabeled("My antenna is a dipole.")).toBe("My antenna is a dipole.");
  });
});
