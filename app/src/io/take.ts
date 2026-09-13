/* Turning audio into a Take: the one place a recording becomes reviewable.
 *
 * Deliberately raw. Segments go in as seconds, the intended text goes in as
 * text, and nothing pre-divides either into target units — so the review can
 * re-grade at any speed, Farnsworth spacing, tolerance or intended message
 * without going near the audio again. That is also what makes a saved Take
 * survive: it does not encode the settings it was looked at under.
 */

import { normalized, segmentsFrom, trimSilence, TRIM_PAD } from "@/dsp";
import { buildTimeline, estimateTiming } from "@/timing";
import type { AudioClip, Take } from "@/types";

/** The `source` of a take captured through the microphone. A sentinel rather
 *  than a label: the header hides it, because it says the same thing every
 *  time, but a download still needs a filename stem. */
export const MIC_SOURCE = "microphone";

/** There was no keying in the audio — see dsp/presence.ts.
 *
 * Its own type because it is not a failure of anything. The file opened, the
 * audio decoded, and the honest answer is that there is nothing in it to
 * grade; the caller should say so plainly rather than dress it up as a fault.
 * Loading is refused because a take of nothing has no speed, no decode and no
 * timeline, and a review page built from one would be a page of zeros. */
export class NoKeyingError extends Error {
  constructor(message = "I could not hear any CW in this recording.") {
    super(message);
    this.name = "NoKeyingError";
  }
}

export interface AnalyzeOptions {
  /** Where the audio came from: a filename, or MIC_SOURCE. */
  readonly source: string;
  /** What the sender meant to key, if they said. */
  readonly expected?: string | null;
  readonly expectedSource?: string | null;
  /** Skip tone detection and use this frequency. */
  readonly toneHz?: number | undefined;
  /** Target speed the review should open at. Omitted means "open at whatever
   *  you actually sent", which is the honest default for a first recording. */
  readonly targetWpm?: number | undefined;
  readonly targetFarnsworth?: number | undefined;
  /** Trim dead air from both ends first. On for a mic capture, where there is
   *  always a moment of silence at each end while you reach for the mouse. */
  readonly trim?: boolean;
  /** ISO timestamp; injected so a test can be deterministic. */
  readonly now?: string;
  /** Id; injected for the same reason. */
  readonly id?: string;
}

export interface AnalyzeResult {
  readonly take: Take;
  /** The audio as analyzed — trimmed, but NOT normalized, so playback and any
   *  download stay at the level it was recorded at. */
  readonly clip: AudioClip;
  /** How much was trimmed from the front, if any. */
  readonly leadSec: number;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

function newId(): string {
  // Enough entropy to not collide within one person's practice history, and
  // sortable by the timestamp prefix so a directory of them reads in order.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/** Decode, measure, and package one recording. */
export function analyzeClip(input: AudioClip, options: AnalyzeOptions): AnalyzeResult {
  let clip = input;
  let leadSec = 0;

  if (options.trim) {
    const trimmed = trimSilence(clip.samples, clip.rate, TRIM_PAD, options.toneHz);
    if (trimmed.leadSec > 0 || trimmed.samples.length !== clip.samples.length) {
      let peak = 0;
      for (let i = 0; i < trimmed.samples.length; i++) {
        const a = Math.abs(trimmed.samples[i]!);
        if (a > peak) peak = a;
      }
      clip = { samples: trimmed.samples, rate: clip.rate, peak };
      leadSec = trimmed.leadSec;
    }
  }

  // The threshold works on absolute amplitude, so the DSP gets a normalized
  // copy — and only the DSP. `clip` stays at the recorded level.
  const forAnalysis = normalized(clip);
  const { toneHz, segments, presence } = segmentsFrom(
    forAnalysis.samples,
    forAnalysis.rate,
    { ...(options.toneHz !== undefined ? { toneHz: options.toneHz } : {}) },
  );
  if (!presence.keyed) throw new NoKeyingError();

  const expected = (options.expected ?? "").trim() || null;
  const measured = estimateTiming(segments, expected);

  // Default the target to whatever was asked for, else to the sender's own
  // measured speed — "what you sent, keyed perfectly". Rounded, because a
  // target of 25.4 wpm is not a speed anyone practices at.
  const explicit = options.targetWpm !== undefined;
  const charWpm = explicit ? options.targetWpm! : Math.round(measured.charWpm);
  const farnsworthWpm = explicit
    ? (options.targetFarnsworth ?? charWpm)
    : Math.min(Math.round(measured.farnsworthWpm), charWpm);

  const take: Take = {
    id: options.id ?? newId(),
    recordedAt: options.now ?? isoNow(),
    source: options.source,
    toneHz: Math.round(toneHz * 10) / 10,
    rate: clip.rate,
    durationSec: Math.round((clip.samples.length / clip.rate) * 1000) / 1000,
    peak: Math.round(clip.peak * 1e5) / 1e5,
    segments,
    decoded: "",
    expected,
    expectedSource: options.expectedSource ?? null,
    measured,
    target: { charWpm, farnsworthWpm, explicit },
    padSec: TRIM_PAD,
  };

  // The decode itself comes from the timeline the review builds, but a Take
  // that does not carry its own text is useless in a list, so fill it in at the
  // sender's own measured speed — the reading that needs no settings to make.
  return {
    take: { ...take, decoded: buildTimeline(segments, measured).text },
    clip,
    leadSec,
  };
}
