/* The Web Audio edge.
 *
 * This is the ONLY file in dsp/ that touches a browser API, and that is a load-
 * bearing rule rather than a tidiness one: everything downstream of it takes a
 * Float32Array and a rate, which is why the whole analysis runs under Node in
 * the pure test tier and can be checked against the Python oracle.
 *
 * decodeAudioData handles wav, mp3, m4a, flac, ogg and opus with no work on our
 * part and nothing to install.
 *
 * The catch, and it is easy to miss: decodeAudioData ALWAYS resamples to the
 * sample rate of the context it is called on. A plain
 * `new AudioContext()` runs at whatever the hardware wants — 44.1 kHz on some
 * machines, 48 kHz on most, 96 kHz on an audio interface — so decoding the same
 * file on two machines would hand back two different signals. That is precisely
 * the machine-dependence the design is trying to avoid.
 *
 * So decoding happens in an OfflineAudioContext whose rate we choose:
 *   - a WAV says its own rate in its header, so it is decoded at that rate and
 *     no resampling happens at all. This is the case that matters, both because
 *     it is what a recorder and this app itself produce, and because it is what
 *     the Python oracle is compared against;
 *   - anything else is decoded at a fixed 48 kHz, so at least the answer does
 *     not depend on the machine. The tone is around 600 Hz — forty times below
 *     Nyquist even at 8 kHz — so a resample at this ratio cannot move a keying
 *     edge anywhere the envelope detector can see.
 */

import type { AudioClip } from "@/types";

/** Rate used for formats whose header we do not parse. Chosen for consistency
 *  across machines rather than for fidelity: any common rate would do, but it
 *  has to be the *same* one everywhere. */
export const FALLBACK_DECODE_RATE = 48000;

/** Sample rates a browser will accept for an OfflineAudioContext. Outside this
 *  the constructor throws, and a file claiming something absurd should fall
 *  back rather than take the app down. */
const MIN_RATE = 3000;
const MAX_RATE = 384000;

/** The sample rate declared in a RIFF/WAVE header, or null if this is not one.
 *
 * Only the fmt chunk is read; everything else about the file is left to the
 * browser, which is far better at it than twenty lines here would be. */
export function sniffWavRate(data: ArrayBuffer): number | null {
  if (data.byteLength < 44) return null;
  const view = new DataView(data);
  const tag = (off: number) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let off = 12;
  while (off + 8 <= data.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt " && off + 16 <= data.byteLength) {
      const rate = view.getUint32(off + 12, true);
      return rate >= MIN_RATE && rate <= MAX_RATE ? rate : null;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

function offlineCtor(): typeof OfflineAudioContext {
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Ctor) throw new Error("this browser has no Web Audio support");
  return Ctor;
}

/** Fold an AudioBuffer's channels to mono at whatever rate it carries. */
export function toMono(buffer: AudioBuffer): AudioClip {
  const n = buffer.length;
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(n);

  if (channels === 1) {
    buffer.copyFromChannel(out, 0);
  } else {
    const scratch = new Float32Array(n);
    for (let c = 0; c < channels; c++) {
      buffer.copyFromChannel(scratch, c);
      for (let i = 0; i < n; i++) out[i] = out[i]! + scratch[i]!;
    }
    for (let i = 0; i < n; i++) out[i] = out[i]! / channels;
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]!);
    if (a > peak) peak = a;
  }

  return { samples: out, rate: buffer.sampleRate, peak };
}

/** Decode any browser-supported audio file to a mono clip.
 *
 * The rate is the file's own for WAV, and FALLBACK_DECODE_RATE otherwise — see
 * the note at the top for why that is not a detail. */
export async function decodeAudioFile(data: ArrayBuffer): Promise<AudioClip> {
  const rate = sniffWavRate(data) ?? FALLBACK_DECODE_RATE;
  const Ctor = offlineCtor();
  // One frame is enough: the context exists only to fix the decode rate, and
  // nothing is ever rendered through it.
  const ctx = new Ctor(1, 1, rate);
  // decodeAudioData detaches the buffer it is handed, so it gets a copy and
  // the caller's bytes stay usable for playback and for a download.
  const buffer = await ctx.decodeAudioData(data.slice(0));
  return toMono(buffer);
}

/** Peak-normalize a clip for analysis.
 *
 * The Otsu threshold works on absolute amplitude, so the decoder wants this.
 * Anything meant for *listening* must not get it: on a quietly recorded clip it
 * is a 30 dB boost, and the recording should stay at the level it was made. */
export function normalized(clip: AudioClip): AudioClip {
  if (!(clip.peak > 0) || Math.abs(clip.peak - 1) < 1e-6) return clip;
  const out = new Float32Array(clip.samples.length);
  const k = 1 / clip.peak;
  for (let i = 0; i < out.length; i++) out[i] = clip.samples[i]! * k;
  return { samples: out, rate: clip.rate, peak: 1 };
}
