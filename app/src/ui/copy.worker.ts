/* The QSO copy, off the page's thread. The passes are in copyPass.ts. */

import { copyPasses, type CopyAudio, type CopyRead, type CopyStart } from "./copyPass";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<CopyStart | CopyAudio>) => void) | null;
  postMessage(message: CopyRead): void;
}
const scope = self as unknown as WorkerScope;

const handle = copyPasses((read) => scope.postMessage(read));
scope.onmessage = (ev) => handle(ev.data);
