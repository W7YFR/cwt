/* A recording of somebody else's CW, read once, whole, for the Copy page.
 *
 * The page plays the recording and you copy it. What the decoder reads here is
 * the answer key, so it keeps the time of every character: a skip by word, a
 * line's play button and a selection that plays all need them.
 *
 * A QSO holds two stations, and each sends at its own pitch. Two pitches close
 * together pass the same filter, so one pass reads both. A pitch far from the
 * first is lost to that filter, so it gets a pass of its own. Each character's
 * pitch is then measured over its marks alone, and the pitches fall into one
 * group per station.
 *
 * Pure, like the rest of the analysis: a worker in ui/ runs it off the page's
 * thread, and a test runs it under Node.
 */

import { TONE_MAX_HZ, TONE_MIN_HZ, decimate, detectTone, goertzelPower, segmentsFrom, tonePresence } from "@/dsp";
import { decodeSegments } from "@/timing";
import type { Char } from "@/types";

/** The rate the recording is read at. The tone is near 600 Hz, so nothing
 *  the decoder needs is lost, and a ten-minute file reads in a second or two. */
export const READ_RATE = 8000;

/** A second station this far from the first is outside the first pass's
 *  filter, and gets a pass of its own. Half the 200 Hz passband. */
const FAR_HZ = 100;

/** Only quiet this long, between the first pass's characters, is searched
 *  for a second station. */
const QUIET_MIN_SEC = 1;

/** The most quiet searched for a second station. Enough to find one. */
const QUIET_MAX_SEC = 60;

/** The steps of the search for a character's pitch: across the whole band,
 *  then close to the best. A station far from the first pass's tone still
 *  leaks into it when it is loud, and its pitch tells it apart. */
const PITCH_COARSE_HZ = 4;
const PITCH_FINE_HZ = 0.5;

/** Two pitches closer than this are one station. Two keyers at one setting
 *  read within a hertz or two of each other. */
const SAME_STATION_HZ = 8;

/** A group of pitches with fewer characters than this share of the whole is
 *  not a station. It joins the group nearest it. */
const MIN_STATION_SHARE = 0.02;

/** A pause at least this long starts a new line, even from the same station. */
const LINE_PAUSE_SEC = 1.5;

/** One character, where it is in the recording. */
export interface RecChar {
  /** "L", "<SK>", or UNKNOWN when the pattern matched nothing. */
  readonly char: string;
  readonly t0: number;
  readonly t1: number;
}

/** One word: characters with no word gap between them. */
export interface RecWord {
  readonly chars: readonly RecChar[];
}

/** One line of the page: an over, sent by one station. */
export interface Over {
  readonly sender: number;
  readonly words: readonly RecWord[];
  /** The words, with a space between each two. */
  readonly text: string;
  readonly t0: number;
  readonly t1: number;
}

/** One station heard in the recording. */
export interface Sender {
  readonly toneHz: number;
  /** Its call, from what it sent after DE. Null when it never said. */
  readonly call: string | null;
}

export interface Recording {
  readonly durationSec: number;
  /** In the order each is first heard. */
  readonly senders: readonly Sender[];
  readonly overs: readonly Over[];
}

/** A character as read, before it has a station. */
interface Read {
  readonly char: Char;
  readonly pass: number;
  readonly pitch: number;
  readonly power: number;
}

/** The pitch of `char`, measured over its marks, and the power there. */
function pitchOf(x: Float32Array, rate: number, char: Char): { pitch: number; power: number } {
  const marks = char.blocks.filter((b) => b.kind === "dit" || b.kind === "dah");
  const at = (f: number) => {
    let p = 0;
    for (const b of marks) p += goertzelPower(x, rate, f, Math.floor(b.t0 * rate), Math.ceil(b.t1 * rate));
    return p;
  };
  let best = TONE_MIN_HZ;
  let power = -1;
  for (let f = TONE_MIN_HZ; f <= Math.min(TONE_MAX_HZ, rate / 2 - 10); f += PITCH_COARSE_HZ) {
    const p = at(f);
    if (p > power) [best, power] = [f, p];
  }
  const coarse = best;
  for (let f = coarse - PITCH_COARSE_HZ; f <= coarse + PITCH_COARSE_HZ; f += PITCH_FINE_HZ) {
    const p = at(f);
    if (p > power) [best, power] = [f, p];
  }
  return { pitch: best, power };
}

/** The quiet between `chars`, joined, for the search for a second station. */
function quietOf(x: Float32Array, rate: number, chars: readonly Char[], durationSec: number): Float32Array {
  const spans: [number, number][] = [];
  let from = 0;
  for (const c of [...chars, { t0: durationSec, t1: durationSec } as Char]) {
    if (c.t0 - from >= QUIET_MIN_SEC) spans.push([from, c.t0]);
    from = Math.max(from, c.t1);
  }
  const max = Math.floor(QUIET_MAX_SEC * rate);
  const out = new Float32Array(Math.min(max, spans.reduce((n, [a, b]) => n + Math.floor((b - a) * rate), 0)));
  let k = 0;
  for (const [a, b] of spans) {
    if (k >= out.length) break;
    const part = x.subarray(Math.floor(a * rate), Math.floor(b * rate)).subarray(0, out.length - k);
    out.set(part, k);
    k += part.length;
  }
  return out.subarray(0, k);
}

/** Pitches in groups, one per station: sorted, and split wherever two
 *  neighbours are SAME_STATION_HZ or more apart. A group too small to be a
 *  station joins the nearest. Returns each pitch's group, and each group's
 *  middle pitch. */
export function groupPitches(pitches: readonly number[]): { group: number[]; centers: number[] } {
  if (pitches.length === 0) return { group: [], centers: [] };
  const order = pitches.map((_, i) => i).sort((a, b) => pitches[a]! - pitches[b]!);
  let groups: number[][] = [[order[0]!]];
  for (let k = 1; k < order.length; k++) {
    const i = order[k]!;
    const last = groups[groups.length - 1]!;
    if (pitches[i]! - pitches[last[last.length - 1]!]! >= SAME_STATION_HZ) groups.push([i]);
    else last.push(i);
  }
  const median = (g: number[]) => pitches[g[Math.floor(g.length / 2)]!]!;
  const min = Math.max(1, Math.ceil(pitches.length * MIN_STATION_SHARE));
  while (groups.length > 1) {
    const small = groups.findIndex((g) => g.length < min);
    if (small < 0) break;
    const c = median(groups[small]!);
    let near = -1;
    for (let j = 0; j < groups.length; j++) {
      if (j === small) continue;
      if (near < 0 || Math.abs(median(groups[j]!) - c) < Math.abs(median(groups[near]!) - c)) near = j;
    }
    groups[near] = [...groups[near]!, ...groups[small]!].sort((a, b) => pitches[a]! - pitches[b]!);
    groups = groups.filter((_, j) => j !== small);
  }
  const group = new Array<number>(pitches.length).fill(0);
  groups.forEach((g, j) => g.forEach((i) => (group[i] = j)));
  return { group, centers: groups.map(median) };
}

/** A call sign: letters and digits, with a digit and ending in a letter. */
const CALL_RE = /^(?=.*\d)[A-Z\d]{1,3}\d[A-Z\d]*[A-Z]$/;

/** Each station's call, from what the stations sent.
 *
 * The word after DE is the sender's own call, and counts most. With two
 * stations, the other's call is the word before DE, or a call that opens a
 * line: a POTA hunter may never send its own call after DE, and the
 * activator sends it back. A call is given to one station only. */
function callsOf(overs: readonly Over[], senders: number): (string | null)[] {
  const votes = Array.from({ length: senders }, () => new Map<string, number>());
  const vote = (s: number, call: string, n: number) => votes[s]!.set(call, (votes[s]!.get(call) ?? 0) + n);
  for (const o of overs) {
    const words = o.text.split(" ");
    const other = senders === 2 ? 1 - o.sender : null;
    words.forEach((w, i) => {
      if (!CALL_RE.test(w)) return;
      if (words[i - 1] === "DE") vote(o.sender, w, 3);
      else if (other !== null && (words[i + 1] === "DE" || i === 0)) vote(other, w, 1);
    });
  }
  const best = (s: number, not: string | null) => {
    let out: string | null = null;
    for (const [call, n] of votes[s]!) {
      if (call !== not && (out === null || n > votes[s]!.get(out)!)) out = call;
    }
    return out;
  };
  const calls: (string | null)[] = votes.map(() => null);
  // The station with the stronger claim chooses first.
  const order = votes
    .map((v, s) => ({ s, top: Math.max(0, ...v.values()) }))
    .sort((x, y) => y.top - x.top)
    .map((x) => x.s);
  for (const s of order) calls[s] = best(s, calls.find((c, t) => t !== s && c !== null) ?? null);
  return calls;
}

/** Each word's station: the one most of its characters have, since a
 *  station changes only between words. A word whole at another pitch is that
 *  station, however short: a hunter's NK, or the last EE. */
export function runsOf(words: readonly { senders: readonly number[] }[]): number[] {
  return words.map((w) => {
    const n = new Map<number, number>();
    for (const s of w.senders) n.set(s, (n.get(s) ?? 0) + 1);
    let best = w.senders[0]!;
    for (const [s, k] of n) if (k > n.get(best)!) best = s;
    return best;
  });
}

/** Read `samples`, a recording at `rate`, into overs. Null when it holds no
 *  keying. */
export function decodeRecording(samples: Float32Array, rate: number): Recording | null {
  const factor = Math.max(1, Math.floor(rate / READ_RATE));
  const r = rate / factor;
  const x = decimate(samples, factor);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  if (!(peak > 0)) return null;
  for (let i = 0; i < x.length; i++) x[i] = x[i]! / peak;
  const durationSec = x.length / r;

  // The first pass: the strongest tone, and any close to it.
  const first = segmentsFrom(x, r);
  if (first.segments.length === 0) return null;
  const passes = [{ toneHz: first.toneHz, chars: decodeSegments(first.segments).timeline.chars }];

  const pass = (toneHz: number) => {
    const chars = decodeSegments(segmentsFrom(x, r, { toneHz }).segments).timeline.chars;
    passes.push({ toneHz, chars });
  };
  const far = (toneHz: number) => passes.every((p) => Math.abs(p.toneHz - toneHz) > FAR_HZ);

  // A station far from the first, and quiet enough not to leak into its
  // pass, sends in that pass's quiet.
  const quiet = quietOf(x, r, passes[0]!.chars, durationSec);
  if (quiet.length > r && tonePresence(quiet, r).keyed) {
    const toneHz = detectTone(quiet, r);
    if (far(toneHz)) pass(toneHz);
  }

  // Every character with its pitch. A station far from every pass, heard
  // only as it leaked into one, gets a pass of its own.
  const measured = new Map<Char, { pitch: number; power: number }>();
  const readAll = (): Read[] =>
    passes
      .flatMap((p, i) =>
        p.chars.map((char) => {
          let m = measured.get(char);
          if (!m) measured.set(char, (m = pitchOf(x, r, char)));
          return { char, pass: i, ...m };
        }),
      )
      .sort((a, b) => a.char.t0 - b.char.t0);
  let reads = readAll();
  const extra = groupPitches(reads.map((c) => c.pitch)).centers.filter(far);
  if (extra.length) {
    for (const toneHz of extra) pass(toneHz);
    reads = readAll();
  }

  // Where two passes read the same sound, the pass nearest its pitch keeps
  // it.
  if (passes.length > 1) {
    const off = (c: Read) => Math.abs(c.pitch - passes[c.pass]!.toneHz);
    reads = reads.filter(
      (a) =>
        !reads.some(
          (b) =>
            b.pass !== a.pass &&
            b.char.t0 < a.char.t1 &&
            a.char.t0 < b.char.t1 &&
            (off(b) < off(a) || (off(b) === off(a) && b.power > a.power)),
        ),
    );
  }
  if (reads.length === 0) return null;

  const { group, centers } = groupPitches(reads.map((c) => c.pitch));
  // Stations numbered in the order each is first heard.
  const firstAt = centers.map((_, g) => group.indexOf(g));
  const order = centers.map((_, g) => g).sort((a, b) => firstAt[a]! - firstAt[b]!);
  const station = group.map((g) => order.indexOf(g));

  // Words: a word gap or a pause, or a change of pass, starts one.
  const words: { chars: RecChar[]; senders: number[]; pause: boolean }[] = [];
  reads.forEach((read, i) => {
    const prev = reads[i - 1];
    const gap = read.char.leadGap?.kind;
    const opens =
      !prev || prev.pass !== read.pass || gap === "word-gap" || gap === "pause" || read.char.t0 - prev.char.t1 >= LINE_PAUSE_SEC;
    if (opens) {
      words.push({
        chars: [],
        senders: [],
        pause: !!prev && read.char.t0 - prev.char.t1 >= LINE_PAUSE_SEC && gap === "pause",
      });
    }
    const w = words[words.length - 1]!;
    w.chars.push({ char: read.char.char, t0: read.char.t0, t1: read.char.t1 });
    w.senders.push(station[i]!);
  });

  // Overs: a change of station, or a long pause, starts one.
  const of = runsOf(words);
  const groups: { sender: number; words: RecWord[] }[] = [];
  words.forEach((w, i) => {
    const last = groups[groups.length - 1];
    if (!last || last.sender !== of[i] || w.pause) groups.push({ sender: of[i]!, words: [] });
    groups[groups.length - 1]!.words.push({ chars: w.chars });
  });
  const overs: Over[] = groups.map((g) => ({
    sender: g.sender,
    words: g.words,
    text: g.words.map((w) => w.chars.map((c) => c.char).join("")).join(" "),
    t0: g.words[0]!.chars[0]!.t0,
    t1: g.words[g.words.length - 1]!.chars.at(-1)!.t1,
  }));

  const calls = callsOf(overs, order.length);
  const senders = order.map((g, s) => ({ toneHz: centers[g]!, call: calls[s]! }));
  return { durationSec, senders, overs };
}
