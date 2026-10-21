/* The Copy page's recording, read off the page's thread. The reading is in
 * copy/decode.ts. */

import { decodeRecording, type Recording } from "@/copy/decode";

export interface RecordingRequest {
  readonly samples: Float32Array;
  readonly rate: number;
}

export type RecordingReply =
  | { readonly type: "done"; readonly recording: Recording | null }
  | { readonly type: "error"; readonly message: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<RecordingRequest>) => void) | null;
  postMessage(message: RecordingReply): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  try {
    scope.postMessage({ type: "done", recording: decodeRecording(ev.data.samples, ev.data.rate) });
  } catch (e) {
    scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
