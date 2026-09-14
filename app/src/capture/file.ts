/* Getting audio in from a file the user picked or dropped.
 *
 * decodeAudioData handles wav, mp3, m4a, flac, ogg and opus with no work on our
 * part, no dependency to install, and nothing to shell out to.
 */

import { decodeAudioFile } from "@/dsp";
import type { AudioClip } from "@/types";

/** Extensions worth advertising in the file picker. Not a whitelist — whatever
 *  the browser can decode will decode — just what to suggest. */
export const ACCEPTED = ".wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aiff,.aif,audio/*";

export interface LoadedFile {
  clip: AudioClip;
  /** The file's own name, for the header and for naming downloads. */
  name: string;
  /** The original bytes, kept so playback and the download are the file itself
   *  rather than a re-encode of our decode of it. */
  data: ArrayBuffer;
}

export async function loadAudioFile(file: File): Promise<LoadedFile> {
  const data = await file.arrayBuffer();
  let clip: AudioClip;
  try {
    // decodeAudioData detaches what it is given, so it gets a copy and `data`
    // stays usable for playback.
    clip = await decodeAudioFile(data.slice(0));
  } catch {
    throw new Error(
      `${file.name} is not audio this browser can decode. ` +
        "WAV, MP3, M4A, FLAC and OGG all work.",
    );
  }
  if (clip.samples.length === 0) {
    throw new Error(`${file.name} decoded to no audio at all`);
  }
  return { clip, name: file.name, data };
}

/** The first audio file in a drop, or null if the drop had none. */
export function audioFromDrop(items: DataTransfer | null): File | null {
  if (!items) return null;
  const files = Array.from(items.files);
  return (
    files.find((f) => f.type.startsWith("audio/")) ??
    files.find((f) => /\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff?|)$/i.test(f.name)) ??
    null
  );
}
