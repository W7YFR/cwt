/* Playback: your recording from a decoded buffer, the target from an
 * oscillator.
 *
 * The target is synthesized rather than stored, so it re-renders instantly when
 * you move the speed slider instead of going stale like a baked file would.
 *
 * Your recording plays from a decoded AudioBuffer, deliberately not from an
 * <audio> element routed through a gain node: a MediaElementAudioSourceNode can
 * output silence rather than erroring on some source/origin combinations, and a
 * silent player is a worse failure than a loud one. A decoded buffer also gives
 * exact seeking and a real duration, so the transport cannot get stuck waiting
 * for a rounded one.
 */

import type { Timeline } from "@/types";
import { fadeCurve, type Fade } from "./qsb";
import { keyingEnvelope, RAMP_SEC, type ScheduleOptions } from "./schedule";
import { encodeWav } from "./wav";

export type PlaySide = "you" | "tgt";

export interface PlayerCallbacks {
  /** Called every animation frame while something is playing. */
  onProgress?: (t: number, side: PlaySide) => void;
  /** Called when playback ends: "done" when it reached its end, "stopped"
   *  when `stop()` ended it. */
  onEnded?: (reason: "done" | "stopped") => void;
  onError?: (message: string) => void;
}

export interface TargetVoice {
  /** Tone frequency. Matched to the recording so an A/B does not beat. */
  toneHz: number;
  /** A gentle resonance on the keying edges.
   *
   * A bare sine with linear ramps is clean and characterless; a real signal
   * through a narrow IF filter rings very slightly as the key opens and closes,
   * and that ring is most of what makes CW sound like CW rather than like a
   * test tone. Set to 0 to leave the tone unfiltered. */
  filterQ: number;
}

export const DEFAULT_VOICE: TargetVoice = { toneHz: 600, filterQ: 3 };

/** The target as heard over the air: fading, over the band. Each part is
 *  absent when it is off. */
export interface TargetAir {
  fade?: {
    /** The station's fading. */
    fade: Fade;
    /** Where in the fading the target starts, in seconds. */
    atSec: number;
  };
  /** The band with the target alone: absent when it plays on its own. It
   *  plays from where the page's clock is in it, so each over hears a
   *  different part. */
  band?: Band;
}

/** The band: noise, QRN and QRM, as one track that loops. Played under a
 *  station's over here; played on its own, by the recorder: see BandGate. */
export interface Band {
  samples: Float32Array;
  rate: number;
}

/** How often the fade's gain is set, in seconds. */
const FADE_STEP_SEC = 0.02;

/** How long the noise with a target takes to come up and to die away. */
const NOISE_RAMP_SEC = 0.15;


export interface Player {
  playBuffer(data: ArrayBuffer | AudioBuffer, from?: number, to?: number): Promise<void>;
  playTarget(
    timeline: Timeline,
    options: ScheduleOptions & { voice?: TargetVoice; air?: TargetAir | undefined },
  ): void;
  stop(): void;
  /** Open the audio context now. A page that plays later, with no click
   *  behind it, calls this from the click that starts it. */
  wake(): void;
  /** Playback level in dB. Applied at playback only — never baked into the
   *  samples or into a download. */
  setGainDb(db: number): void;
  gainDb(): number;
  playing(): PlaySide | null;
  /** Render the target offline and hand back a WAV. */
  renderTarget(
    timeline: Timeline,
    options: ScheduleOptions & { voice?: TargetVoice; rate: number },
  ): Promise<Blob>;
  destroy(): void;
}

function audioCtor(): typeof AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error("this browser has no Web Audio support");
  return Ctor;
}

function offlineCtor(): typeof OfflineAudioContext {
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Ctor) throw new Error("this browser cannot render audio offline");
  return Ctor;
}

export function createPlayer(callbacks: PlayerCallbacks = {}): Player {
  let ctx: AudioContext | null = null;
  let gainDb = 0;

  let mode: PlaySide | null = null;
  let raf: number | null = null;
  let stopAt: number | null = null;
  let clockStart = 0;
  let clockOffset = 0;
  let clockEnd = 0;

  let youNodes: { src: AudioBufferSourceNode; level: GainNode } | null = null;
  let tgtNodes: {
    osc: OscillatorNode;
    gate: GainNode;
    level: GainNode;
    filter: BiquadFilterNode | null;
    fade: GainNode | null;
    noise: AudioBufferSourceNode | null;
  } | null = null;

  /* A recording is decoded before it plays, and a stop can land in between.
     Each start takes a ticket; a stop or another start voids it, so a decode
     that finishes after either plays nothing. */
  let ticket = 0;
  let starting = false;

  let decoded: AudioBuffer | null = null;
  let decodedFrom: ArrayBuffer | null = null;

  function context(): AudioContext {
    if (!ctx) ctx = new (audioCtor())();
    // Browsers start a context suspended until a user gesture. Every entry
    // point here is reached from a click, so resuming is safe and necessary.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  const linGain = () => Math.pow(10, gainDb / 20);

  function teardown(): void {
    ticket++;
    starting = false;
    if (youNodes) {
      youNodes.src.onended = null;
      try {
        youNodes.src.stop();
      } catch {
        /* already stopped */
      }
      youNodes.src.disconnect();
      youNodes.level.disconnect();
      youNodes = null;
    }
    if (tgtNodes) {
      tgtNodes.osc.onended = null;
      try {
        tgtNodes.osc.stop();
      } catch {
        /* already stopped */
      }
      tgtNodes.osc.disconnect();
      tgtNodes.gate.disconnect();
      tgtNodes.filter?.disconnect();
      tgtNodes.fade?.disconnect();
      if (tgtNodes.noise) {
        try {
          tgtNodes.noise.stop();
        } catch {
          /* already stopped */
        }
        tgtNodes.noise.disconnect();
      }
      tgtNodes.level.disconnect();
      tgtNodes = null;
    }
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    mode = null;
    stopAt = null;
  }

  function finish(reason: "done" | "stopped"): void {
    const was = mode !== null || starting;
    teardown();
    if (was) callbacks.onEnded?.(reason);
  }

  const stop = () => finish("stopped");
  const done = () => finish("done");

  function tick(): void {
    if (!ctx || !mode) return;
    const t = ctx.currentTime - clockStart + clockOffset;
    if (stopAt !== null && t >= stopAt) return done();
    // The buffer knows its own real duration, so this cannot hang waiting for a
    // rounded figure the audio never reaches.
    if (t >= clockEnd - 0.01) return done();
    // Playback is scheduled a beat in the future, so the first few frames sit
    // slightly before zero — which would otherwise read as "-0.0s".
    callbacks.onProgress?.(Math.max(t, 0), mode);
    raf = requestAnimationFrame(tick);
  }

  async function ensureBuffer(data: ArrayBuffer | AudioBuffer): Promise<AudioBuffer> {
    if (typeof (data as AudioBuffer).getChannelData === "function") {
      return data as AudioBuffer;
    }
    const bytes = data as ArrayBuffer;
    if (decoded && decodedFrom === bytes) return decoded;
    // decodeAudioData detaches the buffer it is given, so hand it a copy —
    // otherwise a second play of the same recording decodes an empty array.
    decoded = await context().decodeAudioData(bytes.slice(0));
    decodedFrom = bytes;
    return decoded;
  }

  return {
    async playBuffer(data, from, to) {
      teardown();
      const mine = ticket;
      starting = true;
      try {
        const buf = await ensureBuffer(data);
        if (mine !== ticket) return;
        starting = false;
        const c = context();
        const src = c.createBufferSource();
        const level = c.createGain();
        src.buffer = buf;
        level.gain.value = linGain();
        src.connect(level).connect(c.destination);

        const start = Math.max(from ?? 0, 0);
        const dur = to === undefined ? buf.duration - start : Math.max(to - start, 0.01);
        const t0 = c.currentTime + 0.02;
        src.start(t0, start, dur);
        // The node's own end event, so a throttled frame loop cannot leave the
        // transport stuck showing "playing".
        src.onended = () => {
          if (mode === "you") done();
        };

        youNodes = { src, level };
        clockStart = t0;
        clockOffset = start;
        clockEnd = to === undefined ? buf.duration : to;
        mode = "you";
        stopAt = to === undefined ? null : to;
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (mine !== ticket) return;
        starting = false;
        callbacks.onError?.(
          `could not play the recording: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },

    playTarget(timeline, options) {
      teardown();
      const c = context();
      const voice = options.voice ?? DEFAULT_VOICE;
      const osc = c.createOscillator();
      const gate = c.createGain();
      // A second, static node carries the listening level, so the keying
      // envelope on `gate` stays independent of it — and so the target is
      // level-matched to your recording when you A/B them.
      const level = c.createGain();

      osc.type = "sine";
      osc.frequency.value = voice.toneHz;
      gate.gain.value = 0;
      level.gain.value = linGain();

      const env = keyingEnvelope(timeline, options);
      const t0 = c.currentTime + 0.06; // a beat of headroom for scheduling

      // On the air: a gain that fades the keyed tone, and noise beside it. The
      // noise goes straight to the level, so it plays through the gaps.
      let fade: GainNode | null = null;
      let noise: AudioBufferSourceNode | null = null;
      const air = options.air;
      if (air?.fade) {
        const n = Math.max(2, Math.ceil(env.duration / FADE_STEP_SEC) + 1);
        fade = c.createGain();
        fade.gain.setValueCurveAtTime(fadeCurve(air.fade.fade, air.fade.atSec, FADE_STEP_SEC, n), t0, (n - 1) * FADE_STEP_SEC);
      }
      if (air?.band && air.band.samples.length > 0) {
        const buf = c.createBuffer(1, air.band.samples.length, air.band.rate);
        buf.getChannelData(0).set(air.band.samples);
        // Up and down in a ramp, not cut, at each end of the over.
        const ramp = c.createGain();
        const ramped = Math.min(NOISE_RAMP_SEC, env.duration / 2);
        ramp.gain.setValueAtTime(0, t0);
        ramp.gain.linearRampToValueAtTime(1, t0 + ramped);
        ramp.gain.setValueAtTime(1, t0 + env.duration - ramped);
        ramp.gain.linearRampToValueAtTime(0, t0 + env.duration);
        noise = c.createBufferSource();
        noise.buffer = buf;
        noise.loop = true;
        noise.connect(ramp).connect(level);
        noise.start(t0, (performance.now() / 1000) % buf.duration);
        noise.stop(t0 + env.duration);
      }

      let filter: BiquadFilterNode | null = null;
      let head: AudioNode = gate;
      osc.connect(gate);
      if (voice.filterQ > 0) {
        filter = c.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = voice.toneHz;
        filter.Q.value = voice.filterQ;
        head = head.connect(filter);
      }
      if (fade) head = head.connect(fade);
      head.connect(level).connect(c.destination);
      for (const [at, value] of env.points) {
        if (value === 0) gate.gain.setValueAtTime(0, t0 + at);
        else gate.gain.linearRampToValueAtTime(value, t0 + at);
      }

      const start = options.from ?? -options.padSec;
      const endT = options.to ?? timeline.duration + options.padSec;

      osc.start(t0);
      osc.stop(t0 + env.duration + 0.05);
      osc.onended = () => {
        if (mode === "tgt") done();
      };

      tgtNodes = { osc, gate, level, filter, fade, noise };
      clockStart = t0;
      clockOffset = start;
      clockEnd = endT;
      mode = "tgt";
      stopAt = options.to === undefined ? null : options.to;
      raf = requestAnimationFrame(tick);
    },

    stop,

    wake() {
      context();
    },

    setGainDb(db) {
      gainDb = db;
      const g = linGain();
      if (youNodes) youNodes.level.gain.value = g;
      if (tgtNodes) tgtNodes.level.gain.value = g;
    },

    gainDb: () => gainDb,
    playing: () => mode,

    async renderTarget(timeline, options) {
      const rate = options.rate;
      const dur = Math.max(timeline.duration + 2 * options.padSec, 0.3);
      const oc = new (offlineCtor())(1, Math.ceil(dur * rate), rate);
      const voice = options.voice ?? DEFAULT_VOICE;

      const osc = oc.createOscillator();
      const gate = oc.createGain();
      osc.type = "sine";
      osc.frequency.value = voice.toneHz;
      gate.gain.value = 0;

      if (voice.filterQ > 0) {
        const filter = oc.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = voice.toneHz;
        filter.Q.value = voice.filterQ;
        osc.connect(gate).connect(filter).connect(oc.destination);
      } else {
        osc.connect(gate).connect(oc.destination);
      }

      // The same schedule the live path uses, so what you download is what you
      // just heard — offset by the lead-in padding, which offline renders from
      // zero rather than from a negative timeline time.
      const env = keyingEnvelope(timeline, {
        peak: options.peak,
        padSec: options.padSec,
      });
      for (const [at, value] of env.points) {
        if (value === 0) gate.gain.setValueAtTime(0, at);
        else gate.gain.linearRampToValueAtTime(value, at);
      }

      osc.start(0);
      osc.stop(dur);
      const rendered = await oc.startRendering();
      return encodeWav(rendered.getChannelData(0), rate);
    },

    destroy() {
      teardown();
      void ctx?.close();
      ctx = null;
      decoded = null;
      decodedFrom = null;
    },
  };
}

export { RAMP_SEC };
