/* The live decode, off the page's thread.
 *
 * A pass decodes the whole take so far, so it costs more the longer the take
 * runs. On the page's thread that cost would land between frames of the clock
 * and the level meter. Here it lands nowhere anyone can see.
 *
 * Passes do not queue. Audio that arrives while a pass runs waits in the
 * message queue, and the next pass takes all of it at once. So a slow pass
 * makes the count later, never behind by more and more.
 */

import { LiveFollower } from "@/timing/live";
import { targetTiming } from "@/timing/model";

/** Starts a take, or starts it over. Replies carry `gen`, so the page can drop
 *  a reply about the take before. */
export interface LiveStart {
  readonly type: "start";
  readonly gen: number;
  readonly rate: number;
  readonly target: readonly string[];
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

/** Audio captured since the last of these. */
export interface LiveAudio {
  readonly type: "audio";
  readonly samples: Float32Array;
}

export interface LiveReached {
  readonly gen: number;
  readonly reached: number;
}

/** The least time between the start of one pass and the next. Fast enough that
 *  the count follows the sending, slow enough not to run a core flat out. */
const PASS_EVERY_MS = 150;

interface WorkerScope {
  onmessage: ((ev: MessageEvent<LiveStart | LiveAudio>) => void) | null;
  postMessage(message: LiveReached): void;
}
const scope = self as unknown as WorkerScope;

let follower: LiveFollower | null = null;
let gen = 0;
let fresh = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPass = 0;

function pass(): void {
  timer = null;
  if (!follower || !fresh) return;
  fresh = false;
  lastPass = performance.now();
  scope.postMessage({ gen, reached: follower.step() });
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "start") {
    gen = msg.gen;
    follower = new LiveFollower(
      msg.rate,
      msg.target,
      targetTiming(msg.charWpm, msg.farnsworthWpm),
    );
    fresh = false;
    return;
  }
  if (!follower) return;
  follower.push(msg.samples);
  fresh = true;
  if (timer === null) {
    timer = setTimeout(pass, Math.max(0, lastPass + PASS_EVERY_MS - performance.now()));
  }
};
