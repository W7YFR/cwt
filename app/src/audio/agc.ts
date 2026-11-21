/* The receiver's AGC: it turns the gain down under a loud sound, and back
 * up after it, so what you hear stays at one level. Under a strong signal
 * the band goes quiet; between its characters and words the band comes
 * back up.
 *
 * Measured from a recording of a real receiver on fast AGC: a strong FT8
 * signal pulled the noise down about 19 dB within 20 ms, and the noise was
 * back within about 80 ms of the signal stopping.
 *
 * The gain is worked out a step at a time, from the loudest sound a little
 * ahead, so it is down before a sound starts and a sound after quiet does
 * not pop. Pure.
 */

/** The AGC's settings. */
export const AGC_MODES = ["off", "slow", "fast"] as const;
export type AgcMode = (typeof AGC_MODES)[number];

/** How fast the gain comes back up after a loud sound: its time constant,
 *  in seconds. */
const RECOVER_SEC: Record<Exclude<AgcMode, "off">, number> = { slow: 0.4, fast: 0.03 };

/** The most the gain rises over its level under the station, in dB. */
export const AGC_RISE_DB = 20;

/** How far ahead the AGC hears, in seconds. */
const LOOK_SEC = 0.01;

/** The step the gain is worked out in, in seconds. */
export const AGC_STEP_SEC = 0.001;

/** The loudest of `x` a little ahead of each step, in dB over `ref`. A
 *  silent step is -Infinity. With `heard`, each sample counts at that share:
 *  0 where the receiver hears nothing. */
export function loudnessDb(x: Float32Array, rate: number, ref: number, heard?: Float32Array): Float32Array {
  const block = Math.max(1, Math.round(AGC_STEP_SEC * rate));
  const steps = Math.ceil(x.length / block);
  const peaks = new Float32Array(steps);
  for (let j = 0; j < steps; j++) {
    let p = 0;
    for (let i = j * block; i < Math.min((j + 1) * block, x.length); i++) {
      p = Math.max(p, Math.abs(x[i]!) * (heard ? heard[i]! : 1));
    }
    peaks[j] = p;
  }
  const look = Math.round(LOOK_SEC / AGC_STEP_SEC);
  const out = new Float32Array(steps);
  for (let j = 0; j < steps; j++) {
    let p = 0;
    for (let k = j; k < Math.min(j + look, steps); k++) p = Math.max(p, peaks[k]!);
    out[j] = 20 * Math.log10(p / ref);
  }
  return out;
}

/** The AGC's gain at each step, in dB, for sound `loudDb` loud at each step
 *  (as `loudnessDb` gives it): down at once to hold the loudest at 0 dB,
 *  and back up at `mode`'s pace, by `AGC_RISE_DB` at most. */
export function agcGainDb(loudDb: Float32Array, mode: AgcMode): Float32Array {
  const out = new Float32Array(loudDb.length);
  if (mode === "off") return out;
  const k = 1 - Math.exp(-AGC_STEP_SEC / RECOVER_SEC[mode]);
  let g = Math.min(AGC_RISE_DB, -loudDb[0]!);
  for (let j = 0; j < loudDb.length; j++) {
    const target = Math.min(AGC_RISE_DB, -loudDb[j]!);
    g = target < g ? target : g + (target - g) * k;
    out[j] = g;
  }
  return out;
}

/** `x` at the gain `gainDb` gives each step, in place: a step every
 *  `AGC_STEP_SEC`, in a straight line between steps. */
export function applyGainDb(x: Float32Array, rate: number, gainDb: Float32Array): void {
  const block = Math.max(1, Math.round(AGC_STEP_SEC * rate));
  const lin = gainDb.map((db) => Math.pow(10, db / 20));
  for (let j = 0; j < lin.length; j++) {
    const a = lin[j]!;
    const z = lin[Math.min(lin.length - 1, j + 1)]!;
    for (let k = 0, i = j * block; k < block && i < x.length; k++, i++) x[i] = x[i]! * (a + ((z - a) * k) / block);
  }
}

/** `x` through the AGC, in place, holding its loudest at `ref`. */
export function agc(x: Float32Array, rate: number, ref: number, mode: AgcMode): void {
  if (mode !== "off") applyGainDb(x, rate, agcGainDb(loudnessDb(x, rate, ref), mode));
}

/** How loud `loudDb` mostly is: its middle value, over the steps that hold
 *  any sound. -Infinity when none does. */
export function typicalDb(loudDb: Float32Array): number {
  const heard = Array.from(loudDb).filter(Number.isFinite).sort((a, b) => a - b);
  return heard.length > 0 ? heard[heard.length >> 1]! : -Infinity;
}

/** The AGC's gain on the band on its own, in dB, when it is `bandDb` loud. */
export function bandGainDb(bandDb: number): number {
  return Math.min(AGC_RISE_DB, -bandDb);
}

/** The AGC's gain at each step of `durSec`, in dB, for a station keyed over
 *  `marks` (start and end, in seconds) at `fade` (a share, by seconds from
 *  the start), over a band `bandDb` loud on its own. */
export function keyedGainDb(
  marks: readonly (readonly [number, number])[],
  durSec: number,
  fade: (tSec: number) => number,
  bandDb: number,
  mode: AgcMode,
): Float32Array {
  const steps = Math.max(2, Math.ceil(durSec / AGC_STEP_SEC));
  const keyed = new Uint8Array(steps);
  for (const [a, z] of marks) {
    for (let j = Math.floor(a / AGC_STEP_SEC); j < Math.min(steps, Math.ceil(z / AGC_STEP_SEC)); j++) keyed[j] = 1;
  }
  const look = Math.round(LOOK_SEC / AGC_STEP_SEC);
  const band = Math.pow(10, bandDb / 20);
  const loudDb = new Float32Array(steps);
  for (let j = 0; j < steps; j++) {
    let on = 0;
    for (let k = j; k < Math.min(j + look, steps); k++) on = Math.max(on, keyed[k]!);
    loudDb[j] = 20 * Math.log10(on * fade(j * AGC_STEP_SEC) + band);
  }
  return agcGainDb(loudDb, mode);
}
