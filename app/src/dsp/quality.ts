/* How good is this setup, and how fast can it be sent at?
 *
 * A microphone in a room adds a tail to every element. The sidetone stops, the
 * room does not, and the decoder goes on seeing energy for as long as the
 * reflections keep arriving. Whether that matters is not a question about the
 * room on its own — it is a question about the room against the dit. A tail
 * that dies in 30 ms is nothing at 15 words a minute, where a dit is 80, and
 * fatal at 40, where it is 30.
 *
 * So the measure is the release decay, and the verdict is its ratio to the
 * dit. That also makes the answer a *speed*, which is more useful advice than
 * a grade: somebody told "this setup is good to about 18 wpm" knows what to do
 * next.
 *
 * Measuring the decay is where the care goes, because the obvious method does
 * not work. "Time until the envelope first falls 20 dB" is wrong in a real
 * room: interference between the direct sound and its reflections puts notches
 * in the tail, and the envelope dives through -20 dB at the bottom of one and
 * comes straight back up. On the worst recording in the corpus that reports
 * 23 ms for a tail that is still at -14 dB forty milliseconds later, which
 * would have graded the least usable setup here as one of the best.
 *
 * "Time until it LAST falls 20 dB" fails the other way — a single noise blip
 * anywhere in a long gap resets it, and on a clean loopback capture that turns
 * a 6 ms decay into 340.
 *
 * What survives both is total time: how much of the window after key-up is
 * spent above -20 dB, added up. A notch contributes nothing because the
 * envelope is below the line inside it; an isolated blip contributes its own
 * width and no more. Measured that way the corpus lines up with how far each
 * microphone was from the speaker, which is the thing the measurement is
 * supposed to be about: 5 ms through a loopback, 30 at a few inches, 56 and 82
 * across a room, 103 at the worst.
 *
 * What the decay does NOT do is predict whether a recording will decode. Two
 * setups here measure 82 ms and 79 ms against an 80 ms dit and one of them
 * works while the other is unrecoverable. Whether a setup can be trusted is
 * measured directly and separately, by whether calibration drills agree with
 * each other — see calibrate.ts. The verdict below is therefore graded to what
 * the evidence actually supports, and says "calibrate, and that will tell you"
 * across the whole middle of the range rather than guessing.
 */

import type { Segment } from "@/types";
import { segmentsFrom, type SegmentOptions } from "./index";
import { envelope, DEFAULT_BANDWIDTH } from "./envelope";
import { localPeak, LEVEL_WINDOW_SEC } from "./level";
import { roughUnitSec } from "./segments";

/** How far down the tail has to be before it stops mattering. Twenty dB below
 *  a mark is about where a following element stops being pulled up by it. */
const DECAY_FLOOR = 0.1;

/** Level a mark has to reach before the decay from it is worth measuring, as
 *  a fraction of the local steady level. Below this it is a shard, and its
 *  "release" is the middle of somebody else's element. */
const FULL_LEVEL = 0.9;

/** How long after key-up to look, in dits. Past this the tail is longer than
 *  anything the ratio below can distinguish, so there is no point paying for
 *  the samples. */
const WINDOW_DITS = 2.5;

/** Hard bounds on the window, for speeds at the ends of the range. */
const MIN_WINDOW_SEC = 0.05;
const MAX_WINDOW_SEC = 0.5;

/** Decay under a quarter of a dit: nothing between the key and the decoder
 *  worth naming. Every loopback capture in the corpus is far inside this. */
export const CLEAN_FRAC = 0.25;

/** Decay under three quarters of a dit: reads as it stands. Nothing in the
 *  corpus inside this band needed correcting — a microphone a few inches from
 *  the speaker measures 0.37 and decodes at the speed it was keyed. */
export const GOOD_FRAC = 0.75;

/** Past here the room is a large enough fraction of a dit that whether the
 *  recording is readable stops being answerable from the decay.
 *
 * This bound is where the honesty of the whole module lives, so it is worth
 * being explicit about what the evidence does and does not support. Two
 * setups in the corpus measure 82 ms and 79 ms against an 80 ms dit — all but
 * identical — and one of them calibrates and decodes correctly while the
 * other cannot be recovered at all. The decay simply does not separate them.
 * What it does do is order them: every setup that reads without help is below
 * GOOD_FRAC, and the only setup above LIMIT_FRAC is one that no amount of
 * correction saves.
 *
 * So the band between them says "the room is a real part of what you are
 * recording, move the microphone closer if you can, and calibrate" — and
 * calibration, which measures whether drills agree with each other, is what
 * actually decides. Claiming more than that from one number would be wrong in
 * the direction that matters: telling somebody their working setup is broken. */
export const LIMIT_FRAC = 1.5;

/** Releases needed before the median means anything.
 *
 * A held-paddle drill at 15 wpm has 80 ms between elements and the window is
 * 200, so the only release with room to be measured is the one at the very end
 * of the recording. One sample is not a measurement, and saying "unknown" is
 * the honest answer — the isolated-element drill, or any ordinary message with
 * word spacing in it, gives six to eighteen. */
const MIN_RELEASES = 3;

/** Speeds outside this are not what anyone is practicing at, and a ceiling
 *  reported outside it would be noise either way. */
const MIN_WPM = 5;
const MAX_WPM = 60;

/** What the decay came to, relative to the dit.
 *
 * Named for the measurement and not for its cause. What sits between a keyer
 * and this app is not known here — it may be a room, it may be the keyer's own
 * shaping, it may be a virtual audio device with nothing in the path at all —
 * and a verdict called "too far from the speaker" would be a diagnosis this
 * has no way to make. Placement is the most common cause and the advice below
 * says so; the verdict itself only reports what was measured. */
export type SetupVerdict =
  /** Nothing measurable added to a release. */
  | "clean"
  /** Something is added, but not enough to matter at this speed. */
  | "good"
  /** Enough is added to matter at this speed. */
  | "marginal"
  /** So much is added that elements run into each other. */
  | "unusable"
  /** Not enough releases to say. */
  | "unknown";

export interface SetupQuality {
  /** Time spent above -20 dB after key-up, median over releases. NaN when
   *  nothing could be measured. */
  readonly decaySec: number;
  /** The dit this was judged against. */
  readonly ditSec: number;
  /** decaySec / ditSec — the number the verdict is actually made from. */
  readonly ratio: number;
  /** How many releases the median was taken over. */
  readonly releases: number;
  readonly verdict: SetupVerdict;
  /** Speed at which this decay would still be a small part of a dit, in wpm.
   *  A guide to how fast to send through this setup, not a promise about it. */
  readonly maxWpm: number;
}

function median(v: readonly number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Seconds a dit lasts at `wpm`. PARIS, the usual definition. */
export function ditSecAt(wpm: number): number {
  return 1.2 / wpm;
}

/** Total time above -20 dB after each key-up, median over all of them.
 *
 * `windowSec` bounds how far past each release to look, and a release is only
 * measured when the gap after it is at least that long — a decay cut short by
 * the next element is not a measurement of the room, it is a measurement of
 * the spacing. */
export function releaseDecaySec(
  env: Float32Array,
  peak: Float32Array,
  rate: number,
  segments: readonly Segment[],
  windowSec: number,
): { decaySec: number; releases: number } {
  const window = Math.max(1, Math.round(windowSec * rate));
  const found: number[] = [];

  let at = 0;
  for (let i = 0; i < segments.length; i++) {
    const [state, dur] = segments[i]!;
    const n = Math.round(dur * rate);
    const from = at;
    const to = at + n;
    at = to;
    if (state !== 1) continue;

    const next = segments[i + 1];
    if (!next || next[0] !== 0 || next[1] < windowSec) continue;

    const level = peak[Math.min(env.length - 1, Math.max(0, to - 1))] ?? 0;
    if (!(level > 0)) continue;

    /* Start the clock where the key came up, not where the segmenter put the
       boundary. The boundary sits near half amplitude by construction, which
       is already partway down the release; measuring from there would report
       a shorter tail for a setup with a slower one. */
    let start = Math.min(env.length - 1, to);
    while (start > from && env[start]! < FULL_LEVEL * level) start--;
    if (env[start]! < FULL_LEVEL * level) continue;

    const floor = DECAY_FLOOR * level;
    const limit = Math.min(env.length, start + window);
    let above = 0;
    for (let j = start; j < limit; j++) if (env[j]! > floor) above++;
    found.push(above / rate);
  }

  return { decaySec: median(found), releases: found.length };
}

export interface SetupOptions extends SegmentOptions {
  /** Speed this was keyed at. Without it the dit is taken from the recording,
   *  which is right for a message and pessimistic for a shattered one — the
   *  shards make the dit look shorter than it was, and a shorter dit is a
   *  harsher verdict. Erring that way is the correct direction. */
  readonly wpm?: number;
}

function verdictFor(ratio: number, releases: number): SetupVerdict {
  if (!Number.isFinite(ratio) || releases < MIN_RELEASES) return "unknown";
  if (ratio <= CLEAN_FRAC) return "clean";
  if (ratio <= GOOD_FRAC) return "good";
  if (ratio <= LIMIT_FRAC) return "marginal";
  return "unusable";
}

/** Judge a setup from one recording made through it.
 *
 * `samples` should be peak-normalized, like everything else that goes into the
 * DSP. The recording can be anything keyed — a drill, a message, or a handful
 * of isolated elements, which is the easiest case because every release has a
 * long gap after it. */
export function assessSetup(
  samples: Float32Array,
  rate: number,
  options: SetupOptions = {},
): SetupQuality {
  const { segments, toneHz } = segmentsFrom(samples, rate, options);
  const ditSec = options.wpm ? ditSecAt(options.wpm) : roughUnitSec(segments);
  const unknown: SetupQuality = {
    decaySec: NaN,
    ditSec,
    ratio: NaN,
    releases: 0,
    verdict: "unknown",
    maxWpm: NaN,
  };
  if (!(ditSec > 0) || samples.length === 0) return unknown;

  const windowSec = Math.min(
    MAX_WINDOW_SEC,
    Math.max(MIN_WINDOW_SEC, WINDOW_DITS * ditSec),
  );
  const env = envelope(samples, rate, toneHz, options.bandwidth ?? DEFAULT_BANDWIDTH);
  const peak = localPeak(env, rate, LEVEL_WINDOW_SEC);
  const { decaySec, releases } = releaseDecaySec(env, peak, rate, segments, windowSec);
  if (!Number.isFinite(decaySec)) return unknown;

  const ratio = decaySec / ditSec;
  // The speed at which this decay would still be inside the good band. A
  // decay of zero would divide to infinity, so the clamp is doing real work
  // on a loopback capture and not only guarding against nonsense.
  const maxWpm = Math.max(
    MIN_WPM,
    Math.min(MAX_WPM, Math.floor((1.2 * GOOD_FRAC) / Math.max(decaySec, 1e-6))),
  );

  return {
    decaySec,
    ditSec,
    ratio,
    releases,
    verdict: verdictFor(ratio, releases),
    maxWpm,
  };
}

/** What to tell somebody about their setup, leading with what they can change.
 *
 * Placement first where there is any placement to change, because the largest
 * single effect measured anywhere in this work was moving one webcam: the same
 * microphone in the same room went from refused, to a 13 ms correction, to
 * needing none at all, purely by distance from the speaker. No amount of
 * processing came close.
 *
 * Conditionally, though. Nothing here knows whether a microphone and a speaker
 * are involved at all — a loopback has neither — so the advice offers the most
 * likely cause rather than asserting it. */
export function setupAdvice(q: SetupQuality): string {
  const wpm = Number.isFinite(q.maxWpm) ? q.maxWpm : 0;
  switch (q.verdict) {
    case "clean":
      return "Nothing measurable between your keyer and the decoder — this reads at any speed you can send.";
    case "good":
      return `A little is added to every element, but not enough to matter up to about ${wpm} wpm.`;
    case "marginal":
      return (
        "If a microphone is listening to a speaker, move it closer — that is the " +
        `biggest change available. As it stands this is good to about ${wpm} wpm.`
      );
    case "unusable":
      return (
        "If a microphone is listening to a speaker, move it within a few inches " +
        "and record again. Elements are running into each other, and no amount of " +
        "correction recovers that."
      );
    default:
      return (
        "Not enough keying here to judge. Send a few single elements with a " +
        "second or two between them."
      );
  }
}
