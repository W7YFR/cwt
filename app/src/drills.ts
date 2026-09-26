/* Practice drills: a flat catalog whose grouping comes from each entry's path.
 *
 * Flat so that any picker can show it its own way — grouped under headers in
 * the new-session dialog, or as one searchable list of breadcrumbs. */

export interface Drill {
  /** Stable across releases: keys and test ids are built from it. */
  id: string;
  /** Group, then section. */
  path: readonly [string, string];
  /** The target message, upper case with single spaces. */
  text: string;
}

const DAILY = "Daily Sending";

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
    "<DN> <DN> <DN> <DN> <DN> , , , , , . . . . . ? ? ? ? ? " +
      "<SK> <SK> <SK> <SK> <SK> <AR> <AR> <AR> <AR> <AR> <BT> <BT> <BT> <BT> <BT>",
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
