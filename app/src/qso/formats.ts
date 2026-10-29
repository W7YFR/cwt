/* The kinds of QSO your CQ can call for.
 *
 * A plain CQ is a rag chew, run by cq.ts. A CQ with a format's word in it,
 * as CQ CWT or CQ POTA, is a run of short QSOs in that format, run by
 * run.ts: each station sends its call, the two of you swap the exchange, you
 * send TU, and the next station calls.
 *
 * Each format sets what goes in the exchange and how fast its stations
 * send, from the sponsor's rules and what is usual on the air.
 */

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
}

export const FORMATS: Readonly<Record<FormatId, Format>> = {
  cwt: { id: "cwt", word: "CWT", yours: ["name", "number"], wpm: [26, 32] },
  sst: { id: "sst", word: "SST", yours: ["name", "region"], wpm: [14, 20] },
  mst: { id: "mst", word: "MST", yours: ["name", "number"], wpm: [20, 25] },
  pota: { id: "pota", word: "POTA", yours: ["report", "region"], wpm: [16, 25] },
};

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

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
