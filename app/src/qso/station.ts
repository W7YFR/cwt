/* The other station: who answers your CQ.
 *
 * Made up from short lists, so every word keys cleanly and reads the way it
 * would on the air. `rand` is passed in, so a test can fix the station.
 */

import { seeded, seedOf } from "@/audio/qsb";
import { fistFor, HAND_KEYS, type Fist, type HandKey, type KeyKind } from "@/timing/fist";
import { ACADEMY } from "./formats";

export type Rand = () => number;

export interface Station {
  readonly call: string;
  readonly name: string;
  /** City and state, as sent: "PORTLAND OR". */
  readonly qth: string;
  /** The report this station gives you. */
  readonly rst: string;
  /** The tone the station is heard at, in Hz. */
  readonly toneHz: number;
  /** How often it opens a line in the middle of the QSO with both calls,
   *  0 to 1. Each operator has their own habit. Absent in a QSO kept before
   *  there was one. */
  readonly habit?: number;
  /** In a CWT, its CWops number, or empty for a station that is not a
   *  member and sends its region. */
  readonly nr?: string;
  /** In an MST, its serial number for this QSO. */
  readonly serial?: number;
  /** One of your friends, from Settings. Absent for any other station. */
  readonly friend?: boolean;
  /** A friend's rig, antenna and power, as they set them. Absent when not
   *  set: the station names a rig of its own. */
  readonly rig?: string;
  readonly antenna?: string;
  readonly power?: string;
  /** A friend's typical speeds, in words per minute, character and
   *  overall: the speeds they call at. */
  readonly wpm?: number;
  readonly farnsworthWpm?: number;
  /** How it keys on a key worked by hand, such as a bug. Absent: a keyer,
   *  every line exact. */
  readonly fist?: Fist;
}

/** What a station takes from a friend: their details from Settings. */
export interface FriendInfo {
  readonly callsign: string;
  readonly name: string;
  readonly cwopsNumber: string;
  readonly qthCity: string;
  readonly qthRegionShort: string;
  readonly rigManufacturer: string;
  readonly rigModel: string;
  readonly rigPower: string;
  readonly antenna: string;
  /** Their typical speeds, in words per minute: character and overall. */
  readonly wpm: number;
  readonly farnsworthWpm: number;
  /** The keys they send with, one picked each time they call. Absent: a
   *  keyer. */
  readonly keys?: readonly KeyKind[];
}

/** The state or province at the end of `qth`: OR, from SALEM OR. */
export function regionOf(station: Station): string {
  return station.qth.slice(station.qth.lastIndexOf(" ") + 1);
}

/** Names Lenient copy knows as words. A station's own name and yours come
 *  in per QSO, so this short list stays as it was: more words could change
 *  how Lenient copy reads gaps. */
export const NAMES = [
  "AL", "ANN", "BILL", "BOB", "CHUCK", "DAN", "DAVE", "ED", "FRED", "GARY",
  "JIM", "JOE", "JOHN", "KEN", "LEE", "MARK", "MIKE", "PAT", "PETE", "RICK",
  "RON", "SAM", "SUE", "TOM", "WALT",
];

/** The names stations send, as sent on CW: BOB, not ROBERT. Each line is a
 *  weight: the common names come up most, as on the air. */
const NAME_WEIGHTS: Readonly<Record<string, number>> = {
  ...weigh(6, "BOB JIM JOHN MIKE DAVE BILL TOM"),
  ...weigh(3, "DON RON JOE STEVE DAN GARY KEN RICK PAUL MARK JERRY LARRY DICK CHUCK TED ED AL FRED GEORGE PETE JACK RAY FRANK HANK ART WALT DOUG JEFF TIM GREG RANDY TERRY PHIL CHRIS"),
  ...weigh(1, [
    "ALAN ANDY ARNIE BARRY BEN BERT BOYD BRAD BRIAN BRUCE BUD CAL CARL CHARLIE CLAY CLIFF CLYDE CRAIG CURT",
    "DALE DARRELL DEAN DENNIS DUANE EARL ELMER ERIC ERNIE FLOYD GENE GIL GLEN GORDON GUS HAL HARRY HERB HOWARD HUGH",
    "IRV JAKE JAY JON KEITH KEVIN KURT LEE LEN LEO LES LLOYD LOU LYLE MAC MARTY MARV MATT MAX MEL MERLE MILT MONTY",
    "NATE NEIL NICK NORM OSCAR OTTO PAT PERRY RALPH REX RICH ROB ROD ROGER ROSS ROY RUDY RUSS SAM SCOTT SID SKIP",
    "STAN STU TODD TONY TROY VERN VIC WALLY WAYNE WES ANDRE CLAUDE LUC MARC PIERRE",
    "ANN BARB BETH CAROL CINDY CONNIE DEB DIANE ELLEN GAIL JAN JILL JOAN JUDY KAREN KATHY KIM LINDA LIZ LYNN",
    "MARY NANCY PAM PEG RUTH SALLY SHARON SUE",
  ].join(" ")),
};

function weigh(weight: number, names: string): Record<string, number> {
  return Object.fromEntries(names.split(" ").map((n) => [n, weight]));
}

/** Every name a station may send. */
export const STATION_NAMES = Object.keys(NAME_WEIGHTS);

/** A name, by weight, none of `not`. */
function randomName(rand: Rand, not: readonly string[]): string {
  const all = Object.entries(NAME_WEIGHTS).filter(([name]) => !not.includes(name));
  let left = rand() * all.reduce((sum, [, w]) => sum + w, 0);
  for (const [name, w] of all) {
    left -= w;
    if (left < 0) return name;
  }
  return all[all.length - 1]![0];
}

/** Where stations are, by state or province: its towns, and how many hams
 *  live there, roughly, as a weight. The busy states call most. */
interface Area {
  readonly towns: readonly string[];
  readonly weight: number;
}

/** Each US state, DC and Puerto Rico. Weights are thousands of licensees,
 *  roughly. */
const STATES: Readonly<Record<string, Area>> = {
  AL: { towns: ["MOBILE", "HUNTSVILLE"], weight: 13 },
  AK: { towns: ["ANCHORAGE", "JUNEAU"], weight: 4 },
  AZ: { towns: ["PHOENIX", "TUCSON", "MESA"], weight: 25 },
  AR: { towns: ["CONWAY", "ROGERS"], weight: 9 },
  CA: { towns: ["FRESNO", "CHICO", "SACRAMENTO", "OAKLAND", "REDDING"], weight: 100 },
  CO: { towns: ["DENVER", "PUEBLO", "BOULDER"], weight: 20 },
  CT: { towns: ["HARTFORD", "NEWINGTON"], weight: 9 },
  DE: { towns: ["DOVER", "LEWES"], weight: 3 },
  DC: { towns: ["WASHINGTON"], weight: 1 },
  FL: { towns: ["MIAMI", "TAMPA", "ORLANDO", "OCALA"], weight: 55 },
  GA: { towns: ["ATLANTA", "MACON", "AUGUSTA"], weight: 22 },
  HI: { towns: ["HILO", "KONA"], weight: 4 },
  ID: { towns: ["BOISE", "NAMPA"], weight: 9 },
  IL: { towns: ["PEORIA", "JOLIET", "CHICAGO"], weight: 22 },
  IN: { towns: ["MUNCIE", "GARY", "CARMEL"], weight: 15 },
  IA: { towns: ["AMES", "DUBUQUE"], weight: 8 },
  KS: { towns: ["TOPEKA", "WICHITA"], weight: 8 },
  KY: { towns: ["LEXINGTON", "PADUCAH"], weight: 11 },
  LA: { towns: ["MONROE", "SLIDELL"], weight: 8 },
  ME: { towns: ["PORTLAND", "BANGOR"], weight: 6 },
  MD: { towns: ["FREDERICK", "LAUREL"], weight: 13 },
  MA: { towns: ["BOSTON", "SALEM", "LOWELL"], weight: 14 },
  MI: { towns: ["FLINT", "LANSING", "DETROIT"], weight: 25 },
  MN: { towns: ["DULUTH", "EAGAN", "ROCHESTER"], weight: 15 },
  MS: { towns: ["JACKSON", "TUPELO"], weight: 6 },
  MO: { towns: ["JOPLIN", "COLUMBIA"], weight: 15 },
  MT: { towns: ["BILLINGS", "MISSOULA"], weight: 6 },
  NE: { towns: ["OMAHA", "LINCOLN"], weight: 6 },
  NV: { towns: ["RENO", "ELKO"], weight: 9 },
  NH: { towns: ["NASHUA", "CONCORD"], weight: 7 },
  NJ: { towns: ["TRENTON", "CAMDEN"], weight: 15 },
  NM: { towns: ["TAOS", "GALLUP"], weight: 8 },
  NY: { towns: ["ALBANY", "ITHACA", "BUFFALO"], weight: 30 },
  NC: { towns: ["RALEIGH", "DURHAM", "BOONE"], weight: 28 },
  ND: { towns: ["FARGO", "MINOT"], weight: 2 },
  OH: { towns: ["DAYTON", "AKRON", "TOLEDO"], weight: 30 },
  OK: { towns: ["TULSA", "NORMAN"], weight: 10 },
  OR: { towns: ["SALEM", "BEND", "EUGENE"], weight: 20 },
  PA: { towns: ["ERIE", "READING", "YORK"], weight: 30 },
  RI: { towns: ["WARWICK", "NEWPORT"], weight: 3 },
  SC: { towns: ["AIKEN", "SUMTER"], weight: 12 },
  SD: { towns: ["PIERRE", "HURON"], weight: 3 },
  TN: { towns: ["KNOXVILLE", "MEMPHIS"], weight: 18 },
  TX: { towns: ["AUSTIN", "DALLAS", "WACO", "TYLER"], weight: 60 },
  UT: { towns: ["OGDEN", "PROVO"], weight: 12 },
  VT: { towns: ["BARRE", "RUTLAND"], weight: 3 },
  VA: { towns: ["VIENNA", "ROANOKE", "NORFOLK"], weight: 25 },
  WA: { towns: ["SPOKANE", "TACOMA", "YAKIMA"], weight: 35 },
  WV: { towns: ["ELKINS", "BECKLEY"], weight: 5 },
  WI: { towns: ["MADISON", "OSHKOSH"], weight: 14 },
  WY: { towns: ["CASPER", "CODY"], weight: 3 },
  PR: { towns: ["PONCE", "ARECIBO"], weight: 2 },
};

/** Each Canadian province and territory. Weights are tenths of the share
 *  of Canada's hams, roughly. */
const PROVINCES: Readonly<Record<string, Area>> = {
  ON: { towns: ["OTTAWA", "TORONTO", "LONDON"], weight: 35 },
  BC: { towns: ["VICTORIA", "KELOWNA"], weight: 25 },
  QC: { towns: ["QUEBEC", "LAVAL"], weight: 12 },
  AB: { towns: ["CALGARY", "EDMONTON"], weight: 12 },
  NS: { towns: ["HALIFAX", "TRURO"], weight: 4 },
  MB: { towns: ["WINNIPEG", "BRANDON"], weight: 4 },
  SK: { towns: ["REGINA", "SASKATOON"], weight: 3 },
  NB: { towns: ["MONCTON", "BATHURST"], weight: 3 },
  NL: { towns: ["GANDER"], weight: 2 },
  PE: { towns: ["SUMMERSIDE"], weight: 1 },
  YT: { towns: ["WHITEHORSE"], weight: 1 },
  NT: { towns: ["YELLOWKNIFE"], weight: 1 },
  NU: { towns: ["IQALUIT"], weight: 1 },
};

/** The call area of each US state: the digit its calls carry. */
const DIGIT: Readonly<Record<string, string>> = {
  ...Object.fromEntries("CT ME MA NH RI VT".split(" ").map((r) => [r, "1"])),
  ...Object.fromEntries("NJ NY".split(" ").map((r) => [r, "2"])),
  ...Object.fromEntries("DE DC MD PA".split(" ").map((r) => [r, "3"])),
  ...Object.fromEntries("AL FL GA KY NC SC TN VA".split(" ").map((r) => [r, "4"])),
  ...Object.fromEntries("AR LA MS NM OK TX".split(" ").map((r) => [r, "5"])),
  CA: "6",
  ...Object.fromEntries("AZ ID MT NV OR UT WA WY".split(" ").map((r) => [r, "7"])),
  ...Object.fromEntries("MI OH WV".split(" ").map((r) => [r, "8"])),
  ...Object.fromEntries("IL IN WI".split(" ").map((r) => [r, "9"])),
  ...Object.fromEntries("CO IA KS MN MO NE ND SD".split(" ").map((r) => [r, "0"])),
  AK: "7",
  HI: "6",
  PR: "4",
};

/** The prefixes, digit included, of a place with calls of its own: Alaska,
 *  Hawaii, Puerto Rico and each province. */
const PREFIXES: Readonly<Record<string, readonly string[]>> = {
  AK: ["KL7", "AL7", "NL7", "WL7"],
  HI: ["KH6", "AH6", "NH6", "WH6"],
  PR: ["KP4", "NP4", "WP4"],
  NS: ["VE1", "VA1"],
  QC: ["VE2", "VA2"],
  ON: ["VE3", "VA3"],
  MB: ["VE4", "VA4"],
  SK: ["VE5", "VA5"],
  AB: ["VE6", "VA6"],
  BC: ["VE7", "VA7"],
  NT: ["VE8"],
  NB: ["VE9"],
  NL: ["VO1"],
  PE: ["VY2"],
  YT: ["VY1"],
  NU: ["VY0"],
};

/** How often a US call's digit matches its state. The rest moved and kept
 *  their call, as a W7 in Ohio. */
const AT_HOME = 0.9;

/** One of `areas`, by weight. */
function weighted(rand: Rand, areas: Readonly<Record<string, Area>>): string {
  const all = Object.entries(areas);
  let left = rand() * all.reduce((sum, [, a]) => sum + a.weight, 0);
  for (const [region, area] of all) {
    left -= area.weight;
    if (left < 0) return region;
  }
  return all[all.length - 1]![0];
}

/** A state or province, US by weight, Canada `canada` of the time. */
export function randomRegion(rand: Rand, canada: number): string {
  return rand() < canada ? weighted(rand, PROVINCES) : weighted(rand, STATES);
}

/** A town in `region`, with the region: SALEM OR. */
function qthIn(rand: Rand, region: string): string {
  const area = STATES[region] ?? PROVINCES[region]!;
  return `${pick(rand, area.towns)} ${region}`;
}

/** The digit of a call: the call area its state or province gives it, as 7
 *  for OR and 3 for ON. Null for a region with no area. */
export function digitOf(region: string): string | null {
  return PREFIXES[region]?.[0]?.[2] ?? DIGIT[region] ?? null;
}

const RSTS = ["599", "589", "579", "569", "559"];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

function letters(rand: Rand, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += pick(rand, [...LETTERS]);
  return out;
}

/** A US call: K, N or W with a 2- or 3-letter suffix, one of those with a
 *  second letter and a 3-letter suffix, as KD7ABC, or AA to AL with a
 *  2-letter one. Its digit is `digit`, or any. */
export function randomCall(rand: Rand, digit = String(Math.floor(rand() * 10))): string {
  const r = rand();
  if (r < 0.15) return `A${pick(rand, [..."ABCDEFGHIJKL"])}${digit}${letters(rand, 2)}`;
  if (r < 0.35) return `${pick(rand, ["K", "N", "W"])}${pick(rand, [..."ABCDEFGIJ"])}${digit}${letters(rand, 3)}`;
  return `${pick(rand, ["K", "N", "W"])}${digit}${letters(rand, r < 0.85 ? 3 : 2)}`;
}

/** A call from `region`. A province, Alaska, Hawaii and Puerto Rico have
 *  prefixes of their own. A US call has its state's digit `AT_HOME` of the
 *  time. */
export function callFrom(rand: Rand, region: string): string {
  const own = PREFIXES[region];
  const home = rand() < AT_HOME;
  if (own && (home || !(region in DIGIT))) return `${pick(rand, own)}${letters(rand, rand() < 0.5 ? 3 : 2)}`;
  const digit = DIGIT[region];
  return randomCall(rand, home && digit ? digit : String(Math.floor(rand() * 10)));
}

/** How many stations in a standard QSO are in Canada. */
export const CANADA = 0.05;

/** A new station, never at the call `not` and never with a name in
 *  `names`. `canada` of the time it is in Canada. */
export function randomStation(rand: Rand, not = "", canada = CANADA, names: readonly string[] = []): Station {
  const region = randomRegion(rand, canada);
  let call = callFrom(rand, region);
  while (call === not) call = callFrom(rand, region);
  return {
    call,
    name: randomName(rand, names),
    qth: qthIn(rand, region),
    rst: pick(rand, RSTS),
    toneHz: 550 + Math.round(rand() * 20) * 10,
    habit: 0.05 + 0.3 * rand(),
  };
}

/** How often a friend not yet heard this session calls in place of a new
 *  station. Low, so a friend does not call every session. */
export const FRIEND_CHANCE = 0.08;

/** A friend who calls now and then, never at the call `not`, and the friends
 *  still to call this session. Null when no friend calls. Draws nothing with
 *  no friend to call, so a session without friends goes as before. */
export function friendCalls(
  rand: Rand,
  friends: readonly FriendInfo[],
  not = "",
): { friend: FriendInfo; left: FriendInfo[] } | null {
  const can = friends.filter((f) => f.callsign.trim() && f.name.trim() && f.callsign.trim() !== not);
  if (can.length === 0 || rand() >= FRIEND_CHANCE) return null;
  const friend = pick(rand, can);
  return { friend, left: friends.filter((f) => f !== friend) };
}

/** `station` as your friend: their call, name and QTH, their CWops number or
 *  none, their rig, and their speeds. What they left out stays `station`'s. A QTH with no
 *  state or province the exchange knows stays `station`'s too. */
export function asFriend(station: Station, f: FriendInfo): Station {
  const region = f.qthRegionShort.trim();
  const city = f.qthCity.trim();
  const known = region in STATES || region in PROVINCES;
  const rig = (f.rigModel.trim() || f.rigManufacturer.trim()).replace(/\s+/g, "");
  const { fist: _, ...rest } = station;
  const call = f.callsign.trim();
  return {
    ...rest,
    call,
    name: f.name.trim(),
    qth: known ? (city ? `${city} ${region}` : region) : station.qth,
    nr: f.cwopsNumber.trim(),
    friend: true,
    wpm: f.wpm,
    farnsworthWpm: Math.min(f.farnsworthWpm, f.wpm),
    ...(rig ? { rig } : {}),
    ...(f.antenna.trim() ? { antenna: f.antenna.trim() } : {}),
    ...(f.rigPower.trim() ? { power: f.rigPower.trim() } : {}),
    ...fistOf(pickKey(f.keys ?? ["keyer"], call, station.habit), call),
  };
}

/** How often a station keys on each key worked by hand, 0 to 1. The rest
 *  key on a keyer. */
export type KeyChances = Readonly<Partial<Record<HandKey, number>>>;

/** How often a station in a standard QSO keys on each key. A plain CQ is a
 *  rag chew, where older operators often send on a bug. */
export const STANDARD_KEYS: KeyChances = { bug: 0.15 };

/** The fist of the operator at `call` on `key`: always the same one. None
 *  on a keyer. */
function fistOf(key: KeyKind, call: string): { fist?: Fist } {
  const fist = fistFor(key, seedOf(call));
  return fist ? { fist } : {};
}

/** One of `keys` for this QSO, from the call and the habit drawn for it:
 *  an operator may change keys from one QSO to the next. Draws nothing from
 *  the QSO's random numbers. */
function pickKey(keys: readonly KeyKind[], call: string, habit: number | undefined): KeyKind {
  if (keys.length === 1) return keys[0]!;
  return keys[Math.floor(keyDraw(call, habit) * keys.length)]!;
}

/** A number in [0, 1) for this station's key in this QSO. */
function keyDraw(call: string, habit: number | undefined): number {
  return seeded(seedOf(`key:${call}:${habit ?? ""}`))();
}

/** `station` on a key worked by hand as often as `chances` say. An
 *  operator may change keys from one QSO to the next, so the key comes from
 *  this station's call and its habit, drawn new each time it is made. Its
 *  fist on a key comes from the call alone: the same operator on the same
 *  key. Draws nothing from the QSO's random numbers. A CW Academy student
 *  keys on a paddle. */
export function onKey(station: Station, chances: KeyChances): Station {
  if (station.nr === ACADEMY) return station;
  let left = keyDraw(station.call, station.habit);
  for (const key of HAND_KEYS) {
    left -= chances[key] ?? 0;
    if (left < 0) return { ...station, ...fistOf(key, station.call) };
  }
  return station;
}

/** `station` on one of `keys`, picked from its call and habit, in place of
 *  the key it was given: the page's Paddle, when it sets the keys. Null
 *  leaves it as it is. A friend keeps their own keys. */
export function withKeys(station: Station, keys: readonly KeyKind[] | null): Station {
  if (!keys || keys.length === 0 || station.friend) return station;
  const { fist: _, ...rest } = station;
  return { ...rest, ...fistOf(pickKey(keys, station.call, station.habit), station.call) };
}

/** How many CWT stations are CWops members, and how many CW Academy
 *  students, who send CWA. The rest send their region. */
const MEMBERS = 0.8;
const STUDENTS = 0.06;

/** A station that answers a CQ in a run: a new station, with a CWops number
 *  most of the time, now and then CWA, and a serial number of its own.
 *  `canada` of the time it is in Canada. Its name is none of `names`. */
export function randomCaller(rand: Rand, not = "", canada = CANADA, names: readonly string[] = []): Station {
  const station = randomStation(rand, not, canada, names);
  const r = rand();
  return {
    ...station,
    nr: r < MEMBERS ? String(1 + Math.floor(rand() * 4200)) : r < MEMBERS + STUDENTS ? ACADEMY : "",
    serial: 1 + Math.floor(rand() * 150),
  };
}
