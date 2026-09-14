/* A minimal 16-bit PCM WAV writer.
 *
 * So a recording or a target track can be handed over as a real file rather
 * than as something only this page can play. Pure — no Web Audio, no DOM — so
 * the pure test tier can round-trip it against the reader the tests use.
 */

/** Encode mono float samples as a 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  return new Blob([encodeWavBuffer(samples, rate)], { type: "audio/wav" });
}

/** The same bytes, without wrapping them in a Blob — for tests and for callers
 *  that want to hash or inspect the result. */
export function encodeWavBuffer(samples: Float32Array, rate: number): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const d = new DataView(buf);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) d.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, "RIFF");
  d.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  d.setUint32(16, 16, true); // fmt chunk size
  d.setUint16(20, 1, true); // PCM
  d.setUint16(22, 1, true); // mono
  d.setUint32(24, rate, true);
  d.setUint32(28, rate * 2, true); // byte rate
  d.setUint16(32, 2, true); // block align
  d.setUint16(34, 16, true); // bits
  str(36, "data");
  d.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    d.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}
