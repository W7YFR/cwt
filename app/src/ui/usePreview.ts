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

/** How long a clip fades in or out, in seconds: a clip cut off in the
 *  middle of a tone pops. A new clip fades in as the last one fades out. */
const FADE_SEC = 0.02;

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

/** A clip played again and again on its own audio, while `make` is not
 *  null. The clip is made again when `key` changes, and plays on from where
 *  it was. `wake` starts the audio: call it from a click. */
export function useLoop(
  make: (() => { samples: Float32Array; rate: number }) | null,
  key: string,
  gainDb: number,
): { wake(): void } {
  const out = useRef<{ ctx: AudioContext; level: GainNode } | null>(null);
  const playing = useRef<{ src: AudioBufferSourceNode; fade: GainNode; startedAt: number; durationSec: number } | null>(null);

  /** The loop's own audio, made on first use. */
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
    const was = playing.current;
    playing.current = null;
    if (!was) return;
    const now = was.fade.context.currentTime;
    was.fade.gain.cancelScheduledValues(now);
    was.fade.gain.setTargetAtTime(0, now, FADE_SEC / 4);
    was.src.stop(now + FADE_SEC);
  };

  const on = make !== null;
  useEffect(() => {
    if (!make) {
      stop();
      return;
    }
    const t = setTimeout(() => {
      const clip = make();
      const { ctx, level } = output();
      level.gain.value = Math.pow(10, gainDb / 20);
      const buf = ctx.createBuffer(1, clip.samples.length, clip.rate);
      buf.getChannelData(0).set(clip.samples);
      // On from where the last clip was, so a change does not start it over.
      // Clips as long as each other go on from the same place.
      const was = playing.current;
      const at = was ? (ctx.currentTime - was.startedAt) % was.durationSec : 0;
      stop();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(0, ctx.currentTime);
      fade.gain.setTargetAtTime(1, ctx.currentTime, FADE_SEC / 4);
      src.connect(fade);
      fade.connect(level);
      const offset = at % buf.duration;
      src.start(0, offset);
      playing.current = { src, fade, startedAt: ctx.currentTime - offset, durationSec: buf.duration };
    }, playing.current ? SETTLE_MS : 0);
    return () => clearTimeout(t);
    // The clip is made again when what it is made from changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);

  useEffect(() => {
    if (out.current) out.current.level.gain.value = Math.pow(10, gainDb / 20);
  }, [gainDb]);

  useEffect(
    () => () => {
      stop();
      // After the fade out.
      const ctx = out.current?.ctx;
      if (ctx) setTimeout(() => void ctx.close(), FADE_SEC * 2000);
    },
    [],
  );

  return { wake: () => void output().ctx.resume() };
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
  const loop = useLoop(mode ? () => previewClip(mode, calls, sound, speed) : null, JSON.stringify({ mode, sound, speed }), gainDb);

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  return {
    mode,
    setMode: (next) => {
      // From the click itself: a browser starts audio only from one.
      if (next) {
        onStart();
        loop.wake();
      }
      setMode(next);
    },
  };
}
