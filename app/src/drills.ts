/* Practice drills: a flat catalog whose grouping comes from each entry's path.
 *
 * Flat so that any picker can show it its own way — grouped under headers in
 * the new-session dialog, or as one searchable list of breadcrumbs.
 *
 * A drill's text can hold slots, such as `{name}`, that `fillDrill` fills from
 * the user's details. */

import { loadCustomDrills, loadUser, type CustomDrill, type UserInfo } from "@/io/storage";
import { BREAK, CHAR_TO_MORSE, normalizeMessage, tokenize } from "@/morse";

export interface Drill {
  /** Stable across releases: keys and test ids are built from it. */
  id: string;
  /** Group, then section. */
  path: readonly [string, string];
  /** The target message, upper case with single spaces. In the catalog it can
   *  hold slots; after `fillDrill` it holds none that have a value. */
  text: string;
  /** Slots with no value yet. A drill with any cannot be picked. */
  missing?: readonly Slot[];
}

/** The slots a drill can use, and the user detail each one reads. */
export const SLOTS = {
  name: "name",
  callsign: "callsign",
  age: "age",
  year_licensed: "yearLicensed",
  city: "qthCity",
  region_short: "qthRegionShort",
  region_long: "qthRegionLong",
  antenna: "antenna",
  rig_manufacturer: "rigManufacturer",
  rig_model: "rigModel",
  power: "rigPower",
} as const satisfies Record<string, keyof UserInfo>;

export type Slot = keyof typeof SLOTS;

/** The field names the configuration page shows, for saying what is missing. */
export const SLOT_LABELS: Readonly<Record<Slot, string>> = {
  name: "Name",
  callsign: "Callsign",
  age: "Age",
  year_licensed: "Year licensed",
  city: "City",
  region_short: "Region, short",
  region_long: "Region, long",
  antenna: "Antenna",
  rig_manufacturer: "Manufacturer",
  rig_model: "Model",
  power: "Power (W)",
};

const SLOT_RE = /\{([a-z_]+)\}/g;

const isSlot = (s: string): s is Slot => Object.hasOwn(SLOTS, s);

/** The slots a text uses, in order of first use. */
export function slotsOf(text: string): string[] {
  return [...new Set([...text.matchAll(SLOT_RE)].map((m) => m[1]!))];
}

/** A drill with its slots filled from `user`.
 *
 * A slot with no value is shown as its name in brackets, `[NAME]`, and listed
 * in `missing`. A drill with no slots comes back as the same object. */
export function fillDrill(drill: Drill, user: UserInfo): Drill {
  if (!slotsOf(drill.text).length) return drill;
  const missing = new Set<Slot>();
  const text = drill.text
    .replace(SLOT_RE, (_whole, slot: string) => {
      const value = isSlot(slot) ? user[SLOTS[slot]].trim() : "";
      if (value) return value;
      if (isSlot(slot)) missing.add(slot);
      return `[${slot.toUpperCase()}]`;
    })
    .split(/\s+/)
    .join(" ");
  return { ...drill, text, missing: [...missing] };
}

export function fillDrills(drills: readonly Drill[], user: UserInfo): Drill[] {
  return drills.map((d) => fillDrill(d, user));
}

/** The words a note in brackets can use for each detail, in lower case. A
 *  rig is the two slots the catalog sends it as. */
const NOTE_WORDS: readonly (readonly [readonly Slot[], readonly string[]])[] = [
  [["callsign"], ["call", "callsign", "call sign", "sign"]],
  [["name"], ["name", "first name", "op", "handle"]],
  [["city"], ["qth", "city", "town", "location", "loc"]],
  [["region_short"], ["state", "st", "province", "prov", "region", "region short"]],
  [["region_long"], ["state name", "full state", "region long"]],
  [["age"], ["age"]],
  [["year_licensed"], ["year licensed", "licensed", "lic", "year", "ham since"]],
  [["antenna"], ["antenna", "ant"]],
  [["rig_manufacturer", "rig_model"], ["rig", "radio", "transceiver", "xcvr"]],
  [["rig_manufacturer"], ["manufacturer", "make", "rig manufacturer"]],
  [["rig_model"], ["model", "rig model"]],
  [["power"], ["power", "pwr", "watts", "w"]],
];

/** A note in brackets, such as "(your call)" or "(UR QTH)". */
const NOTE_RE = /\(([^()\n]*)\)/g;

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const swap = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + swap);
    }
    row = next;
  }
  return row[b.length]!;
}

/** The slots a note in brackets stands for, or null when it names no user
 *  detail. A word one letter off still matches, if it has four letters or more. */
export function slotsForNote(note: string): readonly Slot[] | null {
  const words = note
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (["your", "ur", "yr", "my"].includes(words[0] ?? "")) words.shift();
  const said = words.join(" ");
  if (!said) return null;
  let near: readonly Slot[] | null = null;
  for (const [slots, names] of NOTE_WORDS) {
    for (const name of names) {
      const off = editDistance(said, name);
      if (off === 0) return slots;
      if (off === 1 && said.length >= 4) near ??= slots;
    }
  }
  return near;
}

/** Text with each note in brackets that names a user detail, such as
 *  "(your call)", replaced by what `fill` gives for its slots. `fill` also gets
 *  the note as written. A note that names no detail, or that `fill` gives null
 *  for, stays as it is. */
export function replaceNotes(
  text: string,
  fill: (slots: readonly Slot[], note: string) => string | null,
): string {
  return text.replace(NOTE_RE, (whole, note: string) => {
    const slots = slotsForNote(note);
    return (slots && fill(slots, whole)) ?? whole;
  });
}

/** Notes in brackets as slots, such as `{callsign}` for "(your call)". */
export const notesToSlots = (text: string): string =>
  replaceNotes(text, (slots) => slots.map((s) => `{${s}}`).join(" "));

const DAILY = "Daily Sending";
const QSO = "QSO";

const WARM_UPS = [
  "EEEEE TTTTT IIIII MMMMM SSSSS OOOOO HHHHH 00000 55555",
  "AAAAA NNNNN UUUUU DDDDD VVVVV BBBBB 44444 66666",
  "ABCDEF GHIJK LMNOP QRSTU VWXYZ 12345 67890 / , . ?",
  "THE QUICK BROWN FOX JUMPED OVER THE LAZY DOGS BACK 70364 51289",
];

const EXERCISES = [
  "AAAAA BBBBB CCCCC DDDDD EEEEE FFFFF GGGGG HHHHH IIIII JJJJJ",
  "KKKKK LLLLL MMMMM NNNNN OOOOO PPPPP QQQQQ RRRRR",
  "SSSSS TTTTT UUUUU VVVVV WWWWW XXXXX YYYYY ZZZZZ",
  "11111 22222 33333 44444 55555 66666 77777 88888 99999 00000",
];

// Each section ends with all of its lines as one drill, with a break between
// lines. A drill's id is its position, so new drills go at the end of a section.
export const DRILLS: readonly Drill[] = [
  ...section("daily-sending/warm-up", [DAILY, "Warm Up"], [
    ...WARM_UPS,
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].map((c) => c.repeat(3)).join(" "),
    WARM_UPS.join(` ${BREAK} `),
  ]),
  ...section("daily-sending/exercise", [DAILY, "Exercise"], [
    ...EXERCISES,
    EXERCISES.join(` ${BREAK} `),
  ]),
  ...section("daily-sending/drill", [DAILY, "Drill"], [
    "THE QUICK BROWN FOX JUMPED OVER THE LAZY DOGS BACK 70364 51289",
    "BENS BEST BENT WIRE/5",
    "///// ,,,,, ..... ????? " +
      "<SK><SK><SK><SK><SK> <AR><AR><AR><AR><AR> <BT><BT><BT><BT><BT>",
  ]),
  // From the CW Academy Fundamental curriculum, with "(your ...)" as slots.
  ...section("qso/cq", [QSO, "CQ"], [
    "CQ CQ CQ DE {callsign} {callsign} {callsign} K",
  ]),
  ...section("qso/name-qth", [QSO, "Name & QTH"], [
    "NAME IS {name} {name} <BT> QTH HR {region_short} {region_short}",
    "{name} DE {callsign}",
    "{name} {name} QTH IS {city} {region_short} {city} {region_short}",
    "NAME IS {name} ES QTH IS {city} {region_short}",
  ]),
  ...section("qso/exchange", [QSO, "Exchange"], [
    "NAME IS {name} UR RST 5NN <BK>",
    "NAME IS {name} UR RST 5NN QTH IS {city} {region_short} " +
      "RIG IS {rig_manufacturer} {rig_model} ANT IS {antenna} HAM SINCE {year_licensed}",
    "UR SIG 5NN NAME IS {name} {name} QTH IS {city} {region_short} {city} {region_short} " +
      "RIG IS {rig_manufacturer} {rig_model} RUNNING {power}W CUL 73 73",
    "GD MATE UR SIG 5NN DE {callsign} " +
      "TU NAME HR IS {name} {name} DE {callsign} " +
      "QTH IS {city} {region_short} {city} {region_short} DE {callsign}",
  ]),
];

function section(prefix: string, path: readonly [string, string], lines: string[]): Drill[] {
  return lines.map((text, i) => ({ id: `${prefix}/${i + 1}`, path, text }));
}

/** The group that holds the drills the user wrote. It has one section, with
 *  no name. */
export const CUSTOM = "Custom";

export function customDrills(saved: readonly CustomDrill[]): Drill[] {
  return saved.map((d) => ({ id: d.id, path: [CUSTOM, ""], text: d.text }));
}

/** The catalog and the user's own drills, filled from the saved details. */
export function loadDrills(): Drill[] {
  return fillDrills([...DRILLS, ...customDrills(loadCustomDrills())], loadUser());
}

/** A message as `normalizeMessage` leaves it, with slot names kept in lower
 *  case so that `{NAME}` typed in an upper-case field is still a slot. */
export function normalizeDrill(text: string): string {
  return normalizeMessage(text).replace(/\{[A-Z_]+\}/g, (slot) => slot.toLowerCase());
}

/** What stops a normalized text from being a drill: slots that read no user
 *  detail, and symbols with no Morse. Empty when it can be saved. */
export function drillProblems(text: string): string[] {
  const unknown = slotsOf(text).filter((s) => !isSlot(s));
  const unkeyable = new Set(
    tokenize(text.replace(SLOT_RE, " ")).filter((t) => t !== " " && !(t in CHAR_TO_MORSE)),
  );
  return [
    ...unknown.map((s) => `{${s}} is not a slot.`),
    ...[...unkeyable].map((t) => `${t} has no Morse.`),
  ];
}

export interface DrillGroup {
  name: string;
  sections: { name: string; drills: Drill[] }[];
}

/** Groups and sections in the order they first appear. */
export function groupDrills(drills: readonly Drill[]): DrillGroup[] {
  const groups: DrillGroup[] = [];
  for (const drill of drills) {
    const [g, s] = drill.path;
    let group = groups.find((x) => x.name === g);
    if (!group) groups.push((group = { name: g, sections: [] }));
    let sec = group.sections.find((x) => x.name === s);
    if (!sec) group.sections.push((sec = { name: s, drills: [] }));
    sec.drills.push(drill);
  }
  return groups;
}
