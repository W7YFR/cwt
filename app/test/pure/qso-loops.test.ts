/* No loops: the station never asks the same thing over and over while you
 * answer it, and never answers a question of yours with its own question.
 *
 * The cases first, then a run of many QSOs with a mock operator who sends
 * good exchanges, parts of them, answers, questions, AGN and noise, in every
 * format, with Strict and Lenient copy. */

import { describe, expect, it } from "vitest";
import { isRun, newRun, respond, type AnyQso, type RunContext, type RunQso } from "@/qso/run";
import { newQso, type Qso } from "@/qso/cq";
import type { FormatId } from "@/qso/formats";

type Rand = () => number;

/** A rand that is the same for the same seed. */
function seeded(seed: number): Rand {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const ME = "W7YFR";

/** A run of `format` with the station at `call`, after it has called. */
function calledBy(format: FormatId, call: string, context: RunContext): AnyQso {
  const fresh = newRun(format, seeded(1), 0, "", ME);
  const qso = { ...fresh, them: { ...fresh.them, call } };
  return respond(qso, `CQ ${format.toUpperCase()} DE ${ME}`, context).qso;
}

/** Send `overs` in turn, and return the station's replies. */
function replies(qso: AnyQso, overs: readonly string[], context: RunContext): (string | null)[] {
  return overs.map((over) => {
    const turn = respond(qso, over, context);
    qso = turn.qso;
    return turn.reply;
  });
}

describe("the station in a run", () => {
  for (const lenient of [false, true]) {
    const context: RunContext = { rand: seeded(7), hour: 10, region: "WA", ear: { lenient, saved: ME } };
    const copy = lenient ? "Lenient" : "Strict";

    it(`sends its call for UR CALL?, not RST? again (${copy})`, () => {
      // As the author saw it: RST? to every UR CALL?.
      const qso = calledBy("pota", "W2UPA", context);
      const [check, again, ...calls] = replies(qso, ["W 2 ?", "A 2", "UR CALL ?", "UR CALL?"], context);
      expect(check).toBe("W2UPA W2UPA");
      expect(["AGN?", "?"]).toContain(again);
      expect(calls).toEqual(["W2UPA W2UPA", "W2UPA W2UPA"]);
    });

    it(`asks AGN? once, then for the item it lacks (${copy})`, () => {
      const qso = calledBy("pota", "W2UPA", context);
      const [first, second] = replies(qso, ["E T", "I T"], context);
      expect(["AGN?", "?"]).toContain(first);
      expect(second).toBe("RST?");
    });

    it(`takes a number it has no item for as nothing new (${copy})`, () => {
      // POTA has no number: A 2 is not part of an exchange.
      expect(replies(calledBy("pota", "W2UPA", context), ["A 2"], context)[0]).toMatch(/^(AGN\?|\?)$/);
    });

    it(`answers RST? with its report before it has sent its exchange (${copy})`, () => {
      expect(replies(calledBy("pota", "W2UPA", context), ["RST?"], context)[0]).toMatch(/5[0-9N]{2} 5[0-9N]{2}/);
    });

    it(`takes a region alone as a region in CWT, and for NR? (${copy})`, () => {
      expect(replies(calledBy("cwt", "W2UPA", context), ["WA"], context)[0]).toBe("NAME?");
      const [ask, next] = replies(calledBy("cwt", "W2UPA", context), ["ROB", "WA"], context);
      expect(ask).toBe("NR?");
      expect(next).not.toBe("NR?");
    });

    it(`sends its call for CALL? after its exchange (${copy})`, () => {
      const qso = calledBy("sst", "W2UPA", context);
      const [, after] = replies(qso, ["ROB WA", "CALL?"], context);
      expect(after).toBe("W2UPA W2UPA");
    });
  }
});

/* The mock operator. */

type Kind = "good" | "part" | "answer" | "ask" | "repeat" | "junk" | "end";
interface Sent {
  readonly text: string;
  readonly kind: Kind;
}

const MINE = { name: "ROB", nr: "1234", st: "WA", serial: "12" };

function noise(r: Rand): string {
  const words = ["A", "2", "E", "T", "EE", "IT", "N", "5", "AN", "TE", "M", "I", "S", "*", "EEEEEEEE", "UR", "R"];
  return Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, words)).join(" ");
}

function exchangeOf(format: FormatId, r: Rand): string {
  switch (format) {
    case "cwt":
      return pick(r, [`${MINE.name} ${MINE.nr}`, `TU ${MINE.name} ${MINE.nr}`, `${MINE.name} ${MINE.st}`]);
    case "sst":
      return pick(r, [`${MINE.name} ${MINE.st}`, `GE ${MINE.name} ${MINE.st}`, `TU ${MINE.name} ${MINE.st} ${MINE.st}`]);
    case "mst":
      return pick(r, [`${MINE.name} ${MINE.serial}`, `TU ${MINE.name} ${MINE.serial}`]);
    case "pota":
      return pick(r, [`UR 5NN 5NN ${MINE.st} ${MINE.st} BK`, `5NN ${MINE.st}`, `TU UR 5NN ${MINE.st} BK`]);
  }
}

/** The items of `format` you send, one at a time. */
const PARTS: Readonly<Record<FormatId, readonly string[]>> = {
  cwt: [MINE.name, MINE.nr, MINE.st],
  sst: [MINE.name, MINE.st],
  mst: [MINE.name, MINE.serial],
  pota: ["5NN", "UR 5NN", MINE.st],
};

/** What each ask of the station wants from you. */
const ANSWERS: Readonly<Record<string, (format: FormatId) => string>> = {
  "NAME?": () => MINE.name,
  "NR?": (f) => (f === "mst" ? MINE.serial : MINE.nr),
  "QTH?": () => MINE.st,
  "RST?": () => "5NN",
};

/** Part of `call` with a ?, as an operator checks it: three characters or
 *  more. Keyed apart only with Lenient copy, which reads it whole. */
function callCheck(call: string, lenient: boolean, r: Rand): string {
  const part = call.slice(0, 3 + Math.floor(r() * (call.length - 3)));
  const forms = [`${part}?`, `${part} ?`];
  if (lenient) forms.push(`${part.split("").join(" ")} ?`);
  return pick(r, forms);
}

const QUESTIONS = ["CALL?", "UR CALL?", "UR CALL ?", "CALL ?", "PSE CALL?", "RST?", "QTH?", "NAME?", "NR?"];

function runOver(qso: RunQso, last: string, lenient: boolean, r: Rand): Sent {
  const c = qso.them.call;
  const x = r();
  if (qso.stage === "called") {
    const answer = ANSWERS[last.trim()];
    if (answer && x < 0.35) {
      const v = answer(qso.format);
      return { text: pick(r, [v, `${v} ${v}`, `R ${v}`, `${v} K`]), kind: "answer" };
    }
    if (x < 0.4) return { text: pick(r, [`${c} ${exchangeOf(qso.format, r)}`, exchangeOf(qso.format, r)]), kind: "good" };
    if (x < 0.55) {
      const one = pick(r, PARTS[qso.format]);
      return { text: pick(r, [`${c} ${one}`, one]), kind: "part" };
    }
    if (x < 0.8) return { text: r() < 0.3 ? callCheck(c, lenient, r) : pick(r, QUESTIONS), kind: "ask" };
    if (x < 0.88) return { text: pick(r, ["AGN", "?", "AGN?", "QRZ?", "PSE AGN"]), kind: "repeat" };
    return { text: noise(r), kind: "junk" };
  }
  if (x < 0.3) return { text: pick(r, ["TU", "TU 73", `TU ${c} 73`, "R TU"]), kind: "end" };
  if (x < 0.65) return { text: pick(r, [...QUESTIONS, "UR RST?", "PSE QTH?", "QTH AGN"]), kind: "ask" };
  if (x < 0.8) return { text: pick(r, ["AGN", "?", "AGN?"]), kind: "repeat" };
  return { text: noise(r), kind: "junk" };
}

function cqOver(qso: Qso, last: string, lenient: boolean, r: Rand): Sent {
  const c = qso.them.call;
  const x = r();
  if (qso.stage === "cq") return { text: `CQ CQ DE ${ME} ${ME} K`, kind: "good" };
  if (qso.stage === "asking") {
    return x < 0.6 ? { text: `${ME} ${ME} K`, kind: "good" } : { text: pick(r, ["?", "AGN", noise(r)]), kind: "junk" };
  }
  if (qso.stage === "signing") {
    return x < 0.6 ? { text: `TU 73 ${c} DE ${ME} SK E E`, kind: "end" } : { text: pick(r, ["AGN", "?", noise(r)]), kind: "junk" };
  }
  const asked = /RST\?|NAME\?|QTH\?/.exec(last)?.[0];
  if (asked && x < 0.35) {
    const v = asked === "RST?" ? "UR RST 599 599" : asked === "NAME?" ? "NAME ROB ROB" : "QTH SEATTLE WA";
    return { text: pick(r, [v, `R ${v} K`, `${c} DE ${ME} ${v} K`]), kind: "answer" };
  }
  if (x < 0.45) {
    return qso.stage === "called"
      ? { text: `${c} DE ${ME} UR RST 599 599 NAME ROB ROB QTH SEATTLE WA HW? ${c} DE ${ME} K`, kind: "good" }
      : { text: pick(r, [`R ${c} DE ${ME} TNX K`, `${c} DE ${ME} 73 SK`, `R FB ${c} DE ${ME} K`]), kind: "end" };
  }
  if (x < 0.55) return { text: pick(r, [`${c} DE ${ME} UR RST 599 K`, "NAME ROB K", "QTH SEATTLE WA K"]), kind: "part" };
  if (x < 0.8) {
    const q = ["CALL?", "UR CALL?", `${c}?`, "RST?", "NAME?", "QTH?", "UR RST?", "UR NAME?", "PSE QTH?"];
    return { text: r() < 0.3 ? callCheck(c, lenient, r) : pick(r, q), kind: "ask" };
  }
  if (x < 0.88) return { text: pick(r, ["AGN", "?", "AGN?", "PSE AGN"]), kind: "repeat" };
  return { text: noise(r), kind: "junk" };
}

interface Step {
  readonly over: Sent;
  readonly reply: string;
}

/** A loop in the last step of `steps`, or null. */
function loopIn(call: string, steps: readonly Step[]): string | null {
  const now = steps.at(-1)!;
  const before = steps.at(-2);
  const { text, kind } = now.over;
  const isQuestion = (s: string) => /\?$/.test(s.trim());
  // Asked for its call, as CALL? or part of it with a ?: the reply has it.
  const bare = text.replace(/\b(UR|PSE)\b|[ ?]/g, "");
  const forCall = kind === "ask" && (/\bCALL ?\?/.test(text) || (/\?/.test(text) && bare.length >= 3 && call.startsWith(bare)));
  if (forCall && !now.reply.includes(call)) return `"${text}" got "${now.reply}", without its call`;
  // A question of yours answered with its own question again.
  if (before && kind === "ask" && now.reply === before.reply && isQuestion(now.reply) && !now.reply.includes(call)) {
    return `"${text}" got its own "${now.reply}" again`;
  }
  // The same reply three times while you send it what it wants.
  const three = steps.slice(-3);
  if (
    three.length === 3 &&
    three.every((s) => s.reply === now.reply) &&
    three.slice(1).every((s) => s.over.kind === "good" || s.over.kind === "answer")
  ) {
    return `"${now.reply}" three times, after ${three.map((s) => `"${s.over.text}"`).join(", ")}`;
  }
  return null;
}

describe("no loops, over many QSOs", () => {
  const formats: (FormatId | "standard")[] = ["cwt", "sst", "mst", "pota", "standard"];
  for (const format of formats) {
    for (const lenient of [false, true]) {
      it(`in ${format}, with ${lenient ? "Lenient" : "Strict"} copy`, () => {
        const found: string[] = [];
        for (let seed = 1; seed <= 500 && found.length < 3; seed++) {
          const r = seeded(seed * 7919 + (lenient ? 1 : 0));
          const rand = seeded(seed * 104729 + 3);
          const context: RunContext = { ear: { lenient, saved: ME }, rand, region: "WA", hour: 10 };
          let qso: AnyQso =
            format === "standard" ? newQso(rand, "", { charWpm: 20, farnsworthWpm: 20 }) : newRun(format, rand, 0, "", ME);
          let last = "";
          if (isRun(qso)) {
            const turn = respond(qso, `CQ ${format.toUpperCase()} DE ${ME}`, context);
            qso = turn.qso;
            last = turn.reply ?? "";
          }
          const steps: Step[] = [];
          for (let n = 0; n < 24; n++) {
            const over = isRun(qso) ? runOver(qso, last, lenient, r) : cqOver(qso, last, lenient, r);
            const turn = respond(qso, over.text, context);
            steps.push({ over, reply: turn.reply ?? "" });
            const loop = loopIn(qso.them.call, steps);
            if (loop) {
              const transcript = steps.map((s) => `  ${s.over.text} -> ${s.reply}`).join("\n");
              found.push(`seed ${seed}: ${loop}\n${transcript}`);
              break;
            }
            qso = turn.qso;
            if (turn.reply) last = turn.reply;
            if (turn.ended) break;
          }
        }
        expect(found).toEqual([]);
      });
    }
  }
});
