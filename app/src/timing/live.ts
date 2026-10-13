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

import type { Timing } from "@/types";
import { segmentsFrom } from "@/dsp";
import { CHAR_TO_MORSE, SYMBOL_RE, canonicalChar } from "@/morse";
import { buildTimeline } from "./timeline";

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
  /** The elements of the character still being keyed, or null when the key
   *  has been up for a character gap. */
  readonly keying: string | null;
  /** How long the key has been up since the last element, in seconds. */
  readonly quietSec: number;
  /** The tone this pass decoded at. */
  readonly toneHz: number;
}

/** Decode what has been keyed so far.
 *
 * Give `toneHz` once it is known. Finding the tone is most of the cost of a
 * pass, and the tone does not move while one take runs. */
export function sentSymbols(
  samples: Float32Array,
  rate: number,
  timing: Timing,
  toneHz?: number,
): Sent {
  const none = { symbols: [], keying: null, quietSec: 0, toneHz: toneHz ?? 0 };
  if (samples.length === 0) return none;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  if (!(peak > 0)) return none;
  // The threshold works on absolute amplitude, as in the review.
  const scaled = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) scaled[i] = samples[i]! / peak;

  const found = segmentsFrom(scaled, rate, toneHz !== undefined ? { toneHz } : {});
  const { segments } = found;
  const { chars } = buildTimeline(segments, timing);
  const last = chars[chars.length - 1];
  if (!last) return { ...none, toneHz: found.toneHz };

  let end = 0;
  for (const s of segments) end += s[1];
  const quietSec = end - last.t1;
  const done = quietSec >= timing.elementCharSplit;
  return {
    symbols: (done ? chars : chars.slice(0, -1)).map((c) => c.char),
    keying: done ? null : last.pattern,
    quietSec,
    toneHz: found.toneHz,
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

  constructor(rate: number, target: readonly string[], timing: Timing) {
    this.audio = new Decimator(rate);
    this.target = target;
    this.timing = timing;
    this.first = CHAR_TO_MORSE[target[0] ?? ""] ?? "";
  }

  push(samples: Float32Array): void {
    this.audio.push(samples);
  }

  step(): Progress {
    const sent = sentSymbols(this.audio.samples(), this.audio.rate, this.timing, this.toneHz);
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
