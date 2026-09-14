/* A minimal RIFF/WAVE reader, for tests only.
 *
 * The app never needs this — the browser's decodeAudioData handles wav along
 * with everything else. But the pure test tier runs under Node, where there is
 * no Web Audio, and the whole point of keeping Web Audio at the very edge of
 * dsp/ is that the analysis can be driven from a plain Float32Array. This is
 * what produces one.
 *
 * Handles the two encodings that actually turn up in the fixture corpus:
 * 16-bit PCM and 32-bit float.
 */

import { readFileSync } from "node:fs";

export interface WavData {
  samples: Float32Array;
  rate: number;
  channels: number;
}

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let format = 1;
  let channels = 1;
  let rate = 8000;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataStart = body;
      dataLen = size;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error(`${path} has no data chunk`);

  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPer;
      if (format === 3 && bits === 32) acc += view.getFloat32(at, true);
      else if (bits === 16) acc += view.getInt16(at, true) / 32768;
      else if (bits === 32) acc += view.getInt32(at, true) / 2147483648;
      else if (bits === 8) acc += (view.getUint8(at) - 128) / 128;
      else throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
    }
    out[i] = acc / channels;
  }

  return { samples: out, rate, channels };
}

/** Peak-normalize, the way a clip is levelled before analysis. */
export function normalizePeak(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  if (!(peak > 0)) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / peak;
  return out;
}
