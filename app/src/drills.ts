/* Practice drills: a flat catalog whose grouping comes from each entry's path.
 *
 * Flat so that any picker can show it its own way — grouped under headers in
 * the new-session dialog, or as one searchable list of breadcrumbs.
 *
 * A drill's text can hold slots, such as `{name}`, that `fillDrill` fills from
 * the user's details. */

import type { UserInfo } from "@/io/storage";

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
  city: "qthCity",
  region_short: "qthRegionShort",
  region_long: "qthRegionLong",
  antenna: "antenna",
  rig_manufacturer: "rigManufacturer",
  rig_model: "rigModel",
} as const satisfies Record<string, keyof UserInfo>;

export type Slot = keyof typeof SLOTS;

/** The field names the configuration page shows, for saying what is missing. */
export const SLOT_LABELS: Readonly<Record<Slot, string>> = {
  name: "Name",
  callsign: "Callsign",
  age: "Age",
  city: "City",
  region_short: "Region, short",
  region_long: "Region, long",
  antenna: "Antenna",
  rig_manufacturer: "Manufacturer",
  rig_model: "Model",
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

const DAILY = "Daily Sending";
const QSO = "QSO";

export const DRILLS: readonly Drill[] = [
  ...section("daily-sending/warm-up", [DAILY, "Warm Up"], [
    "EEEEE TTTTT IIIII MMMMM SSSSS OOOOO HHHHH 00000 55555",
    "AAAAA NNNNN UUUUU DDDDD VVVVV BBBBB 44444 66666",
    "ABCDEF GHIJK LMNOP QRSTU VWXYZ 12345 67890 <DN> , . ?",
    "THE QUICK BROWN FOX JUMPED OVER THE LAZY DOGS BACK 70364 51289",
  ]),
  ...section("daily-sending/exercise", [DAILY, "Exercise"], [
    "AAAAA BBBBB CCCCC DDDDD EEEEE FFFFF GGGGG HHHHH IIIII JJJJJ",
    "KKKKK LLLLL MMMMM NNNNN OOOOO PPPPP QQQQQ RRRRR",
    "SSSSS TTTTT UUUUU VVVVV WWWWW XXXXX YYYYY ZZZZZ",
    "11111 22222 33333 44444 55555 66666 77777 88888 99999 00000",
  ]),
  ...section("daily-sending/drill", [DAILY, "Drill"], [
    "THE QUICK BROWN FOX JUMPED OVER THE LAZY DOGS BACK 70364 51289",
    "BENS BEST BENT WIRE/5",
    "<DN><DN><DN><DN><DN> ,,,,, ..... ????? " +
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
    "GD MATE UR SIG 5NN DE {callsign} " +
      "TU NAME HR IS {name} {name} DE {callsign} " +
      "QTH IS {city} {region_short} {city} {region_short} DE {callsign}",
  ]),
];

function section(prefix: string, path: readonly [string, string], lines: string[]): Drill[] {
  return lines.map((text, i) => ({ id: `${prefix}/${i + 1}`, path, text }));
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
