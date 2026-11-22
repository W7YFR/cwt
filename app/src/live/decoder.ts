/* Live decoding of whatever comes in.
 *
 * Audio goes in as it is captured. Each pass, the decoder:
 *
 *   1. looks at the band for keyed signals (spectrum.ts), and opens a channel
 *      on each new one. A channel starts a few seconds back, from audio kept
 *      for that, so the first characters that made the signal stand out are
 *      read too;
 *   2. turns each channel into key-down and key-up runs (channel.ts);
 *   3. splits each channel's runs into turns (turns.ts) and reads each turn
 *      at its own speed once it has enough marks, or at the channel's recent
 *      speed before that (adapt.ts).
 *
 * A turn is final a few seconds after the next one has started, or once the
 * signal has been quiet a while. Until then it is open: read again each pass,
 * so its text can still change as the speed settles.
 *
 * Pure: the worker in ui/ owns the thread, and tests run this under Node.
 */

import type { Calibration } from "@/dsp";
import { Detector, type Run } from "./channel";
import { bothKinds, paceOf, type Pace, PACE_MARKS } from "./adapt";
import { Spectrum } from "./spectrum";
import { isCall, readTurn, splitTurns, type TurnRead, type Words } from "./turns";

/** The rate the decoder works at, or the nearest above it that the capture
 *  rate divides down to. */
export const DECODE_RATE = 8000;
/** Seconds of audio kept, so a new channel can start before its signal was
 *  found. */
const BACKFILL_SEC = 4;
/** A candidate this close to a channel is that channel's signal, Hz. */
const MATCH_HZ = 45;
/** Marks a channel keys, not as an echo, before its turns are shown. */
const TRUST_MARKS = 8;
/** A candidate needs this much signal over the floor to open a channel, dB. */
const OPEN_SNR_DB = 12;
/** Passes in a row a new signal must be heard before a channel opens. */
const OPEN_PASSES = 2;
/** The most channels at once. */
const MAX_CHANNELS = 8;
/** A signal left out with every channel taken is noted at most this often,
 *  seconds. */
const FULL_NOTE_SEC = 10;
/** A channel with no marks for this long closes, seconds. */
const RETIRE_SEC = 90;
/** A channel not yet trusted keeps this many seconds of runs, and closes
 *  after this long quiet: one that never keys like a station does not hold
 *  a channel another signal needs. */
const UNTRUSTED_KEEP_SEC = 20;
const UNTRUSTED_RETIRE_SEC = 15;
/** A channel not trusted this long after it opened closes, quiet or not:
 *  a station keys enough to be trusted within seconds. */
const UNTRUSTED_LIFE_SEC = 30;
/** A pitch whose channel closed quiet does not open again for this long,
 *  seconds: noise there would open and close it every pass. */
const REOPEN_SEC = 5;
/** A turn is final once the next turn has gone on this long after it,
 *  seconds. */
const SETTLE_SEC = 3;
/** The last turn is final once its signal has been quiet this long, seconds,
 *  or this many dits. */
const QUIET_SEC = 2.5;
const QUIET_UNITS = 20;

/** The seconds of marks compared to tell an echo channel. */
const ECHO_SEC = 8;
/** The seconds of marks each channel keeps, for telling an echo turn. */
const KEEP_MARKS_SEC = 60;
/** A turn is an echo only of a channel this much stronger, dB. */
const ECHO_TURN_DB = 10;
/** Words of a turn still being read are held once they end this long before
 *  its latest mark, seconds... */
const HOLD_AFTER_SEC = 3;
/** ...but for this many at its end, which are read again... */
const HOLD_LAST_WORDS = 4;
/** ...and only once the turn has this many marks, so its pace is settled. */
const HOLD_MIN_MARKS = 30;
/** ...and the turn's dit is within this share of the station's. */
const HOLD_PACE_SHARE = 0.25;
/** ...or when this share of its keying time is that channel's keying too,
 *  over at least this many marks: spill that starts or ends a little off
 *  the strong signal's marks. */
const ECHO_TURN_OVERLAP = 0.7;
const ECHO_TURN_MARKS = 4;
/** A turn this much weaker than a channel is its echo when this share of its
 *  keying time is that channel's: spill far under a strong signal. */
const ECHO_FAR_DB = 30;
const ECHO_FAR_OVERLAP = 0.5;

/** The marks of `marks` from `since` on. */
function lately(marks: readonly Run[], since: number): Run[] {
  let i = marks.length;
  while (i > 0 && marks[i - 1]!.t >= since) i--;
  return marks.slice(i);
}

/** A channel is an echo of another when this many of its marks, or more,
 *  fall inside the other's. */
const ECHO_SHARE = 0.8;

/** How far past each of `b`'s marks one of `a`'s may reach and still be
 *  inside it, seconds: a click at an edge spills a little. */
const ECHO_SLACK = 0.02;

/** Whether `a`'s marks fall inside `b`'s marks: the same keying, heard
 *  again off its pitch. */
function echoes(a: readonly Run[], b: readonly Run[], least = 6): boolean {
  if (a.length < least || a.length === 0) return false;
  let inside = 0;
  let j = 0;
  for (const m of a) {
    while (j < b.length && b[j]!.t + b[j]!.dur + ECHO_SLACK < m.t) j++;
    const o = b[j];
    if (o && o.t - ECHO_SLACK <= m.t && m.t + m.dur <= o.t + o.dur + ECHO_SLACK) inside++;
  }
  return inside / a.length >= ECHO_SHARE;
}

/** The share of the keying time of marks `a` that marks `b` key too. */
function overlapShare(a: readonly Run[], b: readonly Run[]): number {
  let total = 0;
  let shared = 0;
  let j = 0;
  for (const m of a) {
    total += m.dur;
    while (j < b.length && b[j]!.t + b[j]!.dur < m.t) j++;
    for (let k = j; k < b.length && b[k]!.t < m.t + m.dur; k++) {
      const o = b[k]!;
      shared += Math.max(0, Math.min(m.t + m.dur, o.t + o.dur) - Math.max(m.t, o.t));
    }
  }
  return total > 0 ? shared / total : 0;
}

/** A turn of one short character alone, or one character not read, is a
 *  burst of noise, not keying. */
const LONE_NOISE = /^[ETI▯]$/;
/** Letters of one or two elements: what noise decodes as. */
const SHORT_LETTERS = /[ETIMNA]/g;
/** Faster than this is noise read as keying, WPM: on the air, people seldom
 *  send it. */
const MAX_WPM = 45;
/** A turn of nothing but short letters is noise, as is one this long or
 *  longer of nearly all short letters, at any speed: words have longer
 *  letters in them. A lone E E goes with it. */
const ONLY_SHORT = /^[ETIMNA ]+$/;
const NOISE_LETTERS = 8;
const NOISE_SHARE = 0.75;

/** Whether a turn is noise read as keying. */
function noise(t: Turn): boolean {
  if (LONE_NOISE.test(t.text)) return true;
  if (t.wpm > MAX_WPM) return true;
  if (ONLY_SHORT.test(t.text)) return true;
  const letters = t.text.replace(/ /g, "");
  const short = letters.match(SHORT_LETTERS)?.length ?? 0;
  return letters.length >= NOISE_LETTERS && short / letters.length >= NOISE_SHARE;
}

/** The fastest dit a trusted channel keys, seconds: `MAX_WPM`. Noise reads
 *  as marks at the shortest the measure allows, 20 ms. */
const TRUST_UNIT = 1.2 / MAX_WPM;

/** Whether a channel's marks look like keying: dits and dahs both, at a
 *  speed a person sends. */
function looksKeyed(c: Channel): boolean {
  return !!c.pace && c.pace.wpm <= 1.2 / TRUST_UNIT && bothKinds(c.recent.slice(-16).map((m) => m.dur));
}

/** One station's turn on one signal. */
export interface Turn {
  /** Stable while the turn is open, and after. */
  readonly id: string;
  /** The channel: one signal. */
  readonly ch: number;
  readonly hz: number;
  /** First mark's start and last mark's end, seconds from the stream's
   *  start. */
  readonly t0: number;
  readonly t1: number;
  readonly text: string;
  /** The elements of a character still being keyed, or null. */
  readonly keying: string | null;
  /** Character speed, WPM, or 0 when not yet measured. */
  readonly wpm: number;
  /** Mean mark level, dB. */
  readonly db: number;
}

/** A signal being followed. */
export interface Signal {
  readonly ch: number;
  readonly hz: number;
  /** The key is down now. */
  readonly keyed: boolean;
  /** Its latest speed, WPM, or 0. */
  readonly wpm: number;
  /** Seconds since its last mark. */
  readonly quietSec: number;
}

export interface Band {
  readonly fromHz: number;
  readonly toHz: number;
  /** Each bin's level over its floor lately, dB, from `fromHz` to `toHz`. */
  readonly db: Float32Array;
}

export interface LiveStep {
  /** Turns that became final this pass, oldest first. */
  readonly final: Turn[];
  /** Every open turn, on every channel. */
  readonly open: Turn[];
  readonly signals: Signal[];
  readonly band: Band;
  /** Seconds of audio decoded. */
  readonly now: number;
  /** What the decoder did this pass, for the debug transcript. */
  readonly notes: string[];
}

/** One signal: its detector, the runs not yet in a final turn, and its
 *  recent timing. */
interface Channel {
  readonly id: number;
  readonly det: Detector;
  runs: Run[];
  /** Runs that start before this belong to final turns. */
  cut: number;
  marks: number[];
  gaps: number[];
  /** Its marks of the last few seconds, for telling an echo. */
  recent: Run[];
  pace: Pace | null;
  /** Speed of its latest turn, WPM. */
  wpm: number;
  /** It has keyed enough to be told from an echo, and is not one. Until
   *  then its turns are not shown. */
  trusted: boolean;
  /** When it opened, seconds. */
  born: number;
  /** The words of its turn still being read that are held, so they stop
   *  changing: see `steady`. */
  held: Held | null;
}

/** The start of a turn still being read, kept as read. */
interface Held {
  /** The turn's start, seconds. */
  readonly t0: number;
  readonly text: string;
  /** Runs from this time on are read again each pass, seconds. */
  readonly upTo: number;
  /** The pace they were read at, for reading the rest when the turn's own
   *  is thrown off. */
  readonly pace: Pace;
}

/** Audio in capture-sized pieces, out at the decode rate in the same
 *  pieces. Each output sample is the mean of `factor` input samples. */
export class Decimator {
  readonly factor: number;
  readonly rate: number;
  private sum = 0;
  private count = 0;

  constructor(inputRate: number) {
    this.factor = Math.max(1, Math.floor(inputRate / DECODE_RATE));
    this.rate = inputRate / this.factor;
  }

  push(samples: Float32Array): Float32Array {
    const out = new Float32Array(Math.floor((this.count + samples.length) / this.factor));
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i]!;
      if (++this.count < this.factor) continue;
      out[n++] = this.sum / this.factor;
      this.sum = 0;
      this.count = 0;
    }
    return out.subarray(0, n);
  }
}

export class LiveDecoder {
  private readonly dec: Decimator;
  readonly rate: number;
  private readonly spectrum: Spectrum;
  private readonly calibration: Calibration | undefined;
  private channels: Channel[] = [];
  /** Signals not yet followed, and how many passes in a row they were
   *  heard. */
  private seen: { hz: number; passes: number }[] = [];
  /** Pitches whose channels closed quiet, and when, seconds. */
  private shut: { hz: number; at: number }[] = [];
  /** Final turns of channels closed since the last pass. */
  private handover: Turn[] = [];
  private nextId = 1;
  /** The latest audio at the decode rate, and how many samples came before
   *  its first. */
  private ring: Float32Array;
  private ringLen = 0;
  private total = 0;
  /** The words turns are read by meaning with. Calls read in final turns
   *  join it once they are read twice. */
  private readonly known: Set<string>;
  /** How many times each call was read in final turns. */
  private readonly heard = new Map<string, number>();
  /** Calls read once in final turns. */
  private readonly once = new Set<string>();
  /** What the decoder did since the last pass, for the debug transcript. */
  private notes: string[] = [];
  /** When a signal was last left out because every channel was taken, s. */
  private fullAt = -Infinity;

  /** With `calibration`, marks are corrected for the microphone path, as a
   *  take is. With `words`, gaps near the word cut are read by meaning. */
  constructor(inputRate: number, calibration?: Calibration | null, words: readonly string[] = []) {
    this.dec = new Decimator(inputRate);
    this.rate = this.dec.rate;
    this.spectrum = new Spectrum(this.rate);
    this.calibration = calibration ?? undefined;
    this.ring = new Float32Array(Math.ceil(BACKFILL_SEC * this.rate));
    this.known = new Set(words);
  }

  /** The pitches to decode, Hz, or null for the whole band. */
  private range: readonly [number, number] | null = null;

  /** Decode only signals from `lo` to `hi` Hz, or the whole band with null.
   *  A channel outside the range closes. */
  setRange(range: readonly [number, number] | null): void {
    this.range = range;
  }

  /** Whether `hz` is a pitch to decode. */
  private inRange(hz: number): boolean {
    return !this.range || (hz >= this.range[0] && hz <= this.range[1]);
  }

  /** Add `words` to the words read by meaning: calls you confirm. */
  learn(words: readonly string[]): void {
    for (const w of words) this.known.add(w);
  }

  /** The words to read by meaning, or none: with no words given, the timing
   *  alone reads the words. */
  private byMeaning(): Words | undefined {
    return this.known.size ? { known: this.known, heard: this.once } : undefined;
  }

  /** The notes since the last pass. */
  private takeNotes(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  /** Note what the decoder did, at the time in the audio. */
  private note(what: string): void {
    this.notes.push(`${this.now.toFixed(1)}s ${what}`);
  }

  /** Calls read in `turns` count towards the words read by meaning. */
  private hear(turns: readonly Turn[]): void {
    for (const t of turns) {
      for (const w of t.text.split(" ")) {
        if (!isCall(w)) continue;
        const n = (this.heard.get(w) ?? 0) + 1;
        this.heard.set(w, n);
        if (n >= 2 && this.known.size) {
          this.known.add(w);
          this.once.delete(w);
        } else if (n === 1) this.once.add(w);
      }
    }
  }

  push(samples: Float32Array): void {
    const x = this.dec.push(samples);
    if (x.length === 0) return;
    this.spectrum.push(x);
    for (const c of this.channels) c.det.push(x);
    // Keep the latest seconds.
    const cap = this.ring.length;
    if (x.length >= cap) {
      this.ring.set(x.subarray(x.length - cap));
      this.ringLen = cap;
    } else {
      const keep = Math.min(this.ringLen, cap - x.length);
      this.ring.copyWithin(0, this.ringLen - keep, this.ringLen);
      this.ring.set(x, keep);
      this.ringLen = keep + x.length;
    }
    this.total += x.length;
  }

  /** Seconds of audio decoded. */
  get now(): number {
    return this.total / this.rate;
  }

  step(): LiveStep {
    this.follow();
    const final: Turn[] = this.handover;
    this.handover = [];
    const open: Turn[] = [];
    const now = this.now;
    // Every channel's newest marks first, so an echo is judged against the
    // whole of the stronger signal.
    for (const c of this.channels) this.takeRuns(c, c.det.take());
    for (const c of this.channels) {
      if (!c.trusted) {
        const since = now - UNTRUSTED_KEEP_SEC;
        if (c.runs.length && c.runs[0]!.t < since) {
          const from = c.runs.findIndex((r) => r.on && r.t >= since);
          c.runs = from < 0 ? [] : c.runs.slice(from);
        }
        continue;
      }
      const view = this.view(c, c.det.peek());
      if (view.length === 0) continue;
      const turns = splitTurns(view, c.pace, this.byMeaning());
      const quiet = now - c.det.lastMarkEnd;
      const unit = c.pace?.unit ?? 0.06;
      const idle = !c.det.keyed && quiet >= Math.max(QUIET_SEC, QUIET_UNITS * unit);
      let settled = 0;
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]!;
        const next = turns[i + 1];
        const done = next ? now - t.t1 >= SETTLE_SEC && next.t0 > t.t1 : idle;
        if (!done || settled < i) break;
        settled = i + 1;
      }
      for (let i = 0; i < turns.length; i++) {
        turns[i] = this.steady(c, turns[i]!, i < settled);
        const t = this.turn(c, turns[i]!);
        if (noise(t)) {
          if (i < settled) this.note(`drop ch${c.id} as noise: ${t.text}`);
          continue;
        }
        // A turn still being read is checked too, so an echo never shows
        // beside its signal before it goes.
        if (this.echoTurn(c, turns[i]!)) {
          if (i < settled) this.note(`drop ch${c.id} as an echo: ${t.text}`);
          continue;
        }
        if (i < settled) final.push({ ...t, keying: null });
        // Far under another station, a turn shows only once it is final and
        // has been judged whole: spill there flickers in and out.
        else if (!this.channels.some((o) => o !== c && o.det.peakDb >= t.db + ECHO_FAR_DB)) open.push(t);
      }
      if (settled > 0) {
        const last = turns[settled - 1]!;
        const next = turns[settled];
        c.cut = next ? next.t0 : last.t1 + 1e-6;
        c.runs = c.runs.filter((r) => r.t >= c.cut);
        c.wpm = last.pace?.wpm ?? c.wpm;
      }
      if (open.length && open[open.length - 1]!.ch === c.id && open[open.length - 1]!.wpm) {
        c.wpm = open[open.length - 1]!.wpm;
      }
    }
    // Quiet channels close, once nothing of theirs is open.
    this.channels = this.channels.filter((c) => {
      const quiet = now - c.det.lastMarkEnd;
      const keep = c.trusted
        ? c.runs.some((r) => r.on) || quiet < RETIRE_SEC || c.det.keyed
        : (quiet < UNTRUSTED_RETIRE_SEC || c.det.keyed) && now - c.born < UNTRUSTED_LIFE_SEC;
      if (!keep) {
        this.note(`close ch${c.id} ${Math.round(c.det.hz)} Hz: ${c.trusted || now - c.born < UNTRUSTED_LIFE_SEC ? "quiet" : "never keyed like a station"}`);
        this.shut.push({ hz: c.det.hz, at: now });
      }
      return keep;
    });
    this.shut = this.shut.filter((p) => now - p.at < REOPEN_SEC);
    final.sort((a, b) => a.t0 - b.t0);
    open.sort((a, b) => a.t0 - b.t0);
    this.hear(final);
    return {
      final,
      open,
      signals: this.channels.filter((c) => c.trusted).map((c) => ({
        ch: c.id,
        hz: c.det.hz,
        keyed: c.det.keyed,
        wpm: Math.round(c.wpm),
        quietSec: Number.isFinite(c.det.lastMarkEnd) ? now - c.det.lastMarkEnd : Infinity,
      })),
      band: this.spectrum.view(),
      now,
      notes: this.takeNotes(),
    };
  }

  /** Every turn not yet final, read to the end of the audio. For when
   *  listening stops. */
  flush(): Turn[] {
    const out: Turn[] = this.handover;
    this.handover = [];
    for (const c of this.channels) {
      if (c.trusted) out.push(...this.close(c));
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  /** `t` as shown: the words of `c`'s turn still being read, once they are
   *  well behind the keying, are held as they were read, and only the rest is
   *  read again. Without that, each pass reads the whole turn again, and a
   *  long turn's words keep moving as its pace settles. A turn that is `done`
   *  keeps what was shown, and lets go of it. */
  private steady(c: Channel, t: TurnRead, done: boolean): TurnRead {
    const held = c.held && Math.abs(c.held.t0 - t.t0) < 1e-6 ? c.held : null;
    // A turn still being read is measured with its mark in progress, half
    // keyed, and a pace far off the station's is that, for a pass: it reads
    // at the station's pace, from its finished marks, until it settles.
    const off = !t.pace || !c.pace || Math.abs(t.pace.unit / c.pace.unit - 1) > HOLD_PACE_SHARE;
    if (!done && !held && off && c.pace) t = readTurn(t.runs, c.pace, this.byMeaning(), c.pace);
    let tail = t;
    let shown = t.pace;
    if (held) {
      const from = t.runs.findIndex((r) => r.on && r.t >= held.upTo);
      // The calls already read in the turn are known to the rest of it.
      const words = this.byMeaning();
      const more = words && { ...words, known: new Set([...words.known, ...held.text.split(" ").filter(isCall)]) };
      // The turn's pace as it settles, but for a pass it is thrown far off.
      const steadyPace = t.pace && Math.abs(t.pace.unit / held.pace.unit - 1) <= HOLD_PACE_SHARE ? t.pace : held.pace;
      shown = steadyPace;
      tail = from < 0 ? { ...t, text: "", words: [] } : readTurn(t.runs.slice(from), steadyPace, more, steadyPace);
    }
    const text = held ? [held.text, tail.text].filter(Boolean).join(" ") : t.text;
    c.held = done ? null : held;
    // Only a reading at the station's own pace is held: a pace thrown off by
    // noise reads nonsense that the next pass may put right.
    const sure = !off;
    const pace = held?.pace ?? t.pace;
    if (!done && sure && t.runs.filter((r) => r.on).length >= HOLD_MIN_MARKS) {
      // Hold the words well behind the latest mark, but for the last few.
      const words = tail.words;
      let k = 0;
      while (k < words.length - HOLD_LAST_WORDS && words[k]!.t1 < t.t1 - HOLD_AFTER_SEC) k++;
      if (k > 0) {
        const add = words
          .slice(0, k)
          .map((w) => w.text)
          .join(" ");
        c.held = { t0: t.t0, text: held ? `${held.text} ${add}` : add, upTo: words[k]!.t0 - 1e-6, pace: pace! };
      }
    }
    return { ...t, text, keying: tail.keying, pace: shown };
  }

  /** Whether a turn on `c` is another channel's keying heard off its pitch:
   *  its marks fall inside a much stronger channel's marks. */
  private echoTurn(c: Channel, t: TurnRead): boolean {
    const marks = t.runs.filter((r) => r.on);
    return this.channels.some(
      (o) =>
        o !== c &&
        o.det.peakDb >= t.db + ECHO_TURN_DB &&
        (echoes(marks, o.recent, 1) ||
          (marks.length >= ECHO_TURN_MARKS &&
            overlapShare(marks, o.recent) >= (o.det.peakDb >= t.db + ECHO_FAR_DB ? ECHO_FAR_OVERLAP : ECHO_TURN_OVERLAP))),
    );
  }

  /** Every turn `c` still holds, as final. With `echoes`, turns that echo a
   *  stronger channel are left out. */
  private close(c: Channel, echoes = false): Turn[] {
    this.takeRuns(c, c.det.rest());
    const view = this.view(c, []);
    c.runs = [];
    c.cut = this.now;
    if (view.length === 0) return [];
    const far: Run = { on: false, t: this.now, dur: 10, db: 0 };
    return splitTurns([...view, far], c.pace, this.byMeaning())
      .map((t) => this.steady(c, t, true))
      .filter((t) => {
        if (!echoes || !this.echoTurn(c, t)) return true;
        this.note(`drop ch${c.id} as an echo: ${t.text}`);
        return false;
      })
      .map((t) => ({ ...this.turn(c, t), keying: null }))
      .filter((t) => !noise(t));
  }

  /** Open a channel on each new signal. A channel whose marks fall inside a
   *  stronger channel's marks is an echo of it: a harmonic, or the edge of a
   *  strong signal. It closes. */
  private follow(): void {
    const heard: { hz: number; passes: number }[] = [];
    const echo = (c: Channel) =>
      this.channels.some(
        (o) =>
          o !== c &&
          o.det.peakDb > c.det.peakDb &&
          echoes(lately(c.recent, this.now - ECHO_SEC), o.recent),
      );
    this.channels = this.channels.filter((c) => {
      if (!this.inRange(c.det.hz)) {
        this.note(`close ch${c.id} ${Math.round(c.det.hz)} Hz: out of the range`);
        return false;
      }
      if (!echo(c)) {
        if (!c.trusted && c.recent.length >= TRUST_MARKS && looksKeyed(c)) {
          c.trusted = true;
          this.note(`trust ch${c.id} ${Math.round(c.det.hz)} Hz`);
        }
        return true;
      }
      this.note(`close ch${c.id} ${Math.round(c.det.hz)} Hz: an echo${c.trusted ? ", shown" : ""}`);
      this.shut.push({ hz: c.det.hz, at: this.now });
      // A channel whose turns were shown gives up what it still holds, but
      // for turns that echo a stronger channel.
      if (c.trusted) this.handover.push(...this.close(c, true));
      return false;
    });
    for (const found of this.spectrum.candidates()) {
      // Walk to the middle: from the edge of a signal, its middle may be
      // past the first look's reach.
      let hz = found.hz;
      for (let step = 0; step < 3; step++) {
        const next = this.spectrum.centerNear(hz);
        if (Math.abs(next - hz) < 1) break;
        hz = next;
      }
      const cand = { ...found, hz };
      if (!this.inRange(cand.hz)) continue;
      const near = this.channels.find((c) => Math.abs(c.det.hz - cand.hz) < MATCH_HZ);
      if (near) continue;
      if (this.shut.some((p) => Math.abs(p.hz - cand.hz) < MATCH_HZ)) continue;
      if (cand.snrDb < OPEN_SNR_DB) continue;
      // A channel already on this keying, and as strong, has it.
      const echo = (c: Channel) =>
        this.spectrum.snrAt(c.det.hz) >= cand.snrDb - 3 && this.spectrum.keyTogether(c.det.hz, cand.hz);
      if (this.channels.some(echo)) continue;
      // Seen once is not enough: at a signal's first character its edges
      // can stand out before its middle does.
      const seen = this.seen.find((p) => Math.abs(p.hz - cand.hz) < MATCH_HZ);
      if (!seen) {
        heard.push({ hz: cand.hz, passes: 1 });
        continue;
      }
      heard.push({ hz: cand.hz, passes: seen.passes + 1 });
      if (seen.passes + 1 < OPEN_PASSES) continue;
      if (this.channels.length >= MAX_CHANNELS) {
        // A channel not trusted, and weaker than the new signal, makes room.
        const weakest = this.channels
          .filter((c) => !c.trusted && this.spectrum.snrAt(c.det.hz) < cand.snrDb)
          .sort((x, y) => this.spectrum.snrAt(x.det.hz) - this.spectrum.snrAt(y.det.hz))[0];
        if (weakest) {
          this.note(`close ch${weakest.id} ${Math.round(weakest.det.hz)} Hz: room for ${Math.round(cand.hz)} Hz`);
          this.channels = this.channels.filter((c) => c !== weakest);
        } else {
          if (this.now - this.fullAt > FULL_NOTE_SEC) {
            this.fullAt = this.now;
            this.note(`full: ${Math.round(cand.hz)} Hz left out, channels ${this.channels.map((c) => Math.round(c.det.hz)).join(" ")}`);
          }
          continue;
        }
      }
      // Read the kept audio twice: once to learn the signal's levels, so
      // that nothing quieter is read as its keying, then for its runs.
      const start = this.total - this.ringLen;
      const kept = this.ring.subarray(0, this.ringLen);
      const learn = new Detector(this.rate, cand.hz, start);
      learn.push(kept);
      const det = new Detector(this.rate, cand.hz, start, learn.levels);
      det.push(kept);
      this.note(`open ch${this.nextId} ${Math.round(cand.hz)} Hz, ${Math.round(cand.snrDb)} dB over the noise`);
      this.channels.push({ id: this.nextId++, det, runs: [], cut: -Infinity, marks: [], gaps: [], recent: [], pace: null, wpm: 0, trusted: false, born: this.now, held: null });
    }
    this.seen = heard;
  }

  /** Add finished runs to the channel, corrected and measured. */
  private takeRuns(c: Channel, runs: readonly Run[]): void {
    for (const raw of runs) {
      const r = this.corrected(raw);
      if (r.t < c.cut) continue;
      // A channel's runs start with a mark.
      if (!r.on && !c.runs.length) continue;
      if (r.on) {
        c.marks.push(r.dur);
        c.recent.push(r);
      }
      else if (r.dur < 1) c.gaps.push(r.dur);
      c.runs.push(r);
    }
    if (c.marks.length > PACE_MARKS) c.marks = c.marks.slice(-PACE_MARKS);
    const since = this.now - KEEP_MARKS_SEC;
    if (c.recent.length && c.recent[0]!.t < since) c.recent = c.recent.filter((r) => r.t >= since);
    if (c.gaps.length > PACE_MARKS) c.gaps = c.gaps.slice(-PACE_MARKS);
    if (runs.length) c.pace = paceOf(c.marks, c.gaps, c.pace);
  }

  /** The channel's runs with `extra` after them, from its first mark. */
  private view(c: Channel, extra: readonly Run[]): Run[] {
    const out = [...c.runs];
    for (const raw of extra) {
      const r = this.corrected(raw);
      if (r.t < c.cut) continue;
      if (!r.on && !out.length) continue;
      out.push(r);
    }
    return out;
  }

  private corrected(r: Run): Run {
    const off = this.calibration?.releaseOffsetSec ?? 0;
    if (!off) return r;
    return r.on
      ? { ...r, dur: Math.max(0.005, r.dur - off) }
      : { ...r, t: r.t - off, dur: r.dur + off };
  }

  private turn(c: Channel, t: TurnRead): Turn {
    return {
      id: `${c.id}-${Math.round(t.t0 * 1000)}`,
      ch: c.id,
      hz: Math.round(c.det.hz),
      t0: t.t0,
      t1: t.t1,
      text: t.text,
      keying: t.keying,
      wpm: t.pace ? Math.round(t.pace.wpm) : 0,
      db: t.db,
    };
  }
}
