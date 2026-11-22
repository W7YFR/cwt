/* What one turn says: who sends it, to whom, and the details in it.
 *
 * Only what a turn says plainly is taken: a name after NAME or OP, a QTH after
 * QTH, a report after RST or UR, and so on. A contest exchange is taken by its
 * shape once the kind of QSO is known. Anything less sure is left out.
 *
 * Pure.
 */

import { REGIONS } from "@/qso/formats";
import { CALL_RE } from "./turns";

/** The details a station gives. Each is what was copied, as sent. */
export interface Fields {
  name?: string;
  qth?: string;
  /** State, province or region, when the QTH or the exchange gives one. */
  state?: string;
  /** The report this station sent, as 599. */
  rst?: string;
  power?: string;
  rig?: string;
  ant?: string;
  /** A CWops or MST member number, or CWA. */
  number?: string;
  /** A park, as US-1234. */
  park?: string;
  /** An SKCC number. */
  skcc?: string;
}

export const FIELD_KEYS = ["name", "qth", "state", "rst", "power", "rig", "ant", "number", "park", "skcc"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** The kinds of QSO the decoder can name. */
export type QsoKind = "cwt" | "sst" | "mst" | "pota" | "sota" | "skcc" | "contest" | "fd" | "ragchew";

export const KIND_LABEL: Readonly<Record<QsoKind, string>> = {
  cwt: "CWT",
  sst: "SST",
  mst: "MST",
  pota: "POTA",
  sota: "SOTA",
  skcc: "SKCC",
  contest: "Contest",
  fd: "Field Day",
  ragchew: "Rag chew",
};

/** The word after CQ that names a kind. */
const CQ_KINDS: Readonly<Record<string, QsoKind>> = {
  CWT: "cwt",
  SST: "sst",
  MST: "mst",
  POTA: "pota",
  SOTA: "sota",
  SKCC: "skcc",
  TEST: "contest",
  CONTEST: "contest",
  FD: "fd",
};

/** Words that are never a name, a QTH or a rig. */
const STOP = new Set([
  "NAME", "NM", "OP", "QTH", "LOC", "RST", "UR", "URS", "RIG", "ANT", "PWR", "POWER", "WX", "HR", "IS", "ES", "AND",
  "BT", "<BT>", "=", "K", "KN", "<KN>", "BK", "<BK>", "DE", "TNX", "TKS", "TU", "FB", "HW", "HW?", "AGE", "73", "72",
  "SK", "<SK>", "AR", "<AR>", "GM", "GA", "GE", "GN", "CUL", "R", "RR", "QSL", "QSO", "CQ", "OM", "YL", "DR", "NR", "ABT",
  "SO", "HPE", "AGN", "PSE", "?", "OK", "SRI", "BTU", "VY", "GL", "GD", "DX", "MY", "THE", "IN", "AT", "NW", "TEST", "5NN",
  "599", "ENN", "EE", "E", "T", "TT", "W", "WATTS", "WTS", "QRP", "QRO", "KW", "INTO", "BEAM", "DIPOLE", "VERT", "EFHW",
]);

/** What may follow TU and a call at the end of a contest QSO. */
const SIGN_OFF = new Set(["73", "GL", "E", "EE", "CWT", "SST", "MST", "TEST", "QRZ", "QRZ?", "POTA"]);

/** A report: three figures, nines often sent as N. */
const RST_RE = /^[1-5][1-9NE][1-9N]$/;
const PARK_RE = /^[A-Z0-9]{1,3}-\d{4,5}$/;
const NAME_RE = /^[A-Z]{2,10}$/;

export function isCall(word: string): boolean {
  return CALL_RE.test(word);
}

/** A report as figures: 5NN is 599. */
function figures(rst: string): string {
  return rst.replace(/N/g, "9").replace(/^([1-5])E/, "$15");
}

/** What a turn says. */
export interface Said {
  readonly words: readonly string[];
  /** The kind its CQ names; "" for a plain CQ; null when it is no CQ. */
  readonly cq: QsoKind | "" | null;
  /** Every call in it, in order. */
  readonly calls: readonly string[];
  /** The call after DE. */
  readonly de: string | null;
  /** The call before DE. */
  readonly to: string | null;
  /** It is nothing but calls, perhaps with DE: a station calling. */
  readonly callsOnly: boolean;
  /** It ends the QSO: SK, or E E. */
  readonly ends: boolean;
  /** It says 73. */
  readonly best: boolean;
  /** It thanks and ends a contest QSO: TU, and nothing after but a call. */
  readonly thanks: boolean;
  readonly fields: Fields;
}

/** The word after `at`, past IS, HR and the like. */
function nextWord(words: readonly string[], at: number, skip: ReadonlySet<string>): number {
  let i = at + 1;
  while (i < words.length && skip.has(words[i]!)) i++;
  return i;
}

const FILLER = new Set(["IS", "HR", "HERE", "ES", "NR", "ABT", "UR", "RST", "=", "<BT>", "BT", "OP"]);

/** Read one turn. `kind` is what the QSO is known to be, for reading an
 *  exchange by its shape. */
export function readSaid(text: string, kind: QsoKind | null = null): Said {
  const words = text.split(" ").filter((w) => w.length > 0);
  const calls = words.filter(isCall);
  const deAt = words.lastIndexOf("DE");
  const de = deAt >= 0 && words[deAt + 1] && isCall(words[deAt + 1]!) ? words[deAt + 1]! : null;
  const to = deAt > 0 && isCall(words[deAt - 1]!) ? words[deAt - 1]! : null;
  const cqAt = words.indexOf("CQ");
  let cq: QsoKind | "" | null = null;
  if (cqAt >= 0 && cqAt <= 2) {
    cq = "";
    for (const w of words.slice(cqAt + 1)) {
      if (isCall(w) || w === "DE") break;
      const k = CQ_KINDS[w];
      if (k) {
        cq = k;
        break;
      }
    }
  }
  const tail = words.filter((w) => w !== "K" && w !== "KN" && w !== "<KN>" && w !== "BK" && w !== "<BK>");
  const callsOnly = calls.length > 0 && tail.every((w) => isCall(w) || w === "DE" || w.endsWith("?") && isCall(w.slice(0, -1)));
  const last = words[words.length - 1] ?? "";
  const lastTwo = words.slice(-2).join(" ");
  const ends = words.includes("SK") || words.includes("<SK>") || lastTwo === "E E" || last === "EE";
  const best = words.includes("73");
  const tuAt = words.lastIndexOf("TU");
  const thanks = tuAt >= 0 && words.slice(tuAt + 1).every((w) => isCall(w) || SIGN_OFF.has(w));

  const fields: Fields = {};
  const set = (k: FieldKey, v: string | undefined) => {
    if (v && fields[k] === undefined) fields[k] = v;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "NAME" || w === "NM" || w === "OP") {
      const j = nextWord(words, i, FILLER);
      const n = words[j];
      if (n && NAME_RE.test(n) && !STOP.has(n) && !isCall(n)) set("name", n);
    } else if (w === "QTH" || w === "LOC") {
      let j = nextWord(words, i, FILLER);
      const place: string[] = [];
      while (j < words.length && place.length < 3 && !STOP.has(words[j]!) && !isCall(words[j]!) && /^[A-Z][A-Z.]*$/.test(words[j]!)) {
        place.push(words[j]!);
        j++;
      }
      if (place.length) {
        set("qth", place.join(" "));
        const region = place.find((p) => REGIONS.has(p));
        set("state", region);
      }
    } else if (w === "RST" || w === "UR") {
      const j = nextWord(words, i, FILLER);
      const r = words[j];
      if (r && RST_RE.test(r)) set("rst", figures(r));
    } else if (w === "PWR" || w === "POWER") {
      const j = nextWord(words, i, FILLER);
      const p = words[j];
      if (p && /^\d{1,4}W?$/.test(p)) set("power", /W$/.test(p) ? p : words[j + 1] === "W" || words[j + 1] === "WATTS" ? `${p}W` : p);
      else if (p === "QRP" || p === "KW") set("power", p);
    } else if (w === "RIG") {
      let j = nextWord(words, i, FILLER);
      const rig: string[] = [];
      while (j < words.length && rig.length < 2 && !STOP.has(words[j]!) && !isCall(words[j]!)) {
        rig.push(words[j]!);
        j++;
      }
      if (rig.length) set("rig", rig.join(" "));
    } else if (w === "ANT") {
      let j = nextWord(words, i, FILLER);
      const ant: string[] = [];
      while (j < words.length && ant.length < 3 && !(STOP.has(words[j]!) && !["DIPOLE", "VERT", "BEAM", "EFHW"].includes(words[j]!))) {
        ant.push(words[j]!);
        j++;
      }
      if (ant.length) set("ant", ant.join(" "));
    } else if (w === "SKCC") {
      const n = words[i + 1];
      if (n && /^\d{1,6}[CTS]?$/.test(n)) set("skcc", n);
    } else if (PARK_RE.test(w)) {
      set("park", w);
    }
  }

  // A contest exchange, by its shape: what is left once the calls and the
  // courtesies are taken out.
  const core = words.filter(
    (w) => !isCall(w) && !["TU", "R", "RR", "BK", "<BK>", "K", "DE", "TNX", "73", "GL", "EE", "E", "FB", "CQ", "TEST"].includes(w),
  );
  const rstAt = core.findIndex((w) => RST_RE.test(w));
  if (rstAt >= 0 && (kind === "pota" || kind === "sota" || kind === "contest" || kind === "fd" || kind === "skcc")) {
    set("rst", figures(core[rstAt]!));
    const after = core[rstAt + 1];
    if (after && REGIONS.has(after)) set("state", after);
  }
  const ex = core.filter((w) => !RST_RE.test(w));
  if (ex.length === 2 && NAME_RE.test(ex[0]!) && !STOP.has(ex[0]!)) {
    const [name, second] = ex as [string, string];
    const isNumber = /^\d{1,6}$/.test(second);
    const isRegion = REGIONS.has(second);
    if (kind === "cwt" || kind === "mst" || kind === null) {
      if (isNumber || second === "CWA") {
        set("name", name);
        set("number", second);
      } else if (isRegion && kind !== null) {
        set("name", name);
        set("state", second);
      }
    } else if (kind === "sst" && (isRegion || /^[A-Z]{2,3}$/.test(second))) {
      set("name", name);
      set("state", second);
    }
  }
  if (kind === "pota" && !fields.state) {
    const region = core.find((w) => REGIONS.has(w));
    if (region && fields.rst) set("state", region);
  }

  return { words, cq, calls, de, to, callsOnly, ends, best, thanks, fields };
}

/** The kind a QSO looks like from what it says, without a CQ. Only a
 *  plain sign counts: a park is POTA, NAME and QTH are a rag chew. */
export function kindFromFields(all: readonly Fields[]): QsoKind | null {
  if (all.some((f) => f.park)) return "pota";
  if (all.some((f) => f.skcc)) return "skcc";
  if (all.some((f) => f.qth || f.rig || f.ant)) return "ragchew";
  return null;
}
