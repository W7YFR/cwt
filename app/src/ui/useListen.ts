/* Live decoding of the recorder, for the Live page.
 *
 * The recorder is read on a timer and its audio goes to the worker. Final
 * turns go to `onFinal` as they come, placed in time. When the recorder goes
 * away, the worker reads every open turn to the end and those go to `onFinal`
 * too, so nothing heard is lost.
 */

import { useEffect, useRef, useState } from "react";
import type { Recorder } from "@/capture/mic";
import type { Calibration } from "@/dsp";
import type { Band, Signal, Turn } from "@/live/decoder";
import type { LiveTurn } from "@/live/log";
import type { ListenAudio, ListenFlush, ListenOut, ListenStart } from "./listen.worker";

const READ_EVERY_MS = 75;

/** A turn still going on, placed in time, with the character being keyed. */
export interface OpenTurn extends LiveTurn {
  readonly keying: string | null;
}

export interface Listening {
  readonly open: readonly OpenTurn[];
  readonly signals: readonly Signal[];
  readonly band: Band | null;
}

const NONE: Listening = { open: [], signals: [], band: null };

/** Each session's turns and signals get ids of their own. */
let sessions = 0;

export function useListen(
  recorder: Recorder | null,
  calibration: Calibration | null,
  onFinal: (turns: LiveTurn[]) => void,
): Listening {
  const [state, setState] = useState<Listening>(NONE);
  const final = useRef(onFinal);
  final.current = onFinal;
  const calKey = calibration ? calibration.releaseOffsetSec : null;

  useEffect(() => {
    setState(NONE);
    if (!recorder) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./listen.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return;
    }
    const session = `${Date.now().toString(36)}${(++sessions).toString(36)}`;
    // The wall clock at the recorder's first sample.
    const startedAt = Date.now() - recorder.elapsed() * 1000;
    const place = (t: Turn): OpenTurn => ({
      id: `${session}-${t.id}`,
      chan: `${session}-${t.ch}`,
      hz: t.hz,
      at: Math.round(startedAt + t.t0 * 1000),
      end: Math.round(startedAt + t.t1 * 1000),
      text: t.text,
      wpm: t.wpm,
      db: t.db,
      keying: t.keying,
    });
    const keep = (t: Turn): LiveTurn => {
      const { keying: _keying, ...rest } = place(t);
      return rest;
    };

    const gen = 1;
    let read = 0;
    let stopped = false;
    worker.onmessage = (ev: MessageEvent<ListenOut>) => {
      const msg = ev.data;
      if (msg.gen !== gen) return;
      if (msg.final.length) final.current(msg.final.map(keep));
      if (msg.type === "flushed") {
        worker.terminate();
        return;
      }
      if (stopped) return;
      setState({ open: msg.open.map(place), signals: msg.signals, band: msg.band });
    };
    const start: ListenStart = { type: "start", gen, rate: recorder.rate, calibration };
    worker.postMessage(start);
    const timer = setInterval(() => {
      const samples = recorder.since(read);
      if (samples.length === 0) return;
      read += samples.length;
      const audio: ListenAudio = { type: "audio", samples };
      worker.postMessage(audio, [samples.buffer]);
    }, READ_EVERY_MS);

    return () => {
      clearInterval(timer);
      stopped = true;
      setState(NONE);
      // What is still open is read to the end, then the worker goes.
      const flush: ListenFlush = { type: "flush" };
      worker.postMessage(flush);
      setTimeout(() => worker.terminate(), 5000);
    };
    // The calibration is read when listening starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, calKey]);

  return recorder ? state : NONE;
}
