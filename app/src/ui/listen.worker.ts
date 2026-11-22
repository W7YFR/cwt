/* The Live page's decoder, off the page's thread.
 *
 * Audio arrives in pieces as the recorder is read. A pass runs at most every
 * `PASS_EVERY_MS`, on all the audio that came in since the last one, and
 * answers with what changed: the turns that became final, every open turn, the
 * signals followed and the band. Passes do not queue, as in live.worker.ts.
 */

import { LiveDecoder, type LiveStep, type Turn } from "@/live/decoder";
import type { Calibration } from "@/dsp";

/** Starts listening, or starts again. Replies carry `gen`, so the page can
 *  drop a reply about the session before. */
export interface ListenStart {
  readonly type: "start";
  readonly gen: number;
  readonly rate: number;
  readonly calibration: Calibration | null;
  /** The words to read by meaning. */
  readonly words: readonly string[];
  /** The pitches to decode, Hz, or null for the whole band. */
  readonly range: readonly [number, number] | null;
}

/** The pitches to decode change. */
export interface ListenRange {
  readonly type: "range";
  readonly range: readonly [number, number] | null;
}

/** More words to read by meaning: calls you confirm while listening. */
export interface ListenLearn {
  readonly type: "learn";
  readonly words: readonly string[];
}

/** Audio captured since the last of these. */
export interface ListenAudio {
  readonly type: "audio";
  readonly samples: Float32Array;
}

/** Listening stops: every open turn becomes final. */
export interface ListenFlush {
  readonly type: "flush";
}

export type ListenIn = ListenStart | ListenAudio | ListenFlush | ListenLearn | ListenRange;

export type ListenOut =
  | ({ readonly type: "step"; readonly gen: number; readonly passMs: number } & LiveStep)
  | { readonly type: "flushed"; readonly gen: number; readonly final: Turn[] }
  | { readonly type: "failed"; readonly gen: number; readonly final: Turn[]; readonly error: string };

/** The least time between the start of one pass and the next. */
const PASS_EVERY_MS = 150;

interface WorkerScope {
  onmessage: ((ev: MessageEvent<ListenIn>) => void) | null;
  postMessage(message: ListenOut): void;
}
const scope = self as unknown as WorkerScope;

let decoder: LiveDecoder | null = null;
let gen = 0;
let fresh = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPass = 0;

function pass(): void {
  timer = null;
  if (!decoder || !fresh) return;
  fresh = false;
  lastPass = performance.now();
  try {
    const step = decoder.step();
    scope.postMessage({ type: "step", gen, passMs: performance.now() - lastPass, ...step });
  } catch (e) {
    // Said, so the page's debug transcript shows it. The next pass tries
    // again.
    scope.postMessage({ type: "failed", gen, final: [], error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
  }
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "start") {
    gen = msg.gen;
    decoder = new LiveDecoder(msg.rate, msg.calibration, msg.words);
    decoder.setRange(msg.range);
    fresh = false;
    return;
  }
  if (!decoder) return;
  if (msg.type === "learn") {
    decoder.learn(msg.words);
    return;
  }
  if (msg.type === "range") {
    decoder.setRange(msg.range);
    return;
  }
  if (msg.type === "flush") {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    scope.postMessage({ type: "flushed", gen, final: decoder.flush() });
    decoder = null;
    return;
  }
  decoder.push(msg.samples);
  fresh = true;
  if (timer === null) {
    timer = setTimeout(pass, Math.max(0, lastPass + PASS_EVERY_MS - performance.now()));
  }
};
