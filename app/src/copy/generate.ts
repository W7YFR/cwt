/* A QSO made up for the Copy page: both sides as text, then as sound.
 *
 * Two made-up stations work each other through the QSO page's own script.
 * One calls CQ and sends what a suggested reply would (qso/hint.ts), in a
 * wording picked at random. The other answers as the QSO page's station
 * does (qso/run.ts). So a made-up QSO reads as a QSO on the QSO page does,
 * in every format, and the station never has to ask again.
 *
 * A format is a run: the station that called CQ works one caller after
 * another. A plain CQ is a rag chew with one station.
 *
 * The text is the answer key. Each line is sent at its station's speed and
 * pitch, so every character's time is known, with no decoder.
 *
 * Pure.
 */

import { synthesize } from "@/audio/synth";
import { newQso } from "@/qso/cq";
import type { GuideId } from "@/qso/examples";
import { FORMATS } from "@/qso/formats";
import { hint, type Me } from "@/qso/hint";
import { callIn, following, isRun, respond, type AnyQso, type RunQso } from "@/qso/run";
import type { Speed } from "@/qso/speed";
import { randomCaller, regionOf, type Rand, type Station } from "@/qso/station";
import type { Length } from "@/qso/wording";
import { targetTiming } from "@/timing";
import type { Over, Recording } from "./decode";
import { overOfText } from "./lines";

/** What a made-up QSO is: a rag chew from a plain CQ, or a run of a format. */
export type Kind = GuideId;

/** One station of a made-up QSO. */
export interface ScriptStation {
  readonly call: string;
  readonly toneHz: number;
  /** The speed it sends at, unless the page sets one for all. */
  readonly speed: Speed;
}

/** One line: an over, sent by one station. */
export interface ScriptLine {
  /** The station's place in `stations`. */
  readonly station: number;
  readonly text: string;
}

/** A made-up QSO as text. The station that called CQ is the first. */
export interface Script {
  readonly kind: Kind;
  readonly stations: readonly ScriptStation[];
  readonly lines: readonly ScriptLine[];
}

export interface MakeOptions {
  readonly kind: Kind;
  readonly rand?: Rand;
  /** The local hour, 0 to 23, for GM, GA or GE. Absent: at random. */
  readonly hour?: number;
  /** A rag chew: how much each over says. */
  readonly length?: Length;
  /** A run: how many QSOs. */
  readonly qsos?: number;
}

/** The speeds a rag chew is sent at, slowest and fastest. The station that
 *  answers starts at the speed of the CQ, as on the QSO page. */
export const RAG_CHEW_WPM: readonly [number, number] = [15, 25];

/** The closest two stations' pitches may be, in Hz. */
export const PITCH_APART_HZ = 40;

/** The most overs a made-up QSO may take. Far more than any needs. */
const MOST_OVERS = 200;

function wpmIn(rand: Rand, [lo, hi]: readonly [number, number]): Speed {
  const wpm = lo + Math.floor(rand() * (hi - lo + 1));
  return { charWpm: wpm, farnsworthWpm: wpm };
}

/** A pitch in the band the QSO page's stations use, at least
 *  `PITCH_APART_HZ` from `from` when given. */
function pitchApart(rand: Rand, from?: number): number {
  for (;;) {
    const hz = 550 + Math.round(rand() * 20) * 10;
    if (from === undefined || Math.abs(from - hz) >= PITCH_APART_HZ) return hz;
  }
}

/** The station that calls CQ, as the hints send it. */
function meOf(s: Station): Me {
  return { call: s.call, name: s.name, qth: s.qth, region: regionOf(s), nr: s.nr ?? "", rst: s.rst };
}

/** A made-up QSO of `kind`, both sides, start to finish. */
export function makeScript(options: MakeOptions): Script {
  const { kind, rand = Math.random, length = "full", qsos = 3 } = options;
  const hour = options.hour ?? Math.floor(rand() * 24);
  const start = kind === "cq" ? null : kind;
  const caller = randomCaller(rand);
  const me = meOf(caller);
  const mySpeed = wpmIn(rand, start ? FORMATS[start].wpm : RAG_CHEW_WPM);
  const stations: ScriptStation[] = [{ call: me.call, toneHz: pitchApart(rand), speed: mySpeed }];
  const lines: ScriptLine[] = [];
  const voice = { rand, hour };
  const context = { rand, hour, length, region: me.region, speed: mySpeed };

  /** The place of the station in `qso`, added when first heard. */
  const placeOf = (qso: AnyQso): number => {
    const at = stations.findIndex((s) => s.call === qso.them.call);
    if (at >= 0) return at;
    // Apart from the station that runs: the two take turns. Callers in a
    // run never send at the same time, so they may share a pitch.
    const toneHz = pitchApart(rand, stations[0]!.toneHz);
    return stations.push({ call: qso.them.call, toneHz, speed: qso.speed }) - 1;
  };

  let qso: AnyQso = newQso(rand, me.call, mySpeed);
  let done = 0;
  for (let n = 0; n < MOST_OVERS; n++) {
    const mine = hint(qso, me, start, voice);
    lines.push({ station: 0, text: mine });
    const turn = respond(qso, mine, context);
    qso = turn.qso;
    if (turn.reply !== null) lines.push({ station: placeOf(qso), text: turn.reply });
    if (!turn.ended) continue;
    done++;
    if (!isRun(qso) || done >= qsos) return { kind, stations, lines };
    let next = following(qso, rand) as RunQso;
    // Never a caller at the call of the station that runs.
    while (next.them.call === me.call) next = following(qso, rand) as RunQso;
    const call = callIn(next, rand);
    qso = call.qso;
    lines.push({ station: placeOf(qso), text: call.reply! });
  }
  const last = lines.slice(-6).map((l) => l.text).join(" / ");
  throw new Error(`A made-up ${kind} QSO did not end: ${last}`);
}

/** How a script is sent. */
export interface SendOptions {
  /** The silence between two lines, in seconds. */
  readonly gapSec: number;
  /** One speed for every station, in place of each one's own. */
  readonly speed?: Speed;
  readonly rate?: number;
}

/** Silence before the first line and after the last, in seconds. */
const LEAD_SEC = 0.5;

/** How loud each station is: below full scale, so two never clip. */
const AMPLITUDE = 0.8;

/** A script, sent: the sound, and the answer key the Copy page reads. */
export function sendScript(script: Script, options: SendOptions): { samples: Float32Array; rate: number; rec: Recording } {
  const rate = options.rate ?? 8000;
  const overs: Over[] = [];
  const sounds: { at: number; samples: Float32Array }[] = [];
  let t = LEAD_SEC;
  script.lines.forEach((line, i) => {
    if (i > 0) t += options.gapSec;
    const station = script.stations[line.station]!;
    const { charWpm, farnsworthWpm } = options.speed ?? station.speed;
    const over = overOfText(line.text, charWpm, farnsworthWpm);
    const sound = synthesize(line.text, targetTiming(charWpm, farnsworthWpm), {
      toneHz: station.toneHz,
      rate,
      padSec: 0,
      amplitude: AMPLITUDE,
    });
    sounds.push({ at: Math.round(t * rate), samples: sound.samples });
    overs.push({
      ...over,
      sender: line.station,
      words: over.words.map((w) => ({ chars: w.chars.map((c) => ({ ...c, t0: c.t0 + t, t1: c.t1 + t })) })),
      t0: t,
      t1: t + over.t1,
    });
    t += over.t1;
  });
  const durationSec = t + LEAD_SEC;
  const samples = new Float32Array(Math.ceil(durationSec * rate));
  for (const s of sounds) samples.set(s.samples.subarray(0, samples.length - s.at), s.at);
  return {
    samples,
    rate,
    rec: {
      durationSec,
      senders: script.stations.map((s) => ({ toneHz: s.toneHz, call: s.call })),
      overs,
    },
  };
}
