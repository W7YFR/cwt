/* Reading a recording for the Copy page: in a worker where there is one, on
 * the page where there is not. */

import { decodeRecording, type Recording } from "@/copy/decode";

/** What the decoder reads from `samples`, a recording at `rate`. Null when
 *  it holds no keying. The samples go to the worker and are not usable
 *  after. */
export function readRecording(samples: Float32Array, rate: number): Promise<Recording | null> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./recording.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(decodeRecording(samples, rate));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<{ type: string; recording?: Recording | null; message?: string }>) => {
      worker.terminate();
      if (ev.data.type === "done") resolve(ev.data.recording ?? null);
      else reject(new Error(ev.data.message ?? "could not read the recording"));
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || "could not read the recording"));
    };
    worker.postMessage({ samples, rate }, [samples.buffer]);
  });
}

/** Whether `v` reads as a Recording: what a reload brings back is checked
 *  before the page trusts it. */
export function isRecording(v: unknown): v is Recording {
  const r = v as Partial<Recording> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.durationSec === "number" &&
    Array.isArray(r.senders) &&
    Array.isArray(r.overs) &&
    r.overs.every(
      (o) =>
        typeof o?.text === "string" &&
        typeof o.sender === "number" &&
        Array.isArray(o.words) &&
        o.words.every((w: { chars?: unknown[] } | null) => Array.isArray(w?.chars) && w.chars.length > 0),
    )
  );
}
