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
import type { Tape } from "@/live/tape";
import { micLog } from "@/micdebug";
import type { ListenAudio, ListenFlush, ListenLearn, ListenOut, ListenRange, ListenStart } from "./listen.worker";

const READ_EVERY_MS = 75;
/** A read this late is noted in the debug transcript, ms. */
const LATE_READ_MS = 1000;
/** No answer from the decoder for this long is noted, ms. */
const SILENT_MS = 3000;
/** The decoder this far behind the audio is noted, seconds. */
const BEHIND_SEC = 2;
/** How often the debug transcript gets a line on how listening goes, ms. */
const HEARTBEAT_MS = 10_000;

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

/** `words` are read by meaning: gaps near the word cut break where they make
 *  words. Words added while listening go to the worker as they come. The
 *  audio also goes on `tape`, for the Recording download. */
export function useListen(
  recorder: Recorder | null,
  calibration: Calibration | null,
  words: readonly string[],
  onFinal: (turns: LiveTurn[]) => void,
  tape?: Tape,
  /** Seconds of audio the recorder keeps: a read later than this loses
   *  audio. */
  keepSec = Infinity,
  /** The pitches to decode, Hz, or null for the whole band. */
  range: readonly [number, number] | null = null,
): Listening {
  const [state, setState] = useState<Listening>(NONE);
  const final = useRef(onFinal);
  final.current = onFinal;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const live = useRef<Worker | null>(null);
  const calKey = calibration ? calibration.releaseOffsetSec : null;

  useEffect(() => {
    const learn: ListenLearn = { type: "learn", words: [...words] };
    live.current?.postMessage(learn);
  }, [words]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const lo = range?.[0] ?? null;
  const hi = range?.[1] ?? null;
  useEffect(() => {
    const msg: ListenRange = { type: "range", range: lo === null || hi === null ? null : [lo, hi] };
    live.current?.postMessage(msg);
  }, [lo, hi]);

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
    // For the debug transcript: how listening goes.
    const rate = recorder.rate;
    let lastRead = performance.now();
    let lastAnswer = performance.now();
    let silent = false;
    let behind = false;
    let passes = 0;
    let slowest = 0;
    let finals = 0;
    let decoded = 0;
    let lastSignals = "";
    micLog("live: listening", { rate, session, words: wordsRef.current.length, keepSec });
    worker.onerror = (e) => micLog("live: the decoder failed", e.message || "no message");
    worker.onmessageerror = () => micLog("live: a message from the decoder could not be read");
    worker.onmessage = (ev: MessageEvent<ListenOut>) => {
      const msg = ev.data;
      if (msg.gen !== gen) return;
      if (msg.final.length) {
        finals += msg.final.length;
        for (const t of msg.final) micLog("live: line", `ch${t.ch} ${t.hz} Hz ${t.wpm} WPM ${t.t0.toFixed(1)}-${t.t1.toFixed(1)}s: ${t.text}`);
        final.current(msg.final.map(keep));
      }
      if (msg.type === "flushed") {
        micLog("live: stopped", { finals });
        worker.terminate();
        return;
      }
      if (msg.type === "failed") {
        micLog("live: a pass failed", msg.error);
        return;
      }
      const now = performance.now();
      if (silent) micLog("live: the decoder answered again", { afterMs: Math.round(now - lastAnswer) });
      silent = false;
      lastAnswer = now;
      passes++;
      slowest = Math.max(slowest, msg.passMs);
      decoded = msg.now;
      for (const n of msg.notes) micLog("live: decoder", n);
      const lag = read / rate - msg.now;
      if (lag > BEHIND_SEC && !behind) micLog("live: the decoder is behind", { lagSec: +lag.toFixed(1) });
      else if (lag <= BEHIND_SEC && behind) micLog("live: the decoder caught up");
      behind = lag > BEHIND_SEC;
      lastSignals = msg.signals.map((g) => `${Math.round(g.hz)}Hz/${g.wpm}wpm${g.keyed ? "*" : ""}`).join(" ");
      if (stopped) return;
      setState({ open: msg.open.map(place), signals: msg.signals, band: msg.band });
    };
    const heartbeat = setInterval(() => {
      micLog("live: heartbeat", {
        heardSec: +(read / rate).toFixed(1),
        decodedSec: +decoded.toFixed(1),
        passes,
        slowestMs: +slowest.toFixed(1),
        finals,
        signals: lastSignals,
        hidden: document.hidden,
      });
      passes = 0;
      slowest = 0;
    }, HEARTBEAT_MS);
    const seen = () => micLog(document.hidden ? "live: the page is hidden" : "live: the page is shown");
    document.addEventListener("visibilitychange", seen);
    const start: ListenStart = {
      type: "start",
      gen,
      rate: recorder.rate,
      calibration,
      words: [...wordsRef.current],
      range: rangeRef.current,
    };
    worker.postMessage(start);
    live.current = worker;
    tape?.start(recorder.rate, startedAt);
    const timer = setInterval(() => {
      const now = performance.now();
      const late = now - lastRead;
      lastRead = now;
      if (late > LATE_READ_MS) {
        micLog("live: the audio was read late", {
          lateMs: Math.round(late),
          hidden: document.hidden,
          ...(late / 1000 > keepSec ? { lostSec: +(late / 1000 - keepSec).toFixed(1) } : {}),
        });
      }
      if (!silent && read > 0 && now - lastAnswer > SILENT_MS) {
        silent = true;
        micLog("live: no answer from the decoder", { forMs: Math.round(now - lastAnswer), heardSec: +(read / rate).toFixed(1) });
      }
      const samples = recorder.since(read);
      if (samples.length === 0) return;
      read += samples.length;
      tape?.push(samples);
      const audio: ListenAudio = { type: "audio", samples };
      worker.postMessage(audio, [samples.buffer]);
    }, READ_EVERY_MS);

    return () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", seen);
      stopped = true;
      live.current = null;
      tape?.stop();
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
