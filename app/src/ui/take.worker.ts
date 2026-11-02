/* A Send take, read off the page's thread. The reading is analyzeClip in
 * io/take.ts. */

import { analyzeClip, NoKeyingError, type AnalyzeOptions, type AnalyzeResult } from "@/io/take";
import type { AudioClip } from "@/types";

export interface TakeRequest {
  readonly clip: AudioClip;
  readonly options: AnalyzeOptions;
}

export type TakeReply =
  | { readonly type: "done"; readonly result: AnalyzeResult }
  | { readonly type: "no-keying"; readonly message: string }
  | { readonly type: "error"; readonly message: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<TakeRequest>) => void) | null;
  postMessage(message: TakeReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  try {
    const result = analyzeClip(ev.data.clip, ev.data.options);
    scope.postMessage({ type: "done", result }, [result.clip.samples.buffer]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    scope.postMessage(
      e instanceof NoKeyingError ? { type: "no-keying", message } : { type: "error", message },
    );
  }
};
