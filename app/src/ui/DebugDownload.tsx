/* The debug transcript and audio, saved to a file, behind `?micdebug`.
 *
 * For a fault seen on the deployed site and nowhere else: the transcript says
 * what the browser and the page did, and the audio is each over as the
 * decoder was given it, so the same audio can be decoded again here. Shown
 * with `?micdebug`, or once `__cwtMicDebug(true)` is typed into the console;
 * what was kept before then is saved too.
 */

import { APP_VERSION } from "@/build-info";
import { encodeWav } from "@/audio/wav";
import { useSyncExternalStore } from "react";
import {
  MIC_DEBUG_EVENT,
  debugAudio,
  micDebugOn,
  micTranscript,
  type DebugAudio,
} from "@/micdebug";

/** The switch, followed: `__cwtMicDebug(true)` shows the buttons at once. */
function subscribe(changed: () => void): () => void {
  window.addEventListener(MIC_DEBUG_EVENT, changed);
  return () => window.removeEventListener(MIC_DEBUG_EVENT, changed);
}

/** Silence between the overs in the saved audio, in seconds. */
const BETWEEN_SEC = 0.5;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** One name for both files of a save, so they sort together. */
function stemNow(): string {
  return `cwt-debug-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** The kept audio as one WAV, and an index of where each over starts in it. */
function joined(current: DebugAudio | null): {
  samples: Float32Array;
  rate: number;
  index: string[];
} {
  const kept = current ? [...debugAudio(), current] : debugAudio();
  const rate = kept[0]?.rate ?? 48000;
  const gap = Math.round(BETWEEN_SEC * rate);
  const index: string[] = [];
  let length = 0;
  for (const a of kept) length += a.samples.length + gap;
  const samples = new Float32Array(length);
  let at = 0;
  for (const a of kept) {
    index.push(`${(at / rate).toFixed(3)}s  ${(a.samples.length / a.rate).toFixed(2)}s  ${a.label}`);
    // One rate per session; a stretch at another rate is noted, not resampled.
    if (a.rate !== rate) index.push(`  (recorded at ${a.rate} Hz, saved as ${rate} Hz)`);
    samples.set(a.samples, at);
    at += a.samples.length + gap;
  }
  return { samples, rate, index };
}

/** Save the transcript, with the audio's index at its head. */
function saveLog(current: DebugAudio | null): void {
  const { index } = joined(current);
  const text = [
    `cwt ${APP_VERSION}`,
    `page ${location.href}`,
    `agent ${navigator.userAgent}`,
    "",
    "== audio index ==",
    ...(index.length ? index : ["(no audio kept)"]),
    "",
    "== transcript ==",
    micTranscript(),
  ].join("\n");
  saveBlob(new Blob([text], { type: "text/plain" }), `${stemNow()}.txt`);
}

/** Save the kept audio. A button of its own: a browser lets one click save
 *  one file, and asks before a second. */
function saveAudio(current: DebugAudio | null): void {
  const { samples, rate } = joined(current);
  saveBlob(encodeWav(samples, rate), `${stemNow()}.wav`);
}

/** `current` is the over still being sent, if any: an over that never ends,
 *  as a garbled one may not, is saved too. */
export function DebugDownload({
  current,
}: {
  current(): DebugAudio | null;
}): React.ReactElement | null {
  const on = useSyncExternalStore(subscribe, micDebugOn);
  if (!on) return null;
  return (
    <>
      <button type="button" data-testid="debug-log" onClick={() => saveLog(current())}>
        Save log
      </button>
      <button type="button" data-testid="debug-audio" onClick={() => saveAudio(current())}>
        Save audio
      </button>
    </>
  );
}
