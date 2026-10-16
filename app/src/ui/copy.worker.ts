/* The QSO copy, off the page's thread.
 *
 * The same schedule as live.worker.ts: a pass decodes the whole over so far,
 * passes do not queue, and audio that arrives during a pass waits for the
 * next one.
 */

import { LiveCopy, type Copy } from "@/timing/live";
import { targetTiming } from "@/timing/model";

/** Starts an over. Replies carry `gen`, so the page can drop a reply about
 *  the over before. */
export interface CopyStart {
  readonly type: "start";
  readonly gen: number;
  readonly rate: number;
  readonly charWpm: number;
  readonly farnsworthWpm: number;
  /** Read the over at the sender's own timing. */
  readonly lenient: boolean;
}

/** Audio captured since the last of these. */
export interface CopyAudio {
  readonly type: "audio";
  readonly samples: Float32Array;
}

export interface CopyRead extends Copy {
  readonly gen: number;
}

/** The least time between the start of one pass and the next. */
const PASS_EVERY_MS = 150;

interface WorkerScope {
  onmessage: ((ev: MessageEvent<CopyStart | CopyAudio>) => void) | null;
  postMessage(message: CopyRead): void;
}
const scope = self as unknown as WorkerScope;

let copy: LiveCopy | null = null;
let gen = 0;
let fresh = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPass = 0;

function pass(): void {
  timer = null;
  if (!copy || !fresh) return;
  fresh = false;
  lastPass = performance.now();
  scope.postMessage({ gen, ...copy.step() });
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "start") {
    gen = msg.gen;
    copy = new LiveCopy(msg.rate, targetTiming(msg.charWpm, msg.farnsworthWpm), msg.lenient);
    fresh = false;
    return;
  }
  if (!copy) return;
  copy.push(msg.samples);
  fresh = true;
  if (timer === null) {
    timer = setTimeout(pass, Math.max(0, lastPass + PASS_EVERY_MS - performance.now()));
  }
};
