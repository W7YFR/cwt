/* How far through the message the sender has got, while the take runs.
 *
 * The recorder is read on a timer and what it captured since the last read
 * goes to a worker, which decodes and answers with a count. See
 * live.worker.ts and timing/live.ts.
 *
 * The count only ever rises within one take. Restart starts it again from 0.
 */

import { useEffect, useState } from "react";
import type { Recorder } from "@/capture/mic";
import type { LiveAudio, LiveReached, LiveStart } from "./live.worker";

/** How often the recorder is read. The worker sets its own pace; this only
 *  has to keep it fed. */
const READ_EVERY_MS = 75;

export interface LiveSource {
  readonly recorder: Recorder;
  readonly charWpm: number;
  readonly farnsworthWpm: number;
}

/** The count of target characters reached, or 0 with no source.
 *
 * `target` is the take's characters in order, as `keyedSymbols` gives them,
 * every pass included. */
export function useLiveProgress(source: LiveSource | null, target: readonly string[]): number {
  const [reached, setReached] = useState(0);
  const recorder = source?.recorder ?? null;
  const charWpm = source?.charWpm ?? 0;
  const farnsworthWpm = source?.farnsworthWpm ?? 0;
  // The effect depends on the characters, not on the array that holds them.
  const key = target.join("\u0000");

  useEffect(() => {
    setReached(0);
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
    let best = 0;

    const begin = () => {
      gen++;
      read = 0;
      best = 0;
      setReached(0);
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
      if (ev.data.gen !== gen || ev.data.reached <= best) return;
      best = ev.data.reached;
      setReached(best);
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

  return recorder ? reached : 0;
}
