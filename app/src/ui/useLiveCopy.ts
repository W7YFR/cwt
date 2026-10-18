/* What the sender has keyed so far in this over, while they key it.
 *
 * The recorder is read on a timer, as in useLiveProgress, and a worker
 * decodes it. A restart of the recorder starts a new over. While `listening`
 * is off, the audio is read and dropped: that is the other station's reply
 * coming back through the speakers, and it is not the sender's.
 */

import { useEffect, useRef, useState } from "react";
import type { Copy } from "@/timing/live";
import type { Calibration } from "@/dsp";
import type { CopyAudio, CopyRead, CopyStart } from "./copy.worker";
import type { LiveSource } from "./useLiveProgress";

const READ_EVERY_MS = 75;

/** A reading, and which over it is of. The count rises at each restart, so a
 *  page can answer each over once. */
export interface OverCopy extends Copy {
  readonly turn: number;
}

const NONE: OverCopy = { text: "", keying: null, over: false, sentWpm: null, turn: 0 };

/** With `lenient`, the over is read at the sender's own timing once there is
 *  enough of it to measure. With `calibration`, its edges are corrected for
 *  the microphone path. Either takes effect at the next over. */
export function useLiveCopy(
  source: LiveSource | null,
  listening: boolean,
  lenient: boolean,
  calibration: Calibration | null = null,
): OverCopy {
  const [copy, setCopy] = useState<OverCopy>(NONE);
  const recorder = source?.recorder ?? null;
  const charWpm = source?.charWpm ?? 0;
  const farnsworthWpm = source?.farnsworthWpm ?? 0;
  // Read by the timer, so a change does not tear the worker down.
  const hearing = useRef(listening);
  hearing.current = listening;
  const loose = useRef(lenient);
  loose.current = lenient;
  const correction = useRef(calibration);
  correction.current = calibration;

  useEffect(() => {
    setCopy(NONE);
    if (!recorder) return;

    let worker: Worker;
    try {
      worker = new Worker(new URL("./copy.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return;
    }

    let gen = 0;
    let read = 0;
    let restarts = recorder.restarts();
    let shown = "";

    const begin = () => {
      gen++;
      read = 0;
      shown = "";
      setCopy({ ...NONE, turn: gen });
      const start: CopyStart = {
        type: "start",
        gen,
        rate: recorder.rate,
        charWpm,
        farnsworthWpm,
        lenient: loose.current,
        calibration: correction.current,
      };
      worker.postMessage(start);
    };

    worker.onmessage = (ev: MessageEvent<CopyRead>) => {
      if (ev.data.gen !== gen) return;
      const { text, keying, over, sentWpm } = ev.data;
      const now = `${text}|${keying ?? ""}|${over}`;
      if (now === shown) return;
      shown = now;
      setCopy({ text, keying, over, sentWpm, turn: gen });
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
      if (!hearing.current) return;
      const audio: CopyAudio = { type: "audio", samples };
      worker.postMessage(audio, [samples.buffer]);
    }, READ_EVERY_MS);

    return () => {
      clearInterval(timer);
      worker.terminate();
    };
  }, [recorder, charWpm, farnsworthWpm]);

  return recorder ? copy : NONE;
}
