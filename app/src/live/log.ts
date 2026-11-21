/* The transcript and the QSOs in it, built from the turns.
 *
 * Everything here is worked out again from the turns and your fixes each time
 * either changes, so a fix to one line flows into every card it touches. Only
 * the turns and the fixes are kept.
 *
 * Who sent a turn, best effort, in this order:
 *
 *   1. your fix;
 *   2. the call after DE;
 *   3. the call a CQ ends with;
 *   4. a call sent on its own: a station calling;
 *   5. TU and a call: the call is the one signing, when it called CQ;
 *   6. a call at the start, of a station in the QSO: the other station sent
 *      it;
 *   7. the station whose strength and speed match;
 *   8. the station who did not send the turn before.
 *
 * Pure.
 */

import { kindFromFields, readSaid, type Fields, type QsoKind } from "./parse";

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
}

export const NO_FIXES: Fixes = { sender: {}, fields: {} };

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

/** Build the log from `turns`, in any order, and `fixes`. `myCall` marks
 *  your own turns. */
export function buildLog(turns: readonly LiveTurn[], fixes: Fixes = NO_FIXES, myCall = ""): Log {
  const sorted = [...turns].sort((a, b) => a.at - b.at);
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
      const said = readSaid(turn.text, q?.kind ?? null);
      if (q && turn.at - q.end > QSO_GAP_MS) {
        done.push(q);
        q = null;
      }
      const fixed = fixes.sender[turn.id];
      const caller = said.de ?? (said.cq !== null || said.callsOnly ? said.calls[said.calls.length - 1] : undefined) ?? fixed;
      const addressed = said.to ?? (said.words[0] && said.calls[0] === said.words[0] ? said.calls[0] : undefined);

      // Does this turn start a new QSO?
      let fresh = !q;
      let runner: string | null = null;
      if (q) {
        const cqBy = said.cq !== null ? said.calls[said.calls.length - 1] : undefined;
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
        q = start(turn, runner);
        q.kind = kind;
      }
      const w = q!;

      // Who sent it.
      let sender: string | null = fixed ?? null;
      if (!sender) {
        if (said.de) sender = said.de;
        else if (said.cq !== null) sender = said.calls[said.calls.length - 1] ?? null;
        else if (said.callsOnly) sender = said.calls[said.calls.length - 1] ?? null;
        else if (said.thanks && said.calls.length) {
          const signed = said.calls[said.calls.length - 1]!;
          sender = signed === w.runner ? signed : other(w, signed);
        }
        if (!sender && addressed) {
          if (w.parties.includes(addressed)) sender = other(w, addressed);
          else if (w.runner && addressed !== w.runner) sender = w.runner;
        }
        if (!sender) sender = matching(w, turn);
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
        if (said.best) w.best.add(sender);
      }
      if (said.ends) w.ended = true;
      if (w.parties.length >= 2 && w.parties.every((p) => w.best.has(p))) w.ended = true;
      if (said.thanks && w.kind && RUN_KINDS.has(w.kind) && w.parties.length >= 2 && sender === w.runner) w.ended = true;
      w.end = turn.end;
      w.last = sender;
      lines.set(turn.id, { turn, sender, mine: !!myCall && sender === myCall, qso: w.id });
    }
    if (q) done.push(q);
  }

  const qsos: Qso[] = done
    .filter((q) => q.parties.length > 0)
    .map((q) => {
      const edits = fixes.fields[q.id] ?? {};
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
          fields: { ...(q.fields.get(call) ?? {}), ...(edits[call] ?? {}) },
          mine: !!myCall && call === myCall,
          wpm: Math.round(mean(q.wpm, call)) || 0,
        })),
      };
    })
    .sort((a, b) => a.at - b.at);

  return {
    lines: sorted.map((t) => lines.get(t.id) ?? { turn: t, sender: null, mine: false, qso: null }),
    qsos,
  };
}
