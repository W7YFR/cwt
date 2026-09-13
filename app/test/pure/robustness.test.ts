/* Where the decoder stops working, measured rather than guessed.
 *
 * The clean-path lock says good audio must not change. This says what happens
 * to everything else, as a surface: reverberation against direct-to-reverberant
 * ratio, signal-to-noise, hum, level drift, automatic gain. Each point is a
 * synthetic take whose every element boundary is known, so a failure names its
 * own cause and its own amount.
 *
 * The recorded surface is not a target. It is what the decoder does today, and
 * most of it is currently a failure — that is the point of writing it down.
 * Work on the impaired path moves entries from `fail` to `ok`, and the diff on
 * this file is the evidence that it did.
 *
 * Re-record the same way as the clean-path lock, and with the same caution:
 *
 *     LOCK_RECORD=1 npx vitest run --project pure robustness
 *
 * Two things this deliberately does not do. It does not tune anything to the
 * three real microphone recordings — those are held out as acceptance tests,
 * and nothing here has ever seen them. And it does not claim these synthetic
 * rooms are anybody's actual room; they are independent stressors chosen to
 * find edges, and a real room is the only thing that settles whether the edges
 * are in the right place.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeTake, makeTake, scoreAgainst, type Impairments } from "../impair";
import { DATA_DIR } from "../oracle-fs";
import { estimateTiming, buildTimeline } from "@/timing";

const LOCKFILE = resolve(DATA_DIR, "../..", "app/test/lock/robustness.json");
const RECORDING = process.env.LOCK_RECORD === "1";

const TEXT = "CQ DE W1AW";
const WPM = 20;
const RATE = 8000;
const SEED = 7;

interface Case {
  readonly name: string;
  readonly imp: Impairments;
}

/** The grid.
 *
 * One axis moves at a time, because a point that fails under three
 * simultaneous insults tells you nothing about which one did it. The two
 * `mic-like` cases at the end are the exception: they combine the stressors the
 * way a real microphone in a real room actually would, and exist to check that
 * fixing the axes separately adds up to fixing them together. */
const CASES: Case[] = [
  { name: "clean", imp: {} },

  // Reverberation. rt60 is how long the room rings; dr is how loud the ringing
  // is next to the direct sound, which is what decides whether a gap ever
  // reaches silence.
  ...[0.1, 0.2, 0.3, 0.5].flatMap((rt60Sec) =>
    [20, 12, 6, 0].map((drDb) => ({
      name: `room rt60=${rt60Sec.toFixed(2)}s dr=${drDb}dB`,
      imp: { room: { rt60Sec, drDb }, seed: SEED } as Impairments,
    })),
  ),

  // Broadband noise, relative to the level of a keyed mark.
  ...[40, 30, 20, 12, 8].map((snrDb) => ({
    name: `noise snr=${snrDb}dB`,
    imp: { snrDb, seed: SEED } as Impairments,
  })),

  // Mains hum and a DC offset — the pair that dominates a cheap USB mic's
  // spectrum without necessarily being audible.
  ...[-12, -6, 0, 6].map((humDb) => ({
    name: `hum ${humDb}dB + dc`,
    imp: { humHz: 60, humDb, dcOffset: 0.3, seed: SEED } as Impairments,
  })),

  // Someone leaning toward and away from the microphone.
  ...[3, 6, 12].map((driftDb) => ({
    name: `drift ${driftDb}dB`,
    imp: { driftDb, driftPeriodSec: 3, seed: SEED } as Impairments,
  })),

  // The nonlinear one. No linear correction can undo this, so a pipeline that
  // assumes linearity should be expected to fail here and say so.
  ...[
    { attackMs: 5, releaseMs: 150, target: 0.25, maxGainDb: 25 },
    { attackMs: 1, releaseMs: 400, target: 0.25, maxGainDb: 35 },
  ].map((agc, i) => ({
    name: `agc ${i === 0 ? "moderate" : "aggressive"}`,
    imp: { agc, seed: SEED } as Impairments,
  })),

  {
    name: "mic-like near",
    imp: {
      room: { rt60Sec: 0.25, drDb: 12 },
      snrDb: 30,
      humHz: 60,
      humDb: -12,
      dcOffset: 0.2,
      seed: SEED,
    },
  },
  {
    name: "mic-like far",
    imp: {
      room: { rt60Sec: 0.4, drDb: 5 },
      snrDb: 22,
      humHz: 60,
      humDb: -6,
      dcOffset: 0.3,
      driftDb: 3,
      driftPeriodSec: 4,
      seed: SEED,
    },
  },
];

interface Point {
  name: string;
  /** "ok" — right element count and right text. "text" — right count, wrong
   *  text. "count" — the keying itself came out the wrong shape. */
  verdict: "ok" | "text" | "count";
  marks: number;
  /** Against the unimpaired decode, in milliseconds, rounded. A perfect
   *  decoder does not reproduce the ground truth exactly — the threshold sits
   *  partway up a 5 ms ramp — so the clean decode is the honest reference. */
  biasMs: number | null;
  scatterMs: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function measure(): Point[] {
  const clean = makeTake(TEXT, WPM, null, RATE);
  const cleanSegs = decodeTake(clean).segments;

  return CASES.map(({ name, imp }) => {
    const take = makeTake(TEXT, WPM, null, RATE, imp);
    const segs = decodeTake(take).segments;
    const score = scoreAgainst(segs, cleanSegs);

    let text = "";
    try {
      text = buildTimeline(segs, estimateTiming(segs, TEXT)).text;
    } catch {
      text = "";
    }

    const verdict: Point["verdict"] = !score.countsMatch
      ? "count"
      : text === TEXT
        ? "ok"
        : "text";

    return {
      name,
      verdict,
      marks: score.gotMarks,
      biasMs: score.countsMatch ? round1(score.markBiasSec * 1000) : null,
      scatterMs: score.countsMatch ? round1(score.markScatterSec * 1000) : null,
    };
  });
}

let points: Point[] = [];

beforeAll(() => {
  points = measure();
  if (RECORDING) {
    mkdirSync(dirname(LOCKFILE), { recursive: true });
    const body = points.map((p) => `  ${JSON.stringify(p)}`).join(",\n");
    writeFileSync(LOCKFILE, `{\n "points": [\n${body}\n ]\n}\n`);
  }

  // The surface, for a human. Printed rather than asserted, because the shape
  // of the boundary is the thing worth looking at and a pass/fail count hides
  // it completely.
  const ok = points.filter((p) => p.verdict === "ok").length;
  const lines = points.map((p) => {
    const mark = p.verdict === "ok" ? "ok  " : p.verdict === "text" ? "TEXT" : "COUNT";
    const bias = p.biasMs === null ? "" : ` bias=${p.biasMs}ms scatter=${p.scatterMs}ms`;
    return `  ${mark.padEnd(6)} ${p.name.padEnd(26)} marks=${p.marks}${bias}`;
  });
  console.log(`\nrobustness surface — ${ok}/${points.length} fully correct\n${lines.join("\n")}\n`);
});

function locked(): Point[] {
  return (JSON.parse(readFileSync(LOCKFILE, "utf8")) as { points: Point[] }).points;
}

describe("the robustness surface", () => {
  it("has a recorded surface to compare against", () => {
    expect(
      existsSync(LOCKFILE),
      `No surface at ${LOCKFILE}. Record one with ` +
        `LOCK_RECORD=1 npx vitest run --project pure robustness`,
    ).toBe(true);
  });

  it("covers every case in the grid", () => {
    expect(points.map((p) => p.name)).toEqual(CASES.map((c) => c.name));
    expect(locked().map((p) => p.name)).toEqual(CASES.map((c) => c.name));
  });

  it("decodes the unimpaired case perfectly", () => {
    // The floor under everything else. If this ever fails, no other number on
    // the surface means anything.
    const clean = points.find((p) => p.name === "clean")!;
    expect(clean.verdict).toBe("ok");
    expect(clean.biasMs).toBe(0);
  });

  it("still finds the impairments that used to be harmless harmless", () => {
    // A one-way ratchet on the easy end: anything the decoder already survives
    // it has to go on surviving. This is the assertion that makes work on hard
    // audio safe, and it is deliberately separate from the exact-match test
    // below so that a regression here reads as a regression rather than as a
    // surface that needs re-recording.
    for (const was of locked()) {
      if (was.verdict !== "ok") continue;
      const now = points.find((p) => p.name === was.name);
      expect(now?.verdict, `${was.name} used to decode correctly`).toBe("ok");
    }
  });

  it("matches the recorded surface exactly", () => {
    // Including the failures, so an improvement shows up as a diff that has to
    // be looked at and re-recorded on purpose.
    expect(points).toEqual(locked());
  });
});
