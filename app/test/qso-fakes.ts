/* Stand-ins for the three ways the QSO page reaches past the page: the
 * microphone, the copy worker's thread and the speaker. Everything between
 * them is the real code: useRecorder, useLiveCopy's reads, the copy passes,
 * the LiveCopy decoder and QsoScreen itself.
 *
 * Time is Vitest's fake clock, performance.now included. The microphone
 * hands over the samples of a tone keyed on that clock, so the decoder hears
 * a QSO in the time it takes to decode one, not in the time it takes to
 * send one. The browser tier keeps a QSO in real audio, to show that the
 * real microphone, worker and speaker do their part.
 *
 * Each QSO test file wires these in with vi.mock and vi.stubGlobal. See
 * qso-rig.tsx.
 */

import { keyingPlan } from "@/audio/synth";
import { targetTiming } from "@/timing";
import type { BandGate, InputDevice, MicAccess, RecordOptions, Recorder } from "@/capture/mic";
import type { Player, PlayerCallbacks, TargetAir } from "@/audio/player";
import { copyPasses, type CopyAudio, type CopyRead, type CopyStart } from "@/ui/copyPass";

/** The microphone's rate. Low, as the decoder brings any rate down to its
 *  own, and every sample here is rendered on the page's thread. */
const RATE = 8000;
const TONE_HZ = 600;
const AMPLITUDE = 0.5;
/** A beat between a call to key and the first mark, as the keyer gave. */
const LEAD_SEC = 0.1;

/** Seconds on the fake clock. */
const now = (): number => performance.now() / 1000;

/** When the key was down, in seconds on the clock. */
let marks: (readonly [number, number])[] = [];
/** When the last thing keyed ends. Keying waits for it. */
let keyedTo = 0;

/** Key `text` at `wpm`, from a beat after now or after what is still being
 *  keyed. Returns when it ends, in seconds on the clock. */
export function keyOnClock(text: string, wpm: number): number {
  let t = Math.max(now() + LEAD_SEC, keyedTo);
  for (const [on, sec] of keyingPlan(text, targetTiming(wpm, wpm))) {
    if (on) marks.push([t, t + sec]);
    t += sec;
  }
  keyedTo = t;
  return t;
}

/** Whether the key is down at `t`. Marks are kept in time order, so this is a
 *  search, not a scan: a QSO is over a thousand marks. */
function down(t: number): boolean {
  let lo = 0;
  let hi = marks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = marks[mid]!;
    if (t < a) hi = mid - 1;
    else if (t >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The tone at `t` seconds on the clock: the key down, or silence. */
function sample(t: number): number {
  return down(t) ? AMPLITUDE * Math.sin(2 * Math.PI * TONE_HZ * t) : 0;
}

/** What the band gate was last told, what each of the station's lines
 *  played with, and each replay as a WAV, for a test to read. */
export const heard: {
  gate: { band: { samples: Float32Array; rate: number } | null; level: number; armed: boolean; delaySec: number };
  airs: (TargetAir | undefined)[];
  replays: ArrayBuffer[];
} = { gate: { band: null, level: 0, armed: false, delaySec: 0 }, airs: [], replays: [] };

/** The band gate, which only remembers. */
const gate: BandGate = {
  set: (band) => void (heard.gate.band = band),
  level: (gain) => void (heard.gate.level = gain),
  arm: (armed) => void (heard.gate.armed = armed),
  delay: (sec) => void (heard.gate.delaySec = sec),
};

/** A recorder on the fake clock. It records only what the test keys: the
 *  station's reply is not heard, as the page drops it anyway. */
class ClockRecorder implements Recorder {
  readonly rate = RATE;
  readonly band = gate;
  private began = now();
  private starts = 0;

  elapsed(): number {
    return now() - this.began;
  }

  peek(): Float32Array {
    return new Float32Array(0);
  }

  since(from: number): Float32Array {
    const to = Math.floor((now() - this.began) * RATE);
    const out = new Float32Array(Math.max(0, to - from));
    for (let i = 0; i < out.length; i++) out[i] = sample(this.began + (from + i) / RATE);
    return out;
  }

  restarts(): number {
    return this.starts;
  }

  restart(): void {
    this.began = now();
    this.starts++;
  }

  async stop() {
    return { samples: new Float32Array(0), rate: RATE, peak: 0 };
  }

  async cancel(): Promise<void> {}
}

/** `@/capture/mic` with a keyer for its one input. */
export function fakeMic<T extends object>(real: T) {
  return {
    ...real,
    listInputs: async (): Promise<InputDevice[]> => [{ deviceId: "keyer", label: "Keyer" }],
    requestMicAccess: async (): Promise<void> => {},
    watchMicAccess: (onChange: (access: MicAccess) => void): (() => void) => {
      onChange("granted");
      return () => {};
    },
    startRecording: async (_options?: RecordOptions): Promise<Recorder> => new ClockRecorder(),
  };
}

/** One frame, as the real player reports progress. */
const FRAME_MS = 16;

/** `@/audio/player` with a player that plays nothing, on the fake clock. It
 *  plays only the station's replies: the QSO page plays no recording. */
/** How long a line played again runs, in seconds. */
const REPLAY_SEC = 1;

export function fakePlayer<T extends object>(real: T) {
  return {
    ...real,
    createPlayer(callbacks: PlayerCallbacks = {}): Player {
      let frame: ReturnType<typeof setInterval> | null = null;
      const teardown = () => {
        if (frame !== null) clearInterval(frame);
        frame = null;
      };
      const finish = (reason: "done" | "stopped") => {
        const was = frame !== null;
        teardown();
        if (was) callbacks.onEnded?.(reason);
      };
      let gainDb = 0;
      return {
        // A line played again: a second on the fake clock, whatever it holds.
        async playBuffer(data) {
          if (data instanceof ArrayBuffer) heard.replays.push(data);
          teardown();
          const start = now();
          frame = setInterval(() => {
            if (now() - start >= REPLAY_SEC) finish("done");
          }, FRAME_MS);
        },
        playTarget(timeline, options) {
          teardown();
          heard.airs.push(options.air);
          // Its clock runs over the padding on either side, as the real one.
          const start = now() + options.padSec;
          const end = timeline.duration + options.padSec;
          frame = setInterval(() => {
            const t = now() - start;
            if (t >= end - 0.01) return finish("done");
            callbacks.onProgress?.(Math.max(t, 0), "tgt");
          }, FRAME_MS);
        },
        stop: () => finish("stopped"),
        wake() {},
        setGainDb(db) {
          gainDb = db;
        },
        gainDb: () => gainDb,
        playing: () => (frame !== null ? "tgt" : null),
        async renderTarget() {
          throw new Error("the QSO page renders no target");
        },
        destroy: teardown,
      };
    },
  };
}

/** The copy worker, run on the page. Its passes and their schedule are the
 *  real ones, on the fake clock. A reply crosses back a tick later, as one
 *  from a thread does. */
export class PageWorker {
  onmessage: ((ev: MessageEvent<CopyRead>) => void) | null = null;
  private readonly handle: (msg: CopyStart | CopyAudio) => void;
  private dead = false;

  constructor(url: URL | string) {
    if (!String(url).includes("copy.worker")) throw new Error(`no stand-in for the worker ${String(url)}`);
    this.handle = copyPasses((read) => {
      setTimeout(() => {
        if (!this.dead) this.onmessage?.({ data: read } as MessageEvent<CopyRead>);
      }, 0);
    });
  }

  postMessage(msg: CopyStart | CopyAudio): void {
    if (!this.dead) this.handle(msg);
  }

  terminate(): void {
    this.dead = true;
  }
}

/** A quiet key, for the next test. */
export function resetKey(): void {
  marks = [];
  keyedTo = 0;
  heard.gate = { band: null, level: 0, armed: false, delaySec: 0 };
  heard.airs = [];
  heard.replays = [];
}
