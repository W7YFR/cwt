/* Preview: the sound settings as they are being changed, heard at once.
 *
 * All: three stations send their calls, one at the lowest pitch, one in
 * the middle and one at the highest, over the band, again and again. Pitch:
 * the same stations with nothing added. Band: the same band with no
 * stations. The QRM station sends at
 * once, rather than after a quiet as on the air. The clip
 * lasts a few seconds, so it is made again at each change of a setting, and
 * plays on from where it was. It has its own audio, apart from the page's
 * player, so the page's playback and what it shows are left alone.
 */

import { useEffect, useRef, useState } from "react";
import type { AgcMode } from "@/audio/agc";
import { NOISE_OFF_DB } from "@/audio/qsb";
import { QRM_OFF_DB } from "@/copy/band";
import { sendScript, type Script } from "@/copy/generate";
import type { Speed } from "@/qso/speed";
import { PITCH_STEP_HZ, randomStation, type PitchRange } from "@/qso/station";

/** What a preview plays: the stations over the band, the stations alone,
 *  or the band alone. */
export type PreviewMode = "all" | "pitch" | "band";

/** The sound settings a preview plays. */
export interface PreviewSound {
  readonly pitch: PitchRange;
  readonly qsbDb: number;
  readonly noiseDb: number;
  readonly qrn: number;
  readonly qrmDb: number;
  readonly agc: AgcMode;
}

/** The silence between two calls in the clip, in seconds. */
const GAP_SEC = 0.6;

/** How many times the clip goes through the three calls: long enough for a
 *  line of QRM. */
const ROUNDS = 2;

/** When the QRM station first sends in the clip, in seconds. */
const QRM_FIRST_SEC = 0.3;

/** How long a change waits for the next one, in ms: a slider dragged on
 *  makes the clip once, not at every step. */
const SETTLE_MS = 50;

/** The clip: each call at its pitch over the band, each call with nothing
 *  added, or the band alone. */
export function previewClip(
  mode: PreviewMode,
  calls: readonly string[],
  sound: PreviewSound,
  speed: Speed,
): { samples: Float32Array; rate: number } {
  const { lowHz, highHz } = sound.pitch;
  const midHz = lowHz + Math.round((highHz - lowHz) / 2 / PITCH_STEP_HZ) * PITCH_STEP_HZ;
  const script: Script = {
    kind: "text",
    stations: [lowHz, midHz, highHz].map((toneHz, i) => ({ call: calls[i]!, toneHz, speed })),
    lines: Array.from({ length: ROUNDS }, () => calls.map((text, station) => ({ station, text }))).flat(),
  };
  const nothingAdded = mode === "pitch" ? { qsbDb: 0, noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB } : {};
  return sendScript(script, { gapSec: GAP_SEC, ...sound, ...nothingAdded, qrmFirstSec: QRM_FIRST_SEC, bandOnly: mode === "band" });
}

/** Preview: what it plays, or null when off. It turns off when `open`
 *  turns false: the sound panel closed. The page turns it off when it plays
 *  something itself. */
export function usePreview({
  sound,
  speed,
  gainDb,
  open,
  onStart,
}: {
  sound: PreviewSound;
  speed: Speed;
  gainDb: number;
  open: boolean;
  /** Stops what the page plays: the two never play at once. */
  onStart(): void;
}): { mode: PreviewMode | null; setMode(mode: PreviewMode | null): void } {
  const [mode, setMode] = useState<PreviewMode | null>(null);
  const [calls] = useState(() => [0, 1, 2].map(() => randomStation(Math.random).call));
  const out = useRef<{ ctx: AudioContext; level: GainNode } | null>(null);
  const playing = useRef<{ src: AudioBufferSourceNode; startedAt: number; durationSec: number } | null>(null);

  /** The preview's own audio, made on first use. */
  const output = () => {
    if (!out.current) {
      const ctx = new AudioContext();
      const level = ctx.createGain();
      level.connect(ctx.destination);
      out.current = { ctx, level };
    }
    return out.current;
  };

  const stop = () => {
    playing.current?.src.stop();
    playing.current = null;
  };

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  const key = JSON.stringify({ sound, speed });
  useEffect(() => {
    if (!mode) {
      stop();
      return;
    }
    const t = setTimeout(() => {
      const clip = previewClip(mode, calls, sound, speed);
      const { ctx, level } = output();
      level.gain.value = Math.pow(10, gainDb / 20);
      const buf = ctx.createBuffer(1, clip.samples.length, clip.rate);
      buf.getChannelData(0).set(clip.samples);
      // On from where the last clip was, so a change does not start it over.
      // Both clips are as long, so switching between them goes on too.
      const was = playing.current;
      const at = was ? (ctx.currentTime - was.startedAt) % was.durationSec : 0;
      stop();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(level);
      const offset = at % buf.duration;
      src.start(0, offset);
      playing.current = { src, startedAt: ctx.currentTime - offset, durationSec: buf.duration };
    }, playing.current ? SETTLE_MS : 0);
    return () => clearTimeout(t);
    // The clip is made again when what it is made from changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, key]);

  useEffect(() => {
    if (out.current) out.current.level.gain.value = Math.pow(10, gainDb / 20);
  }, [gainDb]);

  useEffect(
    () => () => {
      stop();
      void out.current?.ctx.close();
    },
    [],
  );

  return {
    mode,
    setMode: (next) => {
      // From the click itself: a browser starts audio only from one.
      if (next) {
        onStart();
        void output().ctx.resume();
      }
      setMode(next);
    },
  };
}
