/* How far through the message the sender has got, while the take runs.
 *
 * The recorder is read on a timer and what it captured since the last read
 * goes to a worker, which decodes and answers with a count and a verdict on
 * each finished character. See live.worker.ts and timing/live.ts.
 *
 * The count only ever rises within one take. Restart starts it again from 0.
 */

import { useEffect, useState } from "react";
import type { Recorder } from "@/capture/mic";
import type { Progress } from "@/timing/live";
import type { LiveAudio, LiveReached, LiveStart } from "./live.worker";

/** How often the recorder is read. The worker sets its own pace; this only
 *  has to keep it fed. */
const READ_EVERY_MS = 75;

export interface LiveSource {
  readonly recorder: Recorder;
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

const NONE: Progress = { reached: 0, graded: [], done: false };

/** How far the sender has got, or nothing with no source.
 *
 * `target` is the take's characters in order, as `keyedSymbols` gives them,
 * every pass included. */
export function useLiveProgress(
  source: LiveSource | null,
  target: readonly string[],
): Progress {
  const [progress, setProgress] = useState<Progress>(NONE);
  const recorder = source?.recorder ?? null;
  const charWpm = source?.charWpm ?? 0;
  const farnsworthWpm = source?.farnsworthWpm ?? 0;
  // The effect depends on the characters, not on the array that holds them.
  const key = target.join("\u0000");

  useEffect(() => {
    setProgress(NONE);
    if (!recorder || target.length === 0) return;

    let worker: Worker;
    try {
      worker = new Worker(new URL("./live.worker.ts", import.meta.url), { type: "module" });
    } catch {
      // No workers here. The sheet still shows the message, uncolored.
      return;
    }

    let gen = 0;
    let read = 0;
    let restarts = recorder.restarts();
    let shown = "";
    let best = 0;

    const begin = () => {
      gen++;
      read = 0;
      shown = "";
      best = 0;
      setProgress(NONE);
      const start: LiveStart = {
        type: "start",
        gen,
        rate: recorder.rate,
        target,
        charWpm,
        farnsworthWpm,
      };
      worker.postMessage(start);
    };

    worker.onmessage = (ev: MessageEvent<LiveReached>) => {
      if (ev.data.gen !== gen) return;
      const { graded, done } = ev.data;
      best = Math.max(best, ev.data.reached);
      const reached = best;
      // Most passes change nothing, and a render per pass would be for nothing.
      const now = `${reached}:${graded.map((ok) => (ok ? 1 : 0)).join("")}:${done}`;
      if (now === shown) return;
      shown = now;
      setProgress({ reached, graded, done });
    };

    begin();
    const timer = setInterval(() => {
      if (recorder.restarts() !== restarts) {
        restarts = recorder.restarts();
        begin();
      }
      const samples = recorder.since(read);
      if (samples.length === 0) return;
      read += samples.length;
      const audio: LiveAudio = { type: "audio", samples };
      worker.postMessage(audio, [samples.buffer]);
    }, READ_EVERY_MS);

    return () => {
      clearInterval(timer);
      worker.terminate();
    };
    // `target` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, charWpm, farnsworthWpm, key]);

  return recorder ? progress : NONE;
}
