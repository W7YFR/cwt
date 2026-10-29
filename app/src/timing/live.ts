/* Following a take while it is being sent.
 *
 * The review decodes a take once, after it ends. This decodes the audio
 * captured so far, again and again while the take runs, with the same
 * pipeline: `segmentsFrom`, then `buildTimeline` at the target timing. So what
 * the live view counts as sent is what the review will read afterwards.
 *
 * Three things differ from the review, and each is about time:
 *
 *   - the audio is reduced to about 8 kHz first. The tone is near 600 Hz, so
 *     nothing the decoder sees is lost, and a pass costs a sixth of what it
 *     would at 48 kHz;
 *   - the target timing classifies from the first second. Measured timing
 *     needs a few characters of evidence and misreads the gaps until it has
 *     them;
 *   - the last character is not read until a character gap follows it.
 *     Before that it is still being keyed, and a half-sent Q reads as a G.
 *     It still counts as reached: the sender has moved on to it, and that is
 *     where they are.
 *
 * Pure, like the rest of timing/: the worker in ui/ owns the thread, and this
 * runs under Node against real recordings.
 */

import type { Char, Segment, Timing } from "@/types";
import { segmentsFrom, type Calibration } from "@/dsp";
import { CHAR_TO_MORSE, SYMBOL_RE, canonicalChar } from "@/morse";
import { estimateTiming } from "./estimate";
import { readWords } from "./segment";
import { buildTimeline, opensWord } from "./timeline";

/** The rate the live decode works at, or the nearest above it that the
 *  capture rate divides down to. */
export const LIVE_RATE = 8000;

/** How many capture samples make one live sample. */
export function decimationFactor(rate: number): number {
  return Math.max(1, Math.floor(rate / LIVE_RATE));
}

/** Audio in capture-sized pieces, out as one growing buffer at the live rate.
 *
 * Each output sample is the mean of `factor` input samples. That mean is a
 * low-pass whose first null is at the output rate, far above the tone, so the
 * keying envelope comes through unchanged. A piece that does not divide evenly
 * leaves its remainder for the next one. */
export class Decimator {
  readonly factor: number;
  readonly rate: number;
  private buf = new Float32Array(LIVE_RATE * 16);
  private length = 0;
  private sum = 0;
  private count = 0;

  constructor(inputRate: number) {
    this.factor = decimationFactor(inputRate);
    this.rate = inputRate / this.factor;
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i]!;
      if (++this.count < this.factor) continue;
      if (this.length === this.buf.length) {
        const grown = new Float32Array(this.buf.length * 2);
        grown.set(this.buf);
        this.buf = grown;
      }
      this.buf[this.length++] = this.sum / this.factor;
      this.sum = 0;
      this.count = 0;
    }
  }

  /** Everything so far. A view, not a copy: valid until the next push. */
  samples(): Float32Array {
    return this.buf.subarray(0, this.length);
  }
}

export interface Sent {
  /** The characters keyed so far, in order, without the one still being
   *  keyed. Spaces are left out: where the words fall does not say how far
   *  through the message the sender is. */
  readonly symbols: string[];
  /** The same characters as text, with a space where a word gap fell. */
  readonly text: string;
  /** The elements of the character still being keyed, or null when the key
   *  has been up for a character gap. */
  readonly keying: string | null;
  /** How long the key has been up since the last element, in seconds. */
  readonly quietSec: number;
  /** The tone this pass decoded at. */
  readonly toneHz: number;
  /** The on and off runs the pass read, for measuring the sender. */
  readonly segments: readonly Segment[];
}

/** Marks keyed before the sender's own timing is measured. Fewer than this
 *  is too little evidence for the gaps, and the set timing is used. */
export const MEASURE_MIN_MARKS = 20;

/** The sender's own timing, or `timing` while there is too little keying to
 *  measure. */
function measured(segments: readonly Segment[], timing: Timing): Timing {
  let marks = 0;
  for (const s of segments) if (s[0] === 1) marks++;
  if (marks < MEASURE_MIN_MARKS) return timing;
  try {
    return estimateTiming(segments);
  } catch {
    return timing;
  }
}

/** The least peak, as a fraction of full scale, that can be keying: -60
 *  dBFS. A sender keys well above it. */
export const MIN_KEYING_PEAK = 0.001;

/** The gap before `c` as a share of the cut between a letter gap and a word
 *  gap, for `readWords`. A pause is past any cut. */
function shareOfCut(c: Char, timing: Timing): number {
  const gap = c.leadGap;
  if (!gap) return 0;
  if (gap.kind === "pause") return Infinity;
  return gap.units / (timing.charWordSplit / timing.unitSec);
}

/** Decode what has been keyed so far.
 *
 * Give `toneHz` once it is known. Finding the tone is most of the cost of a
 * pass, and the tone does not move while one take runs.
 *
 * With `measure`, the characters and words are read at the sender's own
 * timing once there is enough keying to measure it, not at `timing`. The
 * last character is still held for `timing`'s character gap.
 *
 * With `calibration`, the edges are corrected for the microphone path, as a
 * finished take is: see `segmentsFrom`. */
export function sentSymbols(
  samples: Float32Array,
  rate: number,
  timing: Timing,
  toneHz?: number,
  measure = false,
  calibration?: Calibration,
  words?: ReadonlySet<string>,
): Sent {
  const none = { symbols: [], text: "", keying: null, quietSec: 0, toneHz: toneHz ?? 0, segments: [] };
  if (samples.length === 0) return none;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  // Quieter than this is not keying. Each pass scales the audio to its own
  // peak, so without a floor a faint noise floor reads as marks.
  if (!(peak >= MIN_KEYING_PEAK)) return none;
  // The threshold works on absolute amplitude, as in the review.
  const scaled = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) scaled[i] = samples[i]! / peak;

  const found = segmentsFrom(scaled, rate, {
    ...(toneHz !== undefined ? { toneHz } : {}),
    ...(calibration ? { calibration } : {}),
  });
  const { segments } = found;
  const read = measure ? measured(segments, timing) : timing;
  const { chars } = buildTimeline(segments, read);
  const last = chars[chars.length - 1];
  if (!last) return { ...none, toneHz: found.toneHz, segments };

  let end = 0;
  for (const s of segments) end += s[1];
  const quietSec = end - last.t1;
  const done = quietSec >= timing.elementCharSplit;
  const kept = done ? chars : chars.slice(0, -1);
  return {
    symbols: kept.map((c) => c.char),
    text:
      measure && words
        ? readWords(kept.map((c, i) => ({ char: c.char, gap: i === 0 ? null : shareOfCut(c, read) })), words)
        : kept.map((c, i) => (i > 0 && opensWord(c) ? ` ${c.char}` : c.char)).join(""),
    keying: done ? null : last.pattern,
    quietSec,
    toneHz: found.toneHz,
    segments,
  };
}

/** The characters of one message that can be keyed, in the order they are
 *  sent. Spaces, breaks and anything with no Morse are left out. */
export function keyedSymbols(message: string): string[] {
  return (message.toUpperCase().match(SYMBOL_RE) ?? []).filter((t) => t in CHAR_TO_MORSE);
}

/** Above this many cells the alignment is not attempted. Twenty passes of a
 *  long drill stay well under it. */
const MAX_CELLS = 4_000_000;

/** A verdict on each character of the target the sender has finished, in
 *  order: true when it was sent right.
 *
 * The sent characters are aligned against the start of the target, with the
 * rest of the target free to go unsent. A dropped character is wrong, and so
 * is one sent as something else. An extra character has no place in the
 * target and gets no verdict.
 *
 * Where two ends of the target cost the same, the further one is taken: CQE
 * against CQDE is a dropped D, not an extra E. Nothing is graded until one
 * character matches. A click before the first character decodes as an E, and
 * that is not a wrong C.
 *
 * Characters are compared by their Morse, as in the review: `=` and `<BT>` are
 * the same character sent. */
export function graded(target: readonly string[], sent: readonly string[]): boolean[] {
  const n = target.length;
  const m = sent.length;
  if (m === 0 || n === 0 || (n + 1) * (m + 1) > MAX_CELLS) return [];
  const kt = target.map(canonicalChar);
  const ks = sent.map(canonicalChar);

  // d[i * w + j]: the cost of aligning target[0..i) with sent[0..j).
  const w = m + 1;
  const d = new Int32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * w + j - 1]! + (kt[i - 1] === ks[j - 1] ? 0 : 1);
      d[i * w + j] = Math.min(sub, d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1);
    }
  }

  let i = 0;
  for (let k = 1; k <= n; k++) if (d[k * w + m]! <= d[i * w + m]!) i = k;
  const out: boolean[] = new Array<boolean>(i).fill(false);

  // Walk back. Target characters the walk passes without a match stay wrong.
  let j = m;
  let matched = false;
  while (i > 0 && j > 0) {
    const here = d[i * w + j]!;
    const same = kt[i - 1] === ks[j - 1];
    if (here === d[(i - 1) * w + j - 1]! + (same ? 0 : 1)) {
      if (same) {
        out[i - 1] = true;
        matched = true;
      }
      i--;
      j--;
    } else if (here === d[(i - 1) * w + j]! + 1) i--;
    else j--;
  }
  return matched ? out : [];
}

/** Two characters that match the message are what says the tone is the
 *  sender's. Before that a click or a hum can win, and a tone locked on one
 *  would hold every later pass to it. */
const TONE_LOCK_MATCHED = 2;

/** Whether a character being keyed is enough to say the sender has started.
 *
 * Once a character has matched, any mark is the next character begun. Before
 * that the room is still being told apart from the key, and clicks read as
 * dits. So the first character counts only once it has a dah or a second
 * element, and only while it keys as the start of the message's first
 * character. */
function started(keying: string, matched: boolean, first: string): boolean {
  if (matched) return true;
  return (keying.length > 1 || keying.includes("-")) && first.startsWith(keying);
}

export interface Progress {
  /** How many characters of the target the sender has reached. The
   *  character being keyed counts from its first element. */
  readonly reached: number;
  /** A verdict on each finished character, in order. See `graded`. */
  readonly graded: readonly boolean[];
  /** Every character has been read back, and the key has stayed up long
   *  enough after the last one that the sender is done. */
  readonly done: boolean;
}

/** How long the key must stay up after the last character before the take
 *  counts as done: this many dits, plus `END_QUIET_SEC`.
 *
 * The last character is read back after a character gap, but the sender may
 * still be reaching to send it again. The wait gives them that chance, and
 * keying again starts it over. */
export const END_QUIET_DITS = 4;
export const END_QUIET_SEC = 1;

/** One take, followed from its first sample.
 *
 * Feed it audio with `push` and ask `step` how far the sender has got. The
 * reached count never goes back: a pass that reads less than the last one is
 * a misreading, not a sender who took a character back. The verdicts are the
 * latest reading, and a later character can change one. */
export class LiveFollower {
  private readonly audio: Decimator;
  private readonly target: readonly string[];
  private readonly timing: Timing;
  private toneHz: number | undefined;
  private best = 0;
  /** The Morse of the message's first character. */
  private readonly first: string;
  private readonly calibration: Calibration | undefined;

  /** With `calibration`, the take's edges are corrected for the microphone
   *  path, as the review corrects them afterwards. */
  constructor(rate: number, target: readonly string[], timing: Timing, calibration?: Calibration) {
    this.audio = new Decimator(rate);
    this.target = target;
    this.timing = timing;
    this.first = CHAR_TO_MORSE[target[0] ?? ""] ?? "";
    this.calibration = calibration;
  }

  push(samples: Float32Array): void {
    this.audio.push(samples);
  }

  step(): Progress {
    const sent = sentSymbols(
      this.audio.samples(),
      this.audio.rate,
      this.timing,
      this.toneHz,
      false,
      this.calibration,
    );
    const verdicts = graded(this.target, sent.symbols);
    const matches = verdicts.filter(Boolean).length;
    const at =
      sent.keying !== null && started(sent.keying, matches > 0, this.first)
        ? Math.min(verdicts.length + 1, this.target.length)
        : verdicts.length;
    if (at > this.best) this.best = at;
    if (this.toneHz === undefined && matches >= TONE_LOCK_MATCHED) this.toneHz = sent.toneHz;
    const done =
      verdicts.length === this.target.length &&
      sent.keying === null &&
      sent.quietSec >= END_QUIET_DITS * this.timing.unitSec + END_QUIET_SEC;
    return { reached: Math.max(this.best, verdicts.length), graded: verdicts, done };
  }
}

/** The words that hand the turn to the other station. A prosign keyed as two
 *  letters, such as K N, counts too. */
const TURN_WORDS = new Set(["K", "<KN>", "KN", "<BK>", "BK", "<SK>", "SK", "<AR>", "AR"]);

/** A question hands the turn over too: ?, AGN?, HW?. A character misread
 *  before a ?, as in 5?, does not. */
const QUESTION_RE = /^[A-Z]*\?$/;

/** How long the key must stay up to end an over that does not end with a
 *  turn word. Never less than this many word gaps. */
export const OVER_QUIET_SEC = 3;

/** How long the key must stay up after a turn word, beyond `END_QUIET_DITS`.
 *  Longer than a take's end: a K can be an acknowledgement in the middle of
 *  an over, and the sender may go on after a pause. */
export const TURN_QUIET_SEC = 2;

/** How many times longer the wait is when the turn word is all that has been
 *  sent. A K at the start of an over is most often an acknowledgement, with
 *  the rest of the over to come. */
export const LONE_TURN_FACTOR = 2;
export const OVER_QUIET_WORD_GAPS = 3;

/** Characters read before the tone is held. With no target there is nothing
 *  to match, so a run of characters is the evidence. */
const TONE_LOCK_CHARS = 3;

export interface Copy {
  /** What has been read so far, with spaces between words. */
  readonly text: string;
  /** The elements of the character still being keyed, or null. */
  readonly keying: string | null;
  /** The sender has handed the turn over. */
  readonly over: boolean;
  /** The speeds the sender keyed the over at, once it is over and long
   *  enough to measure. Null until then. */
  readonly sentWpm: SentWpm | null;
}

export interface SentWpm {
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

/** Marks an over needs before its speed is measured. Fewer, as a lone K, say
 *  too little about the spacing. */
export const SPEED_MIN_MARKS = 12;

/** The speeds `segments` were keyed at, or null with too few marks. */
export function sentWpm(segments: readonly Segment[]): SentWpm | null {
  let marks = 0;
  for (const s of segments) if (s[0] === 1) marks++;
  if (marks < SPEED_MIN_MARKS) return null;
  try {
    const t = estimateTiming(segments);
    if (!(t.charWpm > 0) || !(t.farnsworthWpm > 0)) return null;
    return { charWpm: t.charWpm, farnsworthWpm: Math.min(t.farnsworthWpm, t.charWpm) };
  } catch {
    return null;
  }
}

/** Whether an over has ended: a turn word and `TURN_QUIET_SEC`, twice that
 *  for a turn word alone, or a long silence after anything at all. */
export function overEnded(text: string, quietSec: number, timing: Timing): boolean {
  const words = text.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (!last) return false;
  const turn = TURN_WORDS.has(last) || QUESTION_RE.test(last);
  const lone = words.length === 1 ? LONE_TURN_FACTOR : 1;
  const wait = turn
    ? (END_QUIET_DITS * timing.unitSec + TURN_QUIET_SEC) * lone
    : Math.max(OVER_QUIET_SEC, OVER_QUIET_WORD_GAPS * (timing.wordGapSec || 7 * timing.unitSec));
  return quietSec >= wait;
}

/** One over, copied from its first sample with no message to follow.
 *
 * The same passes as `LiveFollower`, but what comes back is the text itself,
 * and the over ends when the sender hands the turn over. */
/** What one pass of the live copy worked from, for the debug transcript. */
export interface CopyStats {
  /** Samples pushed so far this over, at the capture rate. */
  readonly received: number;
  /** The rate the over is decoded at, after decimation. */
  readonly rate: number;
  /** Decimated samples decoded in this pass. */
  readonly samples: number;
  /** The tone decoded at, and whether it is locked for the rest of the over. */
  readonly toneHz: number;
  readonly locked: boolean;
  /** Marks and gaps found. */
  readonly segments: number;
  /** How long the pass took. */
  readonly passMs: number;
}

export class LiveCopy {
  private readonly audio: Decimator;
  private received = 0;
  private last: CopyStats | null = null;
  private readonly timing: Timing;
  private readonly measure: boolean;
  private readonly calibration: Calibration | undefined;
  private toneHz: number | undefined;
  private readonly words: ReadonlySet<string> | undefined;

  /** With `measure`, the over is read at the sender's own timing. With
   *  `calibration`, its edges are corrected for the microphone path. With
   *  `words` as well, a gap near the cut between letters and words is read
   *  as whichever makes words of them. See `sentSymbols`. */
  constructor(
    rate: number,
    timing: Timing,
    measure = false,
    calibration?: Calibration,
    words?: ReadonlySet<string>,
  ) {
    this.audio = new Decimator(rate);
    this.timing = timing;
    this.measure = measure;
    this.calibration = calibration;
    this.words = words;
  }

  push(samples: Float32Array): void {
    this.received += samples.length;
    this.audio.push(samples);
  }

  /** What the last pass worked from, or null before the first. */
  stats(): CopyStats | null {
    return this.last;
  }

  step(): Copy {
    const began = typeof performance === "undefined" ? 0 : performance.now();
    const locked = this.toneHz !== undefined;
    const sent = sentSymbols(
      this.audio.samples(),
      this.audio.rate,
      this.timing,
      this.toneHz,
      this.measure,
      this.calibration,
      this.words,
    );
    if (this.toneHz === undefined && sent.symbols.length >= TONE_LOCK_CHARS) {
      this.toneHz = sent.toneHz;
    }
    this.last = {
      received: this.received,
      rate: this.audio.rate,
      samples: this.audio.samples().length,
      toneHz: Math.round(sent.toneHz),
      locked,
      segments: sent.segments.length,
      passMs: Math.round((typeof performance === "undefined" ? 0 : performance.now()) - began),
    };
    const over = sent.keying === null && overEnded(sent.text, sent.quietSec, this.timing);
    return { text: sent.text, keying: sent.keying, over, sentWpm: over ? sentWpm(sent.segments) : null };
  }
}
