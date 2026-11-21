/* The kinds of QSO your CQ can call for.
 *
 * A plain CQ is a standard QSO, run by cq.ts. A CQ with a format's word in it,
 * as CQ CWT or CQ POTA, is a run of short QSOs in that format, run by
 * run.ts: each station sends its call, the two of you swap the exchange, you
 * send TU, and the next station calls.
 *
 * Each format sets what goes in the exchange and how fast its stations
 * send, from the sponsor's rules and what is usual on the air.
 */

import type { KeyChances } from "./station";

export type FormatId = "cwt" | "sst" | "mst" | "pota";

/** One item of an exchange. */
export type Item = "name" | "number" | "region" | "report";

export interface Format {
  readonly id: FormatId;
  /** The word in a CQ that calls for it, and its name on the page. */
  readonly word: string;
  /** What you send, in order. CWT's number is your CWops number, or your
   *  region if you have none. */
  readonly yours: readonly Item[];
  /** The effective speeds its stations send at, slowest and fastest. */
  readonly wpm: readonly [number, number];
  /** How many of its stations are in Canada, 0 to 1. */
  readonly canada: number;
  /** How many of its stations key on each key worked by hand, 0 to 1: few
   *  bugs in the fast CWT, more in the slower SST. */
  readonly keys: KeyChances;
}

export const FORMATS: Readonly<Record<FormatId, Format>> = {
  cwt: { id: "cwt", word: "CWT", yours: ["name", "number"], wpm: [26, 32], canada: 0.08, keys: { bug: 0.03, straight: 0.005 } },
  sst: { id: "sst", word: "SST", yours: ["name", "region"], wpm: [14, 20], canada: 0.08, keys: { bug: 0.12, straight: 0.06 } },
  mst: { id: "mst", word: "MST", yours: ["name", "number"], wpm: [20, 25], canada: 0.08, keys: { bug: 0.06, straight: 0.03 } },
  pota: { id: "pota", word: "POTA", yours: ["report", "region"], wpm: [16, 25], canada: 0.03, keys: { bug: 0.05, straight: 0.04 } },
};

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

/** What a CW Academy student sends in a CWT in place of a number. */
export const ACADEMY = "CWA";

/** The speeds a CW Academy student sends at in a CWT, slowest and fastest.
 *  They are learning. */
export const ACADEMY_WPM: readonly [number, number] = [15, 22];

/** How far below a straight key's fastest a station on one in a run may
 *  send. */
export const STRAIGHT_WPM_SPAN = 5;

/** The format a word names, or null. */
export function formatNamed(word: string): FormatId | null {
  return FORMAT_IDS.find((id) => FORMATS[id].word === word) ?? null;
}

/** US states, Canadian provinces and the like, as an exchange sends them. A
 *  station takes one of these, or your own region from User, as a region. */
export const REGIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR",
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);
