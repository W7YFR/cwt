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
import { splitTurns, type TurnRead } from "./turns";

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
/** A channel with no marks for this long closes, seconds. */
const RETIRE_SEC = 90;
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

/** A turn of one short character alone is a burst of noise, not keying. */
const LONE_NOISE = /^[ETI]$/;
/** Letters of one or two elements: what noise decodes as. */
const SHORT_LETTERS = /[ETIMNA]/g;
/** A turn this fast or faster, nearly all short letters, is noise. */
const NOISE_WPM = 45;
const NOISE_SHARE = 0.75;

/** Whether a turn is noise read as keying. */
function noise(t: Turn): boolean {
  if (LONE_NOISE.test(t.text)) return true;
  const letters = t.text.replace(/ /g, "");
  const short = letters.match(SHORT_LETTERS)?.length ?? 0;
  return t.wpm >= NOISE_WPM && letters.length > 0 && short / letters.length >= NOISE_SHARE;
}

/** The fastest dit a trusted channel keys, seconds: just under 60 WPM.
 *  Noise reads as marks at the shortest the measure allows, 20 ms. */
const TRUST_UNIT = 0.021;

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
}

/** Audio in capture-sized pieces, out at the decode rate in the same
 *  pieces. Each output sample is the mean of `factor` input samples. */
class Decimator {
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
  /** Final turns of channels closed since the last pass. */
  private handover: Turn[] = [];
  private nextId = 1;
  /** The latest audio at the decode rate, and how many samples came before
   *  its first. */
  private ring: Float32Array;
  private ringLen = 0;
  private total = 0;

  /** With `calibration`, marks are corrected for the microphone path, as a
   *  take is. */
  constructor(inputRate: number, calibration?: Calibration | null) {
    this.dec = new Decimator(inputRate);
    this.rate = this.dec.rate;
    this.spectrum = new Spectrum(this.rate);
    this.calibration = calibration ?? undefined;
    this.ring = new Float32Array(Math.ceil(BACKFILL_SEC * this.rate));
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
    for (const c of this.channels) {
      this.takeRuns(c, c.det.take());
      if (!c.trusted) continue;
      const view = this.view(c, c.det.peek());
      if (view.length === 0) continue;
      const turns = splitTurns(view, c.pace);
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
        const t = this.turn(c, turns[i]!);
        if (noise(t)) continue;
        if (i < settled && this.echoTurn(c, turns[i]!)) continue;
        if (i < settled) final.push({ ...t, keying: null });
        else open.push(t);
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
    this.channels = this.channels.filter(
      (c) => c.runs.some((r) => r.on) || now - c.det.lastMarkEnd < RETIRE_SEC || c.det.keyed,
    );
    final.sort((a, b) => a.t0 - b.t0);
    open.sort((a, b) => a.t0 - b.t0);
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

  /** Whether a turn on `c` is another channel's keying heard off its pitch:
   *  its marks fall inside a much stronger channel's marks. */
  private echoTurn(c: Channel, t: TurnRead): boolean {
    const marks = t.runs.filter((r) => r.on);
    return this.channels.some((o) => o !== c && o.det.peakDb >= t.db + ECHO_TURN_DB && echoes(marks, o.recent, 1));
  }

  /** Every turn `c` still holds, as final. */
  private close(c: Channel): Turn[] {
    this.takeRuns(c, c.det.rest());
    const view = this.view(c, []);
    c.runs = [];
    c.cut = this.now;
    if (view.length === 0) return [];
    const far: Run = { on: false, t: this.now, dur: 10, db: 0 };
    return splitTurns([...view, far], c.pace)
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
      if (!echo(c)) {
        if (c.recent.length >= TRUST_MARKS && looksKeyed(c)) c.trusted = true;
        return true;
      }
      // A channel whose turns were shown gives up what it still holds.
      if (c.trusted) this.handover.push(...this.close(c));
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
      const near = this.channels.find((c) => Math.abs(c.det.hz - cand.hz) < MATCH_HZ);
      if (near) continue;
      if (cand.snrDb < OPEN_SNR_DB || this.channels.length >= MAX_CHANNELS) continue;
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
      // Read the kept audio twice: once to learn the signal's levels, so
      // that nothing quieter is read as its keying, then for its runs.
      const start = this.total - this.ringLen;
      const kept = this.ring.subarray(0, this.ringLen);
      const learn = new Detector(this.rate, cand.hz, start);
      learn.push(kept);
      const det = new Detector(this.rate, cand.hz, start, learn.levels);
      det.push(kept);
      this.channels.push({ id: this.nextId++, det, runs: [], cut: -Infinity, marks: [], gaps: [], recent: [], pace: null, wpm: 0, trusted: false });
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
