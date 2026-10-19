/* The microphone's side of the conversation, in order.
 *
 * `MicDebug` puts the current state on the screen, which is what you want on a
 * phone with no console. But the question left over is not a state, it is a
 * *sequence*: the permission sheet goes up, something is tapped, and what
 * matters is which of the browser's answers arrives first and whether the two
 * of them agree. A readout taken after the fact cannot show that, and the one
 * moment worth watching is over before there is anything to tap `re-read`
 * with.
 *
 * So: the same flag, `?micdebug`, and a line per event with the clock on it.
 *
 * The lines, and the last of the audio the decoder was given, are kept in
 * memory all the time, in rings that drop the oldest, and printed nowhere.
 * A fault is noticed after it starts, so what led up to it has to be there
 * already when somebody asks. The flag, or `__cwtMicDebug(true)` typed into
 * the console, turns the printing on, prints what is kept, and shows the
 * buttons that save it. Nothing leaves the page unless it is saved.
 *
 * Not `console.error`, and not only because the tests fail on that: none of
 * these is a fault. They are a transcript.
 */

/** The tab's own switch, set from the console, so a reload keeps it. */
const SESSION_KEY = "cwt:micdebug";

/** Fired on `window` when the switch changes, for what shows only with it. */
export const MIC_DEBUG_EVENT = "cwt-micdebug";

/** Whether the URL or the console asked for the transcript.
 *
 * Read each time rather than cached at import. Vite replaces modules in place
 * while the page is open, so a value captured once belongs to whichever copy
 * of this file happened to load first — and this is a debugging aid being read
 * on a device that is being hot-updated as it is used. */
export function micDebugOn(): boolean {
  if (typeof location === "undefined") return false;
  if (new URLSearchParams(location.search).has("micdebug")) return true;
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1" || sessionOnly;
  } catch {
    return sessionOnly;
  }
}

/** Turn the transcript on or off for this tab. On, what is kept so far is
 *  printed at once. */
export function setMicDebug(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "1");
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* no session storage: the switch lasts until the page goes */
    sessionOnly = on;
  }
  if (on) {
    console.info(`[mic] the transcript so far, ${transcript.length} lines:\n${micTranscript()}`);
    console.info(`[mic] ${audio.length} stretches of audio kept, ${Math.round(keptSec())}s.`);
  }
  window.dispatchEvent(new Event(MIC_DEBUG_EVENT));
}

/** The switch, where session storage cannot hold it. */
let sessionOnly = false;

/** One line of the transcript: the moment, the event, and whatever detail the
 *  caller has that is worth reading at 3am on a phone. Always kept; printed
 *  with the switch on. */
export function micLog(event: string, detail?: unknown): void {
  const at = typeof performance === "undefined" ? 0 : performance.now();
  const stamp = `${(at / 1000).toFixed(3)}s`;
  transcript.push(detail === undefined ? `[${stamp}] ${event}` : `[${stamp}] ${event} ${flat(detail)}`);
  if (transcript.length > TRANSCRIPT_MAX) transcript.splice(0, transcript.length - TRANSCRIPT_MAX);
  if (!micDebugOn()) return;
  if (detail === undefined) console.info(`[mic ${stamp}] ${event}`);
  else console.info(`[mic ${stamp}] ${event}`, detail);
}

/** Lines kept. Older lines go first. */
const TRANSCRIPT_MAX = 5000;
const transcript: string[] = [];

/** A detail as one line of text. */
function flat(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** The transcript so far, one event a line. */
export function micTranscript(): string {
  return transcript.join("\n");
}

/** A stretch of captured audio, as the decoder was given it. */
export interface DebugAudio {
  readonly label: string;
  readonly rate: number;
  readonly samples: Float32Array;
}

/** Seconds of audio kept. Older stretches go first. Kept as 16-bit
 *  samples, half the memory of floats: two minutes at 48 kHz is 11 MB. */
const AUDIO_MAX_SEC = 120;
const audio: { label: string; rate: number; samples: Int16Array }[] = [];

function keptSec(): number {
  return audio.reduce((t, a) => t + a.samples.length / a.rate, 0);
}

/** Keep a copy of `samples`, with a label to find it by. */
export function keepDebugAudio(label: string, samples: Float32Array, rate: number): void {
  if (samples.length === 0) return;
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = Math.round(x * 32767);
  }
  audio.push({ label, rate, samples: pcm });
  let sec = keptSec();
  while (sec > AUDIO_MAX_SEC && audio.length > 1) {
    const gone = audio.shift()!;
    sec -= gone.samples.length / gone.rate;
  }
}

/** The audio kept so far, oldest first. */
export function debugAudio(): DebugAudio[] {
  return audio.map((a) => ({
    label: a.label,
    rate: a.rate,
    samples: Float32Array.from(a.samples, (x) => x / 32767),
  }));
}

/* The console's way in: `__cwtMicDebug(true)` or `__cwtMicDebug(false)`. */
if (typeof window !== "undefined") {
  (window as unknown as { __cwtMicDebug?: (on?: boolean) => string }).__cwtMicDebug = (on = true) => {
    setMicDebug(on);
    return on
      ? "Mic debug on. The QSO page shows Save log and Save audio."
      : "Mic debug off.";
  };
}

/** A device list, flattened to something readable in a console line.
 *
 * Empty strings are spelled rather than shown as gaps: "the label is missing"
 * and "the label is a space" look identical in a log and mean different
 * things, and the missing one is the whole subject here. */
export function describeInputs(devices: MediaDeviceInfo[]): string {
  const inputs = devices.filter((d) => d.kind === "audioinput");
  if (inputs.length === 0) return "(no audioinput entries)";
  return inputs
    .map((d) => `{id:${d.deviceId ? `${d.deviceId.slice(0, 8)}…` : "(empty)"} label:${d.label || "(empty)"}}`)
    .join(" ");
}
