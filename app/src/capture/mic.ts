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

import type { AudioClip } from "@/types";

/** Source for the worklet, inlined so there is no second file to ship and no
 *  URL to get wrong under a different deploy base.
 *
 *  It forwards frames rather than accumulating them: a worklet that held a
 *  minute of audio would be holding it on the audio thread, where an allocation
 *  at the wrong moment is a dropped buffer and a dropped buffer is a shortened
 *  dit. */
const WORKLET_SOURCE = `
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
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('cw-capture', CaptureProcessor);
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
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
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
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
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
      const report = (): void => onChange(status.state as MicAccess);
      report();
      status.addEventListener("change", report);
      drop = () => status.removeEventListener("change", report);
    })
    .catch(() => {
      if (live) onChange("unknown");
    });
  return () => {
    live = false;
    drop();
  };
}

export interface Recorder {
  /** Seconds captured so far. */
  elapsed(): number;
  /** The most recent frames, for a level meter or a live waveform. */
  peek(): Float32Array;
  /** Stop, release the device, and hand back what was captured. */
  stop(): Promise<AudioClip>;
  /** Throw the take away and keep recording on the same open device. */
  restart(): void;
  /** Stop and release without producing a clip. */
  cancel(): Promise<void>;
}

export interface RecordOptions {
  readonly deviceId?: string | undefined;
  /** Called with the running length, a few times a second. */
  readonly onLevel?: (peak: number, seconds: number) => void;
  /** Safety cap so a forgotten tab cannot fill memory. */
  readonly maxSeconds?: number;
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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    },
    video: false,
  });

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("this browser has no Web Audio support");
  }
  const ctx = new Ctor();

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

  let chunks: Float32Array[] = [];
  let total = 0;
  let lastReport = 0;
  let stopped = false;
  const maxFrames = Math.ceil(maxSeconds * ctx.sampleRate);

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (stopped) return;
    const frame = ev.data;
    chunks.push(frame);
    total += frame.length;
    if (total >= maxFrames) {
      stopped = true;
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
    restart() {
      chunks = [];
      total = 0;
      lastReport = 0;
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
