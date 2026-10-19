/* The QSO copy's passes, apart from the thread that runs them.
 *
 * The same schedule as live.worker.ts: a pass decodes the whole over so far,
 * passes do not queue, and audio that arrives during a pass waits for the
 * next one. copy.worker.ts runs this off the page's thread. A test can run it
 * on the page, on a clock it controls.
 */

import { LiveCopy, type Copy, type CopyStats } from "@/timing/live";
import { targetTiming } from "@/timing/model";
import type { Calibration } from "@/dsp";

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
  /** The microphone path's correction, when one is chosen. */
  readonly calibration: Calibration | null;
}

/** Audio captured since the last of these. */
export interface CopyAudio {
  readonly type: "audio";
  readonly samples: Float32Array;
}

export interface CopyRead extends Copy {
  readonly gen: number;
  /** What the pass worked from, for the debug transcript. */
  readonly stats: CopyStats | null;
}

/** The least time between the start of one pass and the next. */
const PASS_EVERY_MS = 150;

/** A handler for the page's messages. Each reading goes to `post`. */
export function copyPasses(post: (read: CopyRead) => void): (msg: CopyStart | CopyAudio) => void {
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
    const read = copy.step();
    post({ gen, ...read, stats: copy.stats() });
  }

  return (msg) => {
    if (msg.type === "start") {
      gen = msg.gen;
      copy = new LiveCopy(
        msg.rate,
        targetTiming(msg.charWpm, msg.farnsworthWpm),
        msg.lenient,
        msg.calibration ?? undefined,
      );
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
}
