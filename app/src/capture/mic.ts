/* Recording from the microphone.
 *
 * getUserMedia plus an AudioWorklet, rather than MediaRecorder: MediaRecorder
 * hands back a compressed blob in a format the browser chooses, and lossy
 * compression around a keyed tone is exactly the wrong thing to measure keying
 * from. The worklet gives raw float frames at the device's own rate, which is
 * what the rest of the pipeline wants anyway.
 *
 * A virtual loopback device — BlackHole, Loopback, VB-Cable — appears in
 * `listInputs()` like any other input, so keying an app on the same machine and
 * recording it works the way it does on the command line.
 */

import { describeInputs, micLog } from "@/micdebug";
import type { AudioClip } from "@/types";

/** A block is keying when its peak is this many times the input's quiet
 *  floor between marks. */
const KEY_RATIO = 6;

/** Nor ever under this peak, so a silent line in does not key on a hiss. */
const KEY_MIN = 0.002;

/** How fast the floor climbs to a louder quiet, a share each block. It falls
 *  at once. */
const FLOOR_RISE = 0.002;

/** Source for the worklet, inlined so there is no second file to ship and no
 *  URL to get wrong under a different deploy base.
 *
 *  It forwards frames rather than accumulating them: a worklet that held a
 *  minute of audio would be holding it on the audio thread, where an allocation
 *  at the wrong moment is a dropped buffer and a dropped buffer is a shortened
 *  dit. Exported for the tests, which run it on a stand-in audio thread. */
export const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      // Fold to mono here so only one channel crosses the thread boundary.
      const channels = input.length;
      const n = input[0].length;
      const out = new Float32Array(n);
      for (let c = 0; c < channels; c++) {
        const ch = input[c];
        for (let i = 0; i < n; i++) out[i] += ch[i];
      }
      if (channels > 1) for (let i = 0; i < n; i++) out[i] /= channels;
      // With the frame clock, so the page can tell a block the audio thread
      // never delivered from one that arrived late.
      this.port.postMessage({ at: currentFrame, out }, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('cw-capture', CaptureProcessor);

/* The band, cut the moment you key: see BandGate in mic.ts. Its input is the
   microphone; its output is the band, looped, at the level it is given. */
class BandGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = null;
    this.step = 1;
    this.pos = 0;
    this.level = 0;
    this.gain = 0;
    this.delay = 0;
    this.armed = false;
    this.hang = 0;
    this.floor = -1;
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'band') {
        this.samples = m.samples;
        this.step = m.samples ? m.rate / sampleRate : 1;
        this.pos = 0;
      } else if (m.type === 'level') this.level = m.level;
      else if (m.type === 'delay') this.delay = m.sec;
      else if (m.type === 'arm') this.armed = m.armed;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const mic = inputs[0] && inputs[0][0];
    // Keying, from this block alone: its peak well over the quiet floor.
    let peak = 0;
    if (mic) for (let i = 0; i < mic.length; i++) { const a = Math.abs(mic[i]); if (a > peak) peak = a; }
    if (this.floor < 0 || peak < this.floor) this.floor = peak;
    const keyed = this.armed && peak > Math.max(${KEY_MIN}, this.floor * ${KEY_RATIO});
    if (keyed) this.hang = this.delay * sampleRate;
    else this.floor += (peak - this.floor) * ${FLOOR_RISE};
    const cut = keyed || this.hang > 0;
    const target = cut ? 0 : this.level;
    // Down in a millisecond, back in five: quick, as a receiver is, but
    // without a click.
    const rate = target < this.gain ? 1 / (0.001 * sampleRate) : 1 / (0.005 * sampleRate);
    const band = this.samples;
    const n = band ? band.length : 0;
    for (let i = 0; i < out.length; i++) {
      if (this.gain < target) this.gain = Math.min(target, this.gain + rate * Math.max(this.level, 1e-6));
      else if (this.gain > target) this.gain = Math.max(target, this.gain - rate * Math.max(this.level, 1e-6));
      if (n === 0 || this.gain === 0) { out[i] = 0; } else {
        const j = Math.floor(this.pos);
        const f = this.pos - j;
        const a = band[j];
        const b = band[j + 1 < n ? j + 1 : 0];
        out[i] = (a + (b - a) * f) * this.gain;
      }
      if (n > 0) { this.pos += this.step; if (this.pos >= n) this.pos -= n; }
    }
    this.hang = Math.max(0, this.hang - out.length);
    return true;
  }
}
registerProcessor('cw-band-gate', BandGateProcessor);
`;

export interface InputDevice {
  deviceId: string;
  label: string;
}

/** Every audio input the browser will admit to.
 *
 * Labels are empty until permission has been granted at least once — that is
 * the browser refusing to let a page fingerprint the hardware, not a bug, and
 * the UI says so rather than showing a list of blanks. */
export async function listInputs(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    micLog("enumerateDevices: not available");
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  micLog("enumerateDevices →", describeInputs(devices));
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Input ${i + 1}`,
    }));
}

/** Ask for the microphone, and hand it straight back.
 *
 * There is no "request" on the Permissions API for a microphone, so raising
 * the prompt means opening a device — and this opens one only to be told yes
 * or no, then stops the track. Nothing is captured and nothing is kept.
 *
 * Plain `{ audio: true }` rather than the constraints `startRecording` uses:
 * none of them matter to a stream that is about to be thrown away, and asking
 * for a particular device here would mean naming one while the names are
 * still being withheld — which is the very thing this call exists to fix.
 *
 * Rejects the way `getUserMedia` does, so a refusal reads the same whether it
 * arrived here or on the first take.
 */
export async function requestMicAccess(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this browser cannot record audio");
  }
  micLog("requestMicAccess: asking for { audio: true }");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micLog("requestMicAccess: granted — stopping the tracks it opened");
  for (const track of stream.getTracks()) track.stop();
  micLog("requestMicAccess: tracks stopped");
}

/** What the browser will say about the microphone before one is opened.
 *
 * "unknown" is not "prompt": it means the browser would not answer the
 * question — Firefox and Safari do not, for the microphone — and there the
 * only way to find out is to ask for a device and see what happens. Nothing
 * should be claimed on the page either way. */
export type MicAccess = "granted" | "denied" | "prompt" | "unknown";

/** Watch the microphone permission, and say so whenever it changes.
 *
 * Worth watching rather than reading once, because the interesting change
 * happens somewhere this page cannot see: you go into the browser's site
 * settings, allow the microphone, and come back. Chromium fires the change on
 * the permission status, so the page can stop saying it is blocked without
 * being reloaded.
 *
 * Returns an unsubscribe. */
export function watchMicAccess(onChange: (access: MicAccess) => void): () => void {
  const perms = navigator.permissions;
  if (!perms?.query) {
    micLog("permissions.query: no navigator.permissions on this browser");
    onChange("unknown");
    return () => {};
  }
  let live = true;
  let drop = (): void => {};
  perms
    // Not in the standard permission-name union, and the browsers that do not
    // know it reject rather than returning a state.
    .query({ name: "microphone" as PermissionName })
    .then((status) => {
      if (!live) return;
      micLog(`permissions.query resolved → "${status.state}"`);
      let first = true;
      const report = (): void => {
        // The first call is this code reading the answer; every one after it
        // is the browser volunteering a change, which is the interesting kind.
        if (!first) micLog(`permissions change → "${status.state}"`);
        first = false;
        onChange(status.state as MicAccess);
      };
      report();
      status.addEventListener("change", report);
      drop = () => status.removeEventListener("change", report);
    })
    .catch((e: unknown) => {
      micLog(
        "permissions.query rejected",
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      );
      if (live) onChange("unknown");
    });
  return () => {
    live = false;
    drop();
  };
}

/** Seconds after the device opens that are kept as silence. An interface can
 *  thump as it starts, and a filter on the line rings with it as a short,
 *  faint tone, which reads as a dit. Nobody keys this soon. */
export const SETTLE_SEC = 0.5;

export interface Recorder {
  /** Seconds captured so far. */
  elapsed(): number;
  /** The most recent frames, for a level meter or a live waveform. */
  peek(): Float32Array;
  /** The capture rate, in samples per second. */
  readonly rate: number;
  /** Everything captured from sample `from` on, as one copy. Read on a timer
   *  by whatever follows the take while it runs. */
  since(from: number): Float32Array;
  /** How many times the take has been started over. A reader that sees this
   *  change starts again from sample 0. */
  restarts(): number;
  /** Stop, release the device, and hand back what was captured. */
  stop(): Promise<AudioClip>;
  /** Throw the take away and keep recording on the same open device. */
  restart(): void;
  /** Stop and release without producing a clip. */
  cancel(): Promise<void>;
  /** The band, played beside the recording. */
  readonly band?: BandGate;
}

/** The band played from the recorder's own audio context, as a receiver
 *  plays it: cut the moment you key, on the audio thread, with nothing in
 *  between. On the page's thread, the cut came a beat late.
 *
 *  It comes back once you have not keyed for the break-in delay, as a
 *  radio's receiver does. */
export interface BandGate {
  /** The band's track, which loops, or null for none. */
  set(band: { samples: Float32Array; rate: number } | null): void;
  /** The playback level, as a gain. 0 is silent. */
  level(gain: number): void;
  /** The break-in delay, in seconds. 0 is full break-in: the band is heard
   *  between your marks. */
  delay(sec: number): void;
  /** Cut on keying only while armed: while the page listens for you, not
   *  while a station plays and the microphone may hear it. */
  arm(armed: boolean): void;
}

export interface RecordOptions {
  readonly deviceId?: string | undefined;
  /** Called with the running length, a few times a second. */
  readonly onLevel?: (peak: number, seconds: number) => void;
  /** Safety cap so a forgotten tab cannot fill memory. */
  readonly maxSeconds?: number | undefined;
  /** Called once when the recording reaches `maxSeconds`. */
  readonly onLimit?: () => void;
}

export const DEFAULT_MAX_SECONDS = 300;

export async function startRecording(options: RecordOptions = {}): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this browser cannot record audio");
  }

  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;

  /* Every processing feature off. Echo cancellation and noise suppression are
     built to protect speech and they treat a steady tone as noise to be removed
     — they will gate a long dah and shorten every mark. Auto gain moves the
     level under the threshold detector while it is measuring. None of these are
     defaults you can leave alone for this job. */
  micLog("startRecording: opening a device", options.deviceId ?? "(default input)");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    },
    video: false,
  });

  micLog("startRecording: device open");
  {
    // What the browser actually gave, which is not always what was asked:
    // a processing feature left on changes every mark.
    const track = stream.getAudioTracks()[0];
    micLog("startRecording: track", {
      label: track?.label ?? "(none)",
      settings: track?.getSettings?.() ?? null,
    });
    track?.addEventListener("mute", () => micLog("track muted"));
    track?.addEventListener("unmute", () => micLog("track unmuted"));
    track?.addEventListener("ended", () => micLog("track ended"));
  }

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("this browser has no Web Audio support");
  }
  const ctx = new Ctor();
  micLog("startRecording: context", {
    sampleRate: ctx.sampleRate,
    baseLatency: ctx.baseLatency,
    state: ctx.state,
  });
  ctx.addEventListener("statechange", () => micLog("context state", ctx.state));

  const blobUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "cw-capture");
  source.connect(node);
  // A worklet with no destination is not pulled in some browsers, so give it
  // one that emits nothing rather than routing the microphone to the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  const gate = new AudioWorkletNode(ctx, "cw-band-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  source.connect(gate);
  gate.connect(ctx.destination);
  const band: BandGate = {
    set: (b) => gate.port.postMessage({ type: "band", samples: b?.samples ?? null, rate: b?.rate ?? 0 }),
    level: (gain) => gate.port.postMessage({ type: "level", level: gain }),
    delay: (sec) => gate.port.postMessage({ type: "delay", sec }),
    arm: (armed) => gate.port.postMessage({ type: "arm", armed }),
  };

  let chunks: Float32Array[] = [];
  let total = 0;
  let restarts = 0;
  let lastReport = 0;
  let stopped = false;
  const maxFrames = Math.ceil(maxSeconds * ctx.sampleRate);
  // Counted from the device opening, not from a restart: see `SETTLE_SEC`.
  const settleFrames = Math.round(SETTLE_SEC * ctx.sampleRate);
  let opened = 0;

  // Always watched: the transcript keeps it, printed or not.
  const health = captureHealth(ctx.sampleRate);
  node.port.onmessage = (ev: MessageEvent<{ at: number; out: Float32Array }>) => {
    if (stopped) return;
    const frame = ev.data.out;
    health(ev.data.at, frame);
    if (opened < settleFrames) frame.fill(0, 0, Math.min(frame.length, settleFrames - opened));
    opened += frame.length;
    chunks.push(frame);
    total += frame.length;
    if (total >= maxFrames) {
      stopped = true;
      options.onLimit?.();
      return;
    }
    if (total - lastReport > ctx.sampleRate / 8) {
      lastReport = total;
      let peak = 0;
      for (let i = 0; i < frame.length; i++) {
        const a = Math.abs(frame[i]!);
        if (a > peak) peak = a;
      }
      options.onLevel?.(peak, total / ctx.sampleRate);
    }
  };

  async function release(): Promise<void> {
    stopped = true;
    node.port.onmessage = null;
    node.disconnect();
    gate.disconnect();
    source.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }

  function collect(): AudioClip {
    const samples = new Float32Array(total);
    let at = 0;
    for (const c of chunks) {
      samples.set(c, at);
      at += c.length;
    }
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]!);
      if (a > peak) peak = a;
    }
    return { samples, rate: ctx.sampleRate, peak };
  }

  return {
    elapsed: () => total / ctx.sampleRate,
    peek: () => chunks[chunks.length - 1] ?? new Float32Array(0),
    rate: ctx.sampleRate,
    since(from) {
      const out = new Float32Array(Math.max(0, total - from));
      // From the newest chunk back, so a read costs what it returns and not
      // the length of the take.
      let end = total;
      let at = out.length;
      for (let i = chunks.length - 1; i >= 0 && end > from; i--) {
        const c = chunks[i]!;
        const start = end - c.length;
        const part = start >= from ? c : c.subarray(from - start);
        at -= part.length;
        out.set(part, at);
        end = start;
      }
      return out;
    },
    band,
    restarts: () => restarts,
    restart() {
      chunks = [];
      total = 0;
      lastReport = 0;
      restarts++;
    },
    async stop() {
      const clip = collect();
      await release();
      return clip;
    },
    async cancel() {
      chunks = [];
      total = 0;
      await release();
    },
  };
}

/** Watch the capture for what would garble the keying, and say so in the
 *  transcript. Audio the audio thread skipped, blocks
 *  that arrive in bursts, a change of block size, and sudden jumps between
 *  one sample and the next, which are clicks, are each counted. A summary
 *  line every five seconds gives the counts and the level. */
function captureHealth(rate: number): (at: number, frame: Float32Array) => void {
  const SUMMARY_SEC = 5;
  /** A step this large between two samples is a click, not a tone. */
  const JUMP = 0.25;
  let expected: number | null = null;
  let lastMs = 0;
  let last = 0;
  let size = 0;
  let frames = 0;
  let skipped = 0;
  let jumps = 0;
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  let maxGapMs = 0;
  let since = 0;
  return (at, frame) => {
    const now = performance.now();
    if (expected !== null && at !== expected) {
      micLog("capture: audio skipped", { frames: at - expected, ms: ((at - expected) / rate) * 1000 });
      skipped += Math.max(0, at - expected);
    }
    expected = at + frame.length;
    if (frame.length !== size) {
      micLog("capture: block size", frame.length);
      size = frame.length;
    }
    if (lastMs) maxGapMs = Math.max(maxGapMs, now - lastMs);
    lastMs = now;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i]!;
      if (Math.abs(x - last) > JUMP) jumps++;
      last = x;
      const a = Math.abs(x);
      if (a > peak) peak = a;
      sumSq += x * x;
    }
    count += frame.length;
    frames++;
    since += frame.length;
    if (since >= SUMMARY_SEC * rate) {
      micLog("capture: summary", {
        blocks: frames,
        skippedFrames: skipped,
        clicks: jumps,
        peak: Number(peak.toFixed(4)),
        rms: Number(Math.sqrt(sumSq / Math.max(1, count)).toFixed(5)),
        longestWaitMs: Math.round(maxGapMs),
      });
      since = 0;
      frames = 0;
      skipped = 0;
      jumps = 0;
      peak = 0;
      sumSq = 0;
      count = 0;
      maxGapMs = 0;
    }
  };
}
