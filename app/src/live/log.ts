/* The transcript and the QSOs in it, built from the turns.
 *
 * Everything here is worked out again from the turns and your fixes each time
 * either changes, so a fix to one line flows into every card it touches. Only
 * the turns and the fixes are kept.
 *
 * A call read once and a letter or two off a call read often, or a call you
 * confirmed, is taken as that call: W1AWB is W1AW/5 misread.
 *
 * Who sent a turn, best effort, in this order:
 *
 *   1. your fix;
 *   2. the call after DE;
 *   3. the call a CQ ends with, or the best read of its calls;
 *   4. a call sent on its own: a station calling;
 *   5. TU and a call: the call is the one signing, when it called CQ;
 *   6. a call at the start, of a station in the QSO: the other station sent
 *      it;
 *   7. the station whose strength and speed match;
 *   8. the station who did not send the turn before.
 *
 * A station that calls CQ keeps its pitch: a new QSO there, with no CQ, has
 * it as the station running. A call you confirm holds its pitch for good.
 *
 * Pure.
 */

import { kindFromFields, readSaid, type Fields, type QsoKind, type Said } from "./parse";
import { isCall } from "./turns";

/** A turn as kept: the decoder's turn, placed in time. */
export interface LiveTurn {
  /** Unique across sessions. */
  readonly id: string;
  /** The signal it was on: unique across sessions. */
  readonly chan: string;
  readonly hz: number;
  /** Start and end, ms since the epoch. */
  readonly at: number;
  readonly end: number;
  readonly text: string;
  readonly wpm: number;
  /** Mean mark level, dB. */
  readonly db: number;
}

/** What you have corrected. */
export interface Fixes {
  /** The station that sent a turn, by turn id. */
  readonly sender: Readonly<Record<string, string>>;
  /** Details on a card, by QSO id, then call. */
  readonly fields: Readonly<Record<string, Readonly<Record<string, Fields>>>>;
  /** Calls you confirmed, with the pitch of the line you confirmed them on,
   *  Hz. */
  readonly confirmed?: Readonly<Record<string, number>>;
  /** The radio's frequency you noted, by QSO id. It holds for the QSOs
   *  after, until the next one you note. Empty clears it. */
  readonly freq?: Readonly<Record<string, string>>;
}

export const NO_FIXES: Fixes = { sender: {}, fields: {}, confirmed: {} };

export interface Line {
  readonly turn: LiveTurn;
  /** The station that sent it, or null when it cannot be told. */
  readonly sender: string | null;
  /** You sent it. */
  readonly mine: boolean;
  /** The QSO it belongs to. */
  readonly qso: string | null;
}

export interface Station {
  readonly call: string;
  /** You confirmed the call. */
  readonly confirmed: boolean;
  readonly fields: Fields;
  readonly mine: boolean;
  /** Its speed, WPM, over its turns. */
  readonly wpm: number;
}

export interface Qso {
  /** The id of its first turn. */
  readonly id: string;
  readonly chan: string;
  readonly hz: number;
  readonly at: number;
  readonly end: number;
  readonly kind: QsoKind | null;
  /** The radio's frequency, as you noted it here or on a QSO before. */
  readonly freq: string | null;
  /** The station that called CQ first, then the rest as they came in. */
  readonly stations: readonly Station[];
  readonly ended: boolean;
}

export interface Log {
  readonly lines: readonly Line[];
  readonly qsos: readonly Qso[];
}

/** After this long without a turn, the next turn on the signal starts a new
 *  QSO, ms. */
const QSO_GAP_MS = 3 * 60_000;
/** A turn matches a station when their strengths are this close, dB. */
const MATCH_DB = 4;
/** ...and their speeds this close, as a share of the speed. */
const MATCH_WPM = 0.15;

/** A call snaps to another read at least this many times as often... */
const SNAP_TIMES = 3;
/** ...and at least this many times. */
const SNAP_MIN_READS = 2;
/** A call read in this many lines or more holds its pitch when it calls
 *  CQ... */
const HOLD_READS = 2;
/** ...and one read this often takes over a call read once there. */
const KNOWN_READS = 3;
/** Lines this close in pitch are on one signal, Hz. */
const SAME_PITCH_HZ = 15;

/** Kinds where TU after the exchange ends the QSO. */
const RUN_KINDS = new Set<QsoKind>(["cwt", "sst", "mst", "pota", "sota", "contest", "fd", "skcc"]);

interface Work {
  id: string;
  chan: string;
  hz: number;
  at: number;
  end: number;
  kind: QsoKind | null;
  /** The station that called CQ. */
  runner: string | null;
  parties: string[];
  fields: Map<string, Fields>;
  db: Map<string, { sum: number; n: number }>;
  wpm: Map<string, { sum: number; n: number }>;
  last: string | null;
  ended: boolean;
  /** Stations that have said 73. */
  best: Set<string>;
}

function start(turn: LiveTurn, runner: string | null): Work {
  return {
    id: turn.id,
    chan: turn.chan,
    hz: turn.hz,
    at: turn.at,
    end: turn.end,
    kind: null,
    runner,
    parties: runner ? [runner] : [],
    fields: new Map(),
    db: new Map(),
    wpm: new Map(),
    last: null,
    ended: false,
    best: new Set(),
  };
}

function join(q: Work, call: string | null | undefined): void {
  if (call && !q.parties.includes(call)) q.parties.push(call);
}

const mean = (m: Map<string, { sum: number; n: number }>, call: string) => {
  const v = m.get(call);
  return v && v.n ? v.sum / v.n : NaN;
};

/** The station in `q` whose strength and speed match `turn`, if just one. */
function matching(q: Work, turn: LiveTurn): string | null {
  const fits = q.parties.filter((p) => {
    const db = mean(q.db, p);
    const wpm = mean(q.wpm, p);
    if (Number.isNaN(db)) return false;
    const speedFits = !turn.wpm || Number.isNaN(wpm) || Math.abs(turn.wpm - wpm) <= MATCH_WPM * wpm;
    return Math.abs(turn.db - db) <= MATCH_DB && speedFits;
  });
  return fits.length === 1 ? fits[0]! : null;
}

/** The other station of a two-station QSO. */
function other(q: Work, call: string | null): string | null {
  if (q.parties.length !== 2 || !call) return null;
  return q.parties.find((p) => p !== call) ?? null;
}

/** The fewest letters to add, drop or change to turn `a` into `b`. */
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/** A call without its portable: the longest part between slashes. W1AW/5
 *  and VE3/W1AW are both W1AW. */
const base = (call: string) => call.split("/").reduce((a, b) => (b.length > a.length ? b : a), "");

/** The first digit of a call: its call area. */
const area = (call: string) => /\d/.exec(base(call))?.[0] ?? "";

/** Whether `a` can be `b` misread: the same call with or without a
 *  portable, or the same call area and one letter off, or two for a call
 *  longer than 4. */
function near(a: string, b: string): boolean {
  if (base(a) === base(b)) return true;
  if (area(a) !== area(b)) return false;
  return edits(a, b) <= (Math.min(a.length, b.length) > 4 ? 2 : 1);
}

/** Each call read in `turns`, as the call it is taken for. */
function snapCalls(turns: readonly LiveTurn[], confirmed: readonly string[]): (call: string) => string {
  const reads = new Map<string, number>();
  for (const t of turns) {
    for (const w of new Set(t.text.split(" "))) if (isCall(w)) reads.set(w, (reads.get(w) ?? 0) + 1);
  }
  const sure = new Set(confirmed);
  const n = (c: string) => reads.get(c) ?? 0;
  // The most read first, so a call snaps to one already settled.
  const order = [...reads.keys()].sort((a, b) => n(b) - n(a));
  const to = new Map<string, string>();
  for (const c of order) {
    if (sure.has(c)) continue;
    const mine = confirmed.filter((k) => near(c, k));
    if (mine.length) {
      to.set(c, mine.sort((a, b) => edits(c, a) - edits(c, b))[0]!);
      continue;
    }
    const better = order.find((k) => k !== c && n(k) >= Math.max(SNAP_MIN_READS, SNAP_TIMES * n(c)) && near(c, k));
    if (better) to.set(c, to.get(better) ?? better);
  }
  return (call) => to.get(call) ?? call;
}

/** What `text` says, read for a QSO of `kind`, with each call taken as
 *  `snap` reads it. With `myCall`, the end of your call with its start lost
 *  (7YFR) is your call. */
function heard(text: string, kind: QsoKind | null, snap: (call: string) => string, myCall: string): Said {
  const mine = (w: string) => w.length >= 4 && w !== myCall && /\d/.test(w) && myCall.endsWith(w);
  const words = myCall ? text.split(" ").map((w) => (mine(w) ? myCall : w)) : [text];
  return snapped(readSaid(words.join(" "), kind), snap);
}

/** `said` with each call taken as `snap` reads it. */
function snapped(said: Said, snap: (call: string) => string): Said {
  const fix = (w: string) => (isCall(w) ? snap(w) : w);
  return {
    ...said,
    words: said.words.map(fix),
    calls: said.calls.map(snap),
    de: said.de && snap(said.de),
    to: said.to && snap(said.to),
  };
}

/** A station calling CQ, at a pitch and a time (ms), or a call you
 *  confirmed at a pitch (time null). */
interface Runner {
  readonly call: string;
  readonly hz: number;
  readonly at: number | null;
  /** The speed of its CQ, WPM, or 0 when not known. */
  readonly wpm: number;
}

/** The station running at the pitch of `turn`: a call you confirmed there,
 *  or else the nearest CQ in time, within a QSO's gap. */
function runnerAt(runners: readonly Runner[], turn: LiveTurn): Runner | null {
  const here = runners.filter((r) => Math.abs(r.hz - turn.hz) <= SAME_PITCH_HZ);
  let best: Runner | null = null;
  for (const r of here) {
    if (r.at === null) {
      if (best?.at === null) continue;
      // A confirmed call takes the speed of its nearest CQ.
      const cq = here.filter((o) => o.call === r.call && o.at !== null);
      cq.sort((a, b) => Math.abs(a.at! - turn.at) - Math.abs(b.at! - turn.at));
      best = { ...r, wpm: cq[0]?.wpm ?? 0 };
      continue;
    }
    if (best?.at === null) continue;
    const d = Math.abs(r.at - turn.at);
    if (d <= QSO_GAP_MS && (!best || d < Math.abs(best.at! - turn.at))) best = r;
  }
  return best;
}

/** Whether `turn` sounds like `runner`: its speed, and its strength in `q`
 *  when that is known. */
function soundsLike(q: Work, turn: LiveTurn, runner: Runner): boolean {
  const wpm = mean(q.wpm, runner.call) || runner.wpm;
  if (!wpm || !turn.wpm || Math.abs(turn.wpm - wpm) > MATCH_WPM * wpm) return false;
  const db = mean(q.db, runner.call);
  return Number.isNaN(db) || Math.abs(turn.db - db) <= MATCH_DB;
}

/** The call a CQ is from: the last, unless another of its calls was read
 *  more often or confirmed. */
function cqFrom(said: Said, score: (call: string) => number): string | undefined {
  let best: string | undefined;
  for (const c of said.calls) if (best === undefined || score(c) >= score(best)) best = c;
  return best;
}

/** Build the log from `turns`, in any order, and `fixes`. `myCall` marks
 *  your own turns. */
export function buildLog(
  turns: readonly LiveTurn[],
  fixes: Fixes = NO_FIXES,
  myCall = "",
  open: ReadonlySet<string> = new Set(),
): Log {
  const sorted = [...turns].sort((a, b) => a.at - b.at);
  const confirmed = Object.keys(fixes.confirmed ?? {});
  const snap = snapCalls(sorted, confirmed);
  const reads = new Map<string, number>();
  for (const t of sorted) for (const c of new Set(readSaid(t.text).calls.map(snap))) reads.set(c, (reads.get(c) ?? 0) + 1);
  const score = (c: string) => (fixes.confirmed?.[c] !== undefined ? 1e6 : 0) + (reads.get(c) ?? 0);
  const runners: Runner[] = Object.entries(fixes.confirmed ?? {}).map(([call, hz]) => ({ call, hz, at: null, wpm: 0 }));
  // Only a call read more than once holds a pitch.
  for (const t of sorted) {
    const said = heard(t.text, null, snap, myCall);
    const by = said.cq !== null ? cqFrom(said, score) : undefined;
    if (by && score(by) >= HOLD_READS) runners.push({ call: by, hz: t.hz, at: t.at, wpm: t.wpm });
  }
  /** What `text` says, with a call read once, at the pitch and speed of a
   *  station read often, taken as that station: CB4TKDS where KB4T has
   *  called CQ all along. */
  const heardAt = (turn: LiveTurn, kind: QsoKind | null): Said => {
    const said = heard(turn.text, kind, snap, myCall);
    const holder = runnerAt(runners, turn);
    if (!holder || score(holder.call) < KNOWN_READS) return said;
    const fits = !turn.wpm || !holder.wpm || Math.abs(turn.wpm - holder.wpm) <= MATCH_WPM * holder.wpm;
    if (!fits) return said;
    const weak = (c: string) => c !== holder.call && score(c) < HOLD_READS;
    const sent = [said.de, said.cq !== null ? cqFrom(said, score) : undefined].filter((c): c is string => !!c && weak(c));
    if (sent.length === 0) return said;
    return snapped(said, (c) => (sent.includes(c) ? holder.call : c));
  };
  const said0 = new Map(sorted.map((t) => [t.id, heardAt(t, null)]));
  const byChan = new Map<string, LiveTurn[]>();
  for (const t of sorted) {
    const list = byChan.get(t.chan);
    if (list) list.push(t);
    else byChan.set(t.chan, [t]);
  }

  const lines = new Map<string, Line>();
  const done: Work[] = [];
  for (const list of byChan.values()) {
    let q: Work | null = null;
    for (const turn of list) {
      const said = q?.kind ? heardAt(turn, q.kind) : said0.get(turn.id)!;
      const cqBy = said.cq !== null ? cqFrom(said, score) : undefined;
      if (q && turn.at - q.end > QSO_GAP_MS) {
        done.push(q);
        q = null;
      }
      const fixed = fixes.sender[turn.id];
      const caller = said.de ?? cqBy ?? (said.callsOnly ? said.calls[said.calls.length - 1] : undefined) ?? fixed;
      const addressed = said.to ?? (said.words[0] && said.calls[0] === said.words[0] ? said.calls[0] : undefined);

      // Does this turn start a new QSO?
      let fresh = !q;
      let runner: string | null = null;
      if (q) {
        if (said.cq !== null && (q.parties.length > 1 || (cqBy && q.runner && cqBy !== q.runner))) {
          fresh = true;
        } else if (q.ended && (said.calls.length > 0 || said.cq !== null)) {
          fresh = true;
          runner = q.runner;
        } else if (q.parties.length >= 2) {
          const newcomer = [caller, addressed].find((c) => c && !q!.parties.includes(c));
          if (newcomer) {
            fresh = true;
            // In a run, the station that called CQ stays on for the next.
            const stays = q.runner && (caller === q.runner || addressed === q.runner || said.callsOnly || addressed);
            runner = stays ? q.runner : null;
          }
        }
        if (fresh && q.runner && q.kind && RUN_KINDS.has(q.kind) && runner === null && said.cq === null) runner = q.runner;
      }
      if (fresh) {
        if (q) done.push(q);
        const kind = q && runner ? q.kind : null;
        // A station running at this pitch stays on for the next QSO.
        if (!runner && said.cq === null) runner = runnerAt(runners, turn)?.call ?? null;
        const before = q;
        q = start(turn, runner);
        // Its strength and speed come along, to tell its lines.
        if (before && runner) {
          for (const key of ["db", "wpm"] as const) {
            const v = before[key].get(runner);
            if (v) q[key].set(runner, { ...v });
          }
        }
        q.kind = kind;
      }
      const w = q!;

      // Who sent it.
      let sender: string | null = fixed ?? null;
      if (!sender) {
        if (said.de) sender = said.de;
        else if (said.cq !== null) sender = cqBy ?? null;
        else if (said.callsOnly) {
          const call = said.calls[said.calls.length - 1]!;
          // The station running, sending a caller's call at its own strength
          // and speed.
          sender = call !== w.runner && w.runner && matching(w, turn) === w.runner ? w.runner : call;
        }
        else if (said.thanks && said.calls.length) {
          const signed = said.calls[said.calls.length - 1]!;
          sender = signed === w.runner ? signed : other(w, signed);
        }
        if (!sender && addressed) {
          if (w.parties.includes(addressed)) sender = other(w, addressed);
          else if (w.runner && addressed !== w.runner) sender = w.runner;
        }
        if (!sender) sender = matching(w, turn);
        if (!sender && w.runner) {
          // At the runner's pitch, its speed and its strength: the runner.
          const here = runnerAt(runners, turn);
          if (here?.call === w.runner && soundsLike(w, turn, here)) sender = w.runner;
        }
        if (!sender) sender = other(w, w.last);
      }

      if (said.cq !== null) {
        if (said.cq) w.kind = said.cq;
        if (sender && !w.runner) {
          w.runner = sender;
          w.parties = [sender, ...w.parties.filter((p) => p !== sender)];
        }
      }
      join(w, sender);
      join(w, said.to);
      if (addressed && addressed !== sender) join(w, addressed);

      if (sender) {
        const had = w.fields.get(sender) ?? {};
        const now: Fields = { ...said.fields, ...had };
        // A second reading of a turn with the kind now known can add the
        // exchange.
        if (!said.cq && w.kind) Object.assign(now, { ...readSaid(turn.text, w.kind).fields, ...now });
        w.fields.set(sender, now);
        const db = w.db.get(sender) ?? { sum: 0, n: 0 };
        w.db.set(sender, { sum: db.sum + turn.db, n: db.n + 1 });
        if (turn.wpm) {
          const s = w.wpm.get(sender) ?? { sum: 0, n: 0 };
          w.wpm.set(sender, { sum: s.sum + turn.wpm, n: s.n + 1 });
        }
        if (said.best && !open.has(turn.id)) w.best.add(sender);
      }
      // Ended once its last line ends it. A line still being read can change,
      // so it ends nothing yet, and a line after the end takes the end back.
      const ending =
        !open.has(turn.id) &&
        (said.ends ||
          (w.parties.length >= 2 && w.parties.every((p) => w.best.has(p))) ||
          (said.thanks && !!w.kind && RUN_KINDS.has(w.kind) && w.parties.length >= 2 && sender === w.runner));
      w.ended = ending;
      w.end = turn.end;
      w.last = sender;
      lines.set(turn.id, { turn, sender, mine: !!myCall && sender === myCall, qso: w.id });
    }
    if (q) done.push(q);
  }

  const built = done
    .filter((q) => q.parties.length > 0)
    .map((q) => {
      const changes = fixes.fields[q.id] ?? {};
      const kind = q.kind ?? kindFromFields([...q.fields.values()]);
      return {
        id: q.id,
        chan: q.chan,
        hz: q.hz,
        at: q.at,
        end: q.end,
        kind,
        ended: q.ended,
        stations: q.parties.map((call) => ({
          call,
          confirmed: fixes.confirmed?.[call] !== undefined,
          fields: { ...(q.fields.get(call) ?? {}), ...(changes[call] ?? {}) },
          mine: !!myCall && call === myCall,
          wpm: Math.round(mean(q.wpm, call)) || 0,
        })),
      };
    })
    .sort((a, b) => a.at - b.at);

  // The radio stays on a frequency until you note the next.
  let freq: string | null = null;
  const qsos: Qso[] = built.map((q) => {
    const noted = fixes.freq?.[q.id];
    if (noted !== undefined) freq = noted || null;
    return { ...q, freq };
  });

  return {
    lines: sorted.map((t) => lines.get(t.id) ?? { turn: t, sender: null, mine: false, qso: null }),
    qsos,
  };
}
