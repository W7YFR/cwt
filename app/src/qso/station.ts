/* The other station: who answers your CQ.
 *
 * Made up from short lists, so every word keys cleanly and reads the way it
 * would on the air. `rand` is passed in, so a test can fix the station.
 */

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
}

const NAMES = [
  "AL", "ANN", "BILL", "BOB", "CHUCK", "DAN", "DAVE", "ED", "FRED", "GARY",
  "JIM", "JOE", "JOHN", "KEN", "LEE", "MARK", "MIKE", "PAT", "PETE", "RICK",
  "RON", "SAM", "SUE", "TOM", "WALT",
];

const QTHS = [
  "ATLANTA GA", "AUSTIN TX", "BOISE ID", "BOSTON MA", "DENVER CO",
  "DULUTH MN", "FARGO ND", "MIAMI FL", "OMAHA NE", "PHOENIX AZ",
  "PORTLAND ME", "RALEIGH NC", "RENO NV", "SALEM OR", "SPOKANE WA",
  "TOPEKA KS", "TUCSON AZ", "TULSA OK",
];

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

/** A US call: K, N or W with a 2- or 3-letter suffix, or AA to AL with a
 *  2-letter one. */
export function randomCall(rand: Rand): string {
  const digit = String(Math.floor(rand() * 10));
  const r = rand();
  if (r < 0.2) return `A${pick(rand, [..."ABCDEFGHIJKL"])}${digit}${letters(rand, 2)}`;
  return `${pick(rand, ["K", "N", "W"])}${digit}${letters(rand, r < 0.6 ? 3 : 2)}`;
}

/** A new station, never at the call `not`. */
export function randomStation(rand: Rand, not = ""): Station {
  let call = randomCall(rand);
  while (call === not) call = randomCall(rand);
  return {
    call,
    name: pick(rand, NAMES),
    qth: pick(rand, QTHS),
    rst: pick(rand, RSTS),
    toneHz: 550 + Math.round(rand() * 20) * 10,
    habit: 0.05 + 0.3 * rand(),
  };
}
