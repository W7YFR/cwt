/* Reading a Send take: in a worker where there is one, on the page where
 * there is not. A long take reads for a second or more, and on the page that
 * second is a frozen screen. */

import { analyzeClip, NoKeyingError, type AnalyzeOptions, type AnalyzeResult } from "@/io/take";
import type { AudioClip } from "@/types";
import type { TakeReply } from "./take.worker";

/** What analyzeClip makes of `clip`. The samples go to the worker and are not
 *  usable after. Rejects with a NoKeyingError when the take holds no keying. */
export function readTake(clip: AudioClip, options: AnalyzeOptions): Promise<AnalyzeResult> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./take.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return new Promise((resolve) => resolve(analyzeClip(clip, options)));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<TakeReply>) => {
      worker.terminate();
      const reply = ev.data;
      if (reply.type === "done") resolve(reply.result);
      else if (reply.type === "no-keying") reject(new NoKeyingError(reply.message));
      else reject(new Error(reply.message));
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || "could not read the recording"));
    };
    worker.postMessage({ clip, options }, [clip.samples.buffer]);
  });
}
