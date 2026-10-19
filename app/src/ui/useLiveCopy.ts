/* What the sender has keyed so far in this over, while they key it.
 *
 * The recorder is read on a timer, as in useLiveProgress, and a worker
 * decodes it. A restart of the recorder starts a new over. While `listening`
 * is off, the audio is read and dropped: that is the other station's reply
 * coming back through the speakers, and it is not the sender's.
 */

import { useEffect, useRef, useState } from "react";
import type { Copy, CopyStats } from "@/timing/live";
import { micLog } from "@/micdebug";
import type { Calibration } from "@/dsp";
import type { CopyAudio, CopyRead, CopyStart } from "./copy.worker";
import type { LiveSource } from "./useLiveProgress";

const READ_EVERY_MS = 75;

/** A reading, and which over it is of. The count rises at each restart, so a
 *  page can answer each over once. */
export interface OverCopy extends Copy {
  readonly turn: number;
  /** Where the over's audio went, for the debug transcript. */
  readonly flow: Flow;
}

/** The audio of one over, counted at each step from the recorder to the
 *  decoder. Read from the recorder, it was sent to the worker or dropped
 *  while not listening; the worker says what it received. The worker counts
 *  at its last pass, so it trails what was sent by a chunk or two still on
 *  the way. A gap that grows is audio lost on the way. */
export interface Flow {
  readonly read: number;
  readonly sent: number;
  readonly dropped: number;
  readonly worker: CopyStats | null;
}

const NO_FLOW: Flow = { read: 0, sent: 0, dropped: 0, worker: null };
const NONE: OverCopy = { text: "", keying: null, over: false, sentWpm: null, turn: 0, flow: NO_FLOW };

/** The least time between two decoder lines in the transcript. */
const LOG_EVERY_MS = 1000;

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
    let sent = 0;
    let dropped = 0;
    let locked = false;
    let logged = 0;

    const begin = () => {
      gen++;
      read = 0;
      shown = "";
      sent = 0;
      dropped = 0;
      locked = false;
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
      const { text, keying, over, sentWpm, stats } = ev.data;
      const flow: Flow = { read, sent, dropped, worker: stats };
      if (stats?.locked && !locked) {
        locked = true;
        micLog("copy: tone locked", { toneHz: stats.toneHz, text });
      }
      const at = performance.now();
      if (stats && at - logged >= LOG_EVERY_MS) {
        logged = at;
        micLog("copy: pass", { text: text.slice(-40), keying, read, sent, dropped, ...stats });
      }
      const now = `${text}|${keying ?? ""}|${over}`;
      if (now === shown) return;
      shown = now;
      setCopy({ text, keying, over, sentWpm, turn: gen, flow });
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
      if (!hearing.current) {
        dropped += samples.length;
        return;
      }
      sent += samples.length;
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
