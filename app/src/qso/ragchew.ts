/* Rag chew: after the exchange of a standard QSO, a model in the browser
 * writes the station's lines (Step 3). The model reads and writes plain
 * English. This file turns your CW into English for it, and its English back
 * into CW. The CW style was what the models could not write (#238).
 * The scripts still run the CQ, the exchange and the sign-off.
 */

import { seeded, seedOf } from "@/audio/qsb";
import type { UserInfo } from "@/io/storage";
import type { KeyKind } from "@/timing/fist";
import { erased, KNOWN, wordsOf } from "./cq";
import type { Station } from "./station";

/** A chat turn, as the model takes it. */
export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** What the station can tell you about itself in a rag chew. */
export interface Details {
  readonly rig: string;
  readonly power: string;
  readonly antenna: string;
  readonly wx: string;
  readonly age: number;
  readonly licensed: number;
  readonly job: string;
  readonly interest: string;
}

const RIGS = ["IC7300", "K3", "FT991A", "TS590", "KX2", "FTDX10", "IC705", "K4", "FT710", "IC7610"];
const POWERS = ["100W", "5W", "50W", "500W", "10W", "100W"];
const ANTS = ["DIPOLE", "EFHW", "HEXBEAM", "VERTICAL", "G5RV", "YAGI AT 40 FT", "LOOP", "WIRE IN THE ATTIC", "INV V"];
const SKIES = ["SUNNY", "RAIN", "CLOUDY", "SNOW", "WINDY", "FOG", "CLEAR"];
const JOBS = [
  "RETIRED ENGINEER", "TEACHER", "NURSE", "FARMER", "RETIRED PILOT", "MACHINIST", "ELECTRICIAN",
  "RETIRED COP", "PROGRAMMER", "TRUCK DRIVER", "RETIRED NAVY RADIOMAN", "DOCTOR",
];
const INTERESTS = [
  "ALSO LIKES POTA", "BUILDS QRP KITS", "IS A CWOPS MEMBER", "JUST GOT BACK ON CW AFTER 20 YRS", "CHASES DX",
  "CHASES SOTA", "RESTORES OLD TUBE RIGS", "USES A BUG", "IS IN THE SKCC", "LIKES CONTESTS",
];

/** The station's details, the same every time for one call. A friend's own
 *  rig, antenna and power, where they set them. */
export function detailsOf(them: Station, year = new Date().getFullYear()): Details {
  const rand = seeded(seedOf(`chat:${them.call}`));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const sky = pick(SKIES);
  const temp = sky === "SNOW" ? 15 + Math.floor(rand() * 4) * 5 : 35 + Math.floor(rand() * 12) * 5;
  const age = 25 + Math.floor(rand() * 56);
  return {
    rig: them.rig ?? pick(RIGS),
    power: them.power ? `${them.power.replace(/W$/i, "")}W` : pick(POWERS),
    antenna: them.antenna ?? pick(ANTS),
    wx: `${sky} ${temp}F`,
    age,
    licensed: Math.max(year - age + 14, year - Math.floor(rand() * 50) - 1),
    job: pick(JOBS),
    interest: pick(INTERESTS),
  };
}

/** Title case, for names the model reads. */
const title = (w: string) => w.charAt(0) + w.slice(1).toLowerCase();

/** The model's instructions for a rag chew with `them` as the station. */
/** The station's key, in plain words for the model. */
const KEY_WORDS: Readonly<Record<KeyKind, string>> = {
  keyer: "a paddle and an electronic keyer",
  bug: "a bug, a semi-automatic key",
  straight: "a straight key",
};

/** How the QSO is being sent: the station's speed, and yours as measured
 *  from your last line, in words per minute. */
export interface Pace {
  readonly wpm: number;
  readonly yourWpm: number | null;
}

export function systemPrompt(them: Station, d: Details, user: UserInfo, pace: Pace): string {
  const yourName = title(user.name.trim() || "OM");
  const yourQth = [user.qthCity.trim(), user.qthRegionShort.trim()].filter(Boolean).join(" ");
  return [
    `You are ${title(them.name)}, a friendly ham radio operator in ${them.qth}. You are chatting with ${yourName}, another ham${yourQth ? ` in ${yourQth}` : ""}, by Morse code.`,
    `You already traded signal reports, names and locations. Now it is a casual chat.`,
    ``,
    `Facts about you (only these are about you):`,
    `- Radio: ${d.rig} at ${d.power}. Antenna: ${d.antenna}.`,
    `- Weather where you are: ${d.wx}.`,
    `- Age ${d.age}. Licensed in ${d.licensed}. Job: ${d.job.toLowerCase()}. You ${d.interest.toLowerCase()}.`,
    `- You hear ${yourName} at a signal report of ${them.rst}.`,
    `- You send with ${KEY_WORDS[them.fist?.key ?? "keyer"]}, at ${Math.round(pace.wpm)} words per minute.` +
      (pace.yourWpm ? ` ${yourName} is sending at about ${Math.round(pace.yourWpm)} words per minute.` : ""),
    ``,
    `How to reply:`,
    `- Morse is slow, so keep it short: 2 or 3 short sentences, at most 30 words.`,
    `- First react to one thing ${yourName} just told you, such as their radio, antenna or weather, or answer their question.`,
    `- Then add one more thing: a fact about yourself you have not shared yet, or one simple question for ${yourName}.`,
    `- Give your signal report only when ${yourName} asks how you copy them.`,
    `- ${yourName}'s Morse may come through with a word broken into pieces or a letter wrong, as in "ya es u" for Yaesu. Read it as best you can. If you cannot tell what ${yourName} means, say so and ask. Never guess at it.`,
    `- Never claim ${yourName}'s radio, antenna, weather or town as yours. Your job and hobbies are yours, not ${yourName}'s.`,
    `- Do not start two replies the same way.`,
    `- Plain words only. Write numbers as digits. No emoji, no lists, no quotes.`,
  ].join("\n");
}

/** The model's instructions for your suggested reply in a rag chew with
 *  `them`: the model writes as you, from what User holds. */
export function replyPrompt(them: Station, user: UserInfo): string {
  const yourName = title(user.name.trim() || "OM");
  const yourQth = [user.qthCity.trim(), user.qthRegionShort.trim()].filter(Boolean).join(" ");
  const rig = [user.rigManufacturer.trim(), user.rigModel.trim()].filter(Boolean).join(" ");
  const facts = [
    rig && `- Radio: ${rig}${user.rigPower.trim() ? ` at ${user.rigPower.trim().replace(/\s*w(atts?)?$/i, "")}W` : ""}.`,
    user.antenna.trim() && `- Antenna: ${user.antenna.trim()}.`,
    user.age.trim() && `- Age ${user.age.trim()}.`,
    user.yearLicensed.trim() && `- Licensed in ${user.yearLicensed.trim()}.`,
  ].filter(Boolean);
  return [
    `You are ${yourName}, a ham radio operator${yourQth ? ` in ${yourQth}` : ""}. You are chatting with ${title(them.name)}, another ham in ${them.qth}, by Morse code.`,
    `You already traded signal reports, names and locations. Now it is a casual chat.`,
    ``,
    ...(facts.length ? [`Facts about you (only these are about you):`, ...facts, ``] : []),
    `How to reply:`,
    `- Morse is slow, so keep it short: 1 or 2 short sentences, at most 20 words.`,
    `- React to one thing ${title(them.name)} just told you, or answer their question.`,
    `- Then you may ask ${title(them.name)} one simple question.`,
    `- Never make up a fact about yourself. Use only the facts above. If you have none to share, ask a question instead.`,
    `- Never claim ${title(them.name)}'s radio, antenna, weather or town as yours.`,
    `- Do not sign off. Do not say goodbye or 73.`,
    `- Plain words only. Write numbers as digits. No emoji, no lists, no quotes.`,
  ].join("\n");
}

/** The rag chew so far, as one message that asks for your next line. One
 *  message, not the turns with their roles swapped: a chat that opened
 *  with the model's turn is one some models refuse. */
export function yourTurn(them: Station, user: UserInfo, turns: readonly ChatTurn[]): ChatTurn[] {
  const you = title(user.name.trim() || "OM");
  const lines = turns.map((t) => `${t.role === "user" ? you : title(them.name)}: ${t.content}`);
  return [{ role: "user", content: `The chat so far:\n${lines.join("\n")}\n\nWrite ${you}'s next line, and only that line.` }];
}

/** The model's line for you, without the "Rob:" it may write before it, as
 *  the chat it read has. */
export function unlabeled(english: string): string {
  return english.replace(/^\s*[A-Za-z]+:\s*/, "");
}

/** CW words to English, longest phrases first. */
const TO_ENGLISH: ReadonlyArray<readonly [string, string]> = [
  ["HW CPY ?", "how do you copy me?"], ["HW CPY?", "how do you copy me?"], ["HW CPY", "how do you copy me?"],
  ["HW ?", "what about you?"], ["HW?", "what about you?"],
  ["SOLID CPY", "I copy you well"], ["UR SIG", "your signal"], ["RST", "signal report"],
  ["VFB", "very good"], ["FB", "great"], ["TNX", "thanks"], ["TU", "thank you"], ["ES", "and"], ["UR", "your"], ["U", "you"],
  ["HR", "here"], ["QTH", "location"], ["WX", "weather"], ["RIG", "radio"], ["ANT", "antenna"], ["PWR", "power"], ["FER", "for"], ["GUD", "good"],
  ["VY", "very"], ["AGN", "again"], ["PSE", "please"], ["OP", "operator"], ["OM", "friend"], ["YL", "lady"], ["YRS", "years"],
  ["LIC", "licensed"], ["WAT", "what"], ["ABT", "about"], ["SRI", "sorry"], ["CUAGN", "see you again"], ["CUL", "see you later"],
  ["HPE", "hope"], ["CPY", "copy"], ["BT", "."], ["<BT>", "."], ["=", "."], ["R R", "roger"], ["RR", "roger"], ["R", "roger"],
  ["BK", ""], ["KN", ""], ["K", ""], ["<KN>", ""], ["<BK>", ""], ["<AR>", ""], ["<AA>", ""], ["<CT>", ""],
  ["<AS>", "wait."], ["<SN>", "understood."], ["<CL>", "I am going off the air."], ["73", "best regards"], ["QRM", "interference"],
  ["QRN", "static"], ["QSB", "fading"], ["WPM", "words per minute"], ["SIG", "signal"], ["TEMP", "temperature"],
];

/** The rogers TO_ENGLISH reads as roger. */
const ACKS = new Set(["R R", "RR", "R"]);

/** Whether a roger can stand before `next`: a word the station knows, a
 *  number, a prosign or a full stop, or the end of the line. */
function rogerBefore(next: string | undefined): boolean {
  if (next === undefined) return true;
  const bare = next.replace(/[.,?]+$/, "");
  return bare === "" || KNOWN.has(bare) || /^\d+$/.test(bare) || /^<[A-Z]+>$/.test(bare) || bare === "=" || TO_ENGLISH.some(([k]) => k === bare);
}

/** Your CW line, in English for the model. The calls are left out. */
export function toEnglish(cw: string, calls: readonly string[]): string {
  // An error sign takes back the word before it, as the scripts read it.
  const words = erased(wordsOf(cw.toUpperCase())).filter((w) => w !== "DE" && !calls.includes(w));
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let hit: readonly [number, string] | null = null;
    // A roger goes at the start of the line or of a sentence. R alone also
    // needs a word it knows after it, or nothing. Otherwise it is a letter
    // of a word keyed apart, as in I R W E BS I TI or R OB, and goes as it
    // was sent.
    const opens = out.length === 0 || /[.?]$/.test(out[out.length - 1]!);
    for (const [k, v] of TO_ENGLISH) {
      if (ACKS.has(k) && !(opens && (k !== "R" || rogerBefore(words[i + 1])))) continue;
      const n = k.split(" ").length;
      const run = words.slice(i, i + n);
      // A full stop or comma keyed onto the word, as HR., stays after it.
      const tail = k.endsWith("?") ? "" : (run[n - 1]?.match(/[.,]+$/)?.[0] ?? "");
      if (run.length === n && run.join(" ").replace(/[.,]+$/, "") === k) {
        hit = [n, v + tail];
        break;
      }
    }
    if (hit) {
      if (hit[1].replace(/[.,]/g, "")) out.push(hit[1]);
      else if (hit[1] && out.length) out[out.length - 1] += hit[1];
      i += hit[0];
    } else {
      out.push(words[i]!.toLowerCase());
      i++;
    }
  }
  return out.join(" ").replace(/\s+([.,?])/g, "$1").replace(/([.,?])[.,]+/g, "$1").trim();
}

/** English to CW, longest phrases first. */
const TO_CW: ReadonlyArray<readonly [string, string]> = [
  ["thank you very much", "TNX VY MUCH"], ["thanks for the chat", "TNX FER QSO"], ["thank you for the chat", "TNX FER QSO"],
  ["thanks for the qso", "TNX FER QSO"], ["thank you", "TU"], ["thanks", "TNX"], ["best regards", "73"], ["goodbye", "73"],
  ["see you later", "CUL"], ["see you again", "CUAGN"], ["how do you copy", "HW CPY"], ["signal report", "RST"],
  ["your signal", "UR SIG"], ["weather", "WX"], ["here", "HR"], ["and", "ES"], ["your", "UR"], ["you're", "UR"], ["you are", "UR"],
  ["you", "U"], ["for", "FER"], ["radio", "RIG"], ["antenna", "ANT"], ["power", "PWR"], ["great", "FB"], ["very good", "VFB"],
  ["good", "GUD"], ["very", "VY"], ["please", "PSE"], ["again", "AGN"], ["about", "ABT"], ["sorry", "SRI"], ["years", "YRS"],
  ["licensed", "LIC"], ["operator", "OP"], ["interference", "QRM"], ["static", "QRN"], ["fading", "QSB"],
  ["words per minute", "WPM"], ["okay", "OK"], ["hope", "HPE"], ["degrees", ""], ["fahrenheit", "F"],
  ["don't", "DONT"], ["can't", "CANT"],
];

/** Characters the station can key. */
const KEYABLE = /[^A-Z0-9 .,?/]/g;

/** The model's English reply, as the station keys it: CW words, BT between
 *  thoughts, BK at the end. "5x7", voice talk for a report, is left out. */
export function toCw(english: string): string {
  let t = english
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b\d\s*x\s*\d\b/g, "")
    .replace(/(\d+)\s*°?\s*f\b/g, "$1F")
    .replace(/(\d+)\s*(watts?|w)\b/g, "$1W")
    .replace(/([a-z0-9])-([a-z0-9])/g, "$1$2")
    .replace(/[!;:]/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/[—–-]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let hit: readonly [number, string] | null = null;
    for (const [k, v] of TO_CW) {
      const n = k.split(" ").length;
      const run = words.slice(i, i + n);
      const tail = run[n - 1]?.match(/[.,?]+$/)?.[0] ?? "";
      if (run.length === n && run.join(" ").replace(/[.,?]+$/, "") === k) {
        hit = [n, v + tail];
        break;
      }
    }
    if (hit) {
      if (hit[1]) out.push(hit[1]);
      i += hit[0];
    } else {
      out.push(words[i]!);
      i++;
    }
  }
  t = out.join(" ").toUpperCase().replace(/'/g, "").replace(KEYABLE, " ");
  // A full stop ends a thought: BT. A comma is let go, as on the air: BT
  // inside a sentence, as in LONG TIME AGO BT THOUGH, breaks it in two.
  const parts = t.split(/([.,?])/);
  let line = "";
  for (let i = 0; i < parts.length; i += 2) {
    const words = parts[i]!.trim();
    const mark = parts[i + 1] ?? "";
    if (!words) continue;
    line += ` ${words}`;
    if (mark === "?") line += "?";
    if (mark === ".") line += " BT";
  }
  line = line.replace(/\s+/g, " ").replace(/( BT)+$/, "").replace(/^ ?BT /, "").trim();
  return line ? `${line} BK` : "";
}

/** Whether `reply` sends one of your details as the station's own: your rig,
 *  antenna, a temperature or the like from `yours` that the station does not
 *  have. */
export function borrows(reply: string, yours: string, d: Details): boolean {
  const own = new Set(Object.values(d).join(" ").split(/\s+/));
  const specific = (w: string) => w.length >= 3 && /\d|^(IC|FT|KX|TS|K\d)|EFHW|DIPOLE|VERTICAL|YAGI|LOOP|SUNNY|RAIN|SNOW|CLOUDY/.test(w);
  const mine = new Set(yours.toUpperCase().split(/\s+/).filter(specific));
  return reply.split(/\s+/).some((w) => mine.has(w) && !own.has(w) && !/^\d{1,2}$/.test(w));
}

/** The station's first word in `line`, so two replies need not open the same. */
export function opening(line: string): string {
  return line.split(" ").slice(0, 3).join(" ");
}
