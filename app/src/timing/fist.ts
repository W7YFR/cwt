/* How a station's key lays out a line: every mark and gap, in seconds.
 *
 * The one place a line's timing comes from. `keyingPlan` (what you hear) and
 * `idealTimeline` (what the page shows and grades against) both lay out what
 * `keyed` returns, so a station's sound and its answer key never drift apart.
 *
 * With no fist, a line is keyed exactly: a keyer. With a bug's fist, it is
 * keyed the way a person on a semi-automatic key sends:
 *
 * - The dits come from a vibrating arm, so they are even, and light: the arm
 *   holds the contact closed for less than half its swing.
 * - The dahs are made by hand. They run long, 4 to 5 dits, and no two are the
 *   same length. A dah before a dit, as the first one in C, is dragged a
 *   little longer.
 * - The gaps around a dah are made by hand too, so they drift. After a dah,
 *   the arm must start before the first dit comes.
 * - Some operators like a proper roger: an R on its own, as in R R, with its
 *   dah drawn out far past the rest.
 * - Each operator has a swing: a habit of spacing out two letters when the
 *   first ends as the next begins, dah to dah or dit to dit.
 * - Each operator sends each letter their own way, the same way each time:
 *   one drags the first dah of C, another clips the dah of Q.
 * - A letter now and then comes out rushed or dragged, and the whole fist
 *   drifts faster and slower through a line.
 * - Now and then the hand pauses before a letter.
 *
 * A fist is the operator's own habits, made once from a seed. The variation
 * inside a line is seeded from the fist and the line's text, so a line
 * replayed or saved sounds as it did the first time. The line keeps the
 * station's speed: its PARIS takes as long as a keyer's.
 *
 * Another key worked by hand, such as a straight key, adds a `HandKey`, its
 * kind of `Fist`, and its hand in `byHand`. The speed, the seeding, and
 * both callers stay as they are.
 *
 * Pure.
 */

import { seeded, seedOf } from "@/audio/qsb";
import { keyableSymbols, patternOf } from "@/morse";
import type { Timing } from "@/types";

/** The key a station sends with. */
export type KeyKind = "keyer" | "bug";

export const KEY_KINDS: readonly KeyKind[] = ["keyer", "bug"];

/** A key worked by hand, in part or in whole: every key but a keyer. */
export type HandKey = Exclude<KeyKind, "keyer">;

export const HAND_KEYS: readonly HandKey[] = ["bug"];

/** An operator on a key worked by hand, and their habits. One kind for
 *  each `HandKey`; `key` tells them apart. */
export type Fist = BugFist;

/** An operator on a bug, and their habits. Lengths are in keyer dits before
 *  the line is brought to the station's speed. */
export interface BugFist {
  readonly key: "bug";
  /** Seeds the variation inside each line. */
  readonly seed: number;
  /** The dit's share of the arm's swing: under a half is a light dit. */
  readonly weight: number;
  /** A dah, in the operator's own dits. */
  readonly dah: number;
  /** How much one dah differs from the next, as a share of its length. */
  readonly dahSpread: number;
  /** A dah before a dit is this share longer. */
  readonly drag: number;
  /** The gap after a dah. */
  readonly afterDah: number;
  /** The gap from a dit to a dah, as a share of the arm's own space. */
  readonly toDah: number;
  /** How much a gap made by hand differs from the next, as a share. */
  readonly gapSpread: number;
  /** The gaps between characters and between words, as shares of the
   *  station's own. */
  readonly charGap: number;
  readonly wordGap: number;
  /** Added between two letters when the first ends as the next begins. */
  readonly swing: number;
  /** How often an R on its own is a proper roger, 0 to 1. */
  readonly roger: number;
  /** A proper roger's dah, as so many of the operator's own dahs. */
  readonly rogerDah: number;
  /** How far each letter's own shape is from the usual, as a share: the
   *  same letter comes out the same way each time. */
  readonly shapeSpread: number;
  /** How much one letter is rushed or dragged against the next, as a
   *  share. */
  readonly tempoSpread: number;
  /** How often the hand pauses before a letter, 0 to 1. */
  readonly pause: number;
}

/** The fist of an operator on `key`, from `seed`, or none on a keyer. */
export function fistFor(key: KeyKind, seed: number): Fist | undefined {
  switch (key) {
    case "keyer":
      return undefined;
    case "bug":
      return bugFist(seed);
  }
}

/** The habits of an operator on a bug, from `seed`. */
export function bugFist(seed: number): BugFist {
  const rand = seeded(seedOf(`bug:${seed}`));
  const within = (lo: number, hi: number) => lo + (hi - lo) * rand();
  return {
    key: "bug",
    seed,
    weight: within(0.4, 0.5),
    dah: within(3.8, 5),
    dahSpread: within(0.05, 0.1),
    drag: within(0, 0.15),
    afterDah: within(1.05, 1.5),
    toDah: within(1, 1.3),
    gapSpread: within(0.08, 0.14),
    charGap: within(0.95, 1.35),
    wordGap: within(0.9, 1.25),
    swing: within(0, 1.2),
    roger: within(0.2, 0.9),
    rogerDah: within(2.2, 3.2),
    shapeSpread: within(0.1, 0.18),
    tempoSpread: within(0.02, 0.05),
    pause: within(0.01, 0.04),
  };
}

/** The numbers each kind of fist holds, to check one read back. */
const FIST_NUMBERS: { readonly [K in HandKey]: readonly (keyof Extract<Fist, { key: K }>)[] } = {
  bug: ["seed", "weight", "dah", "dahSpread", "drag", "afterDah", "toDah", "gapSpread", "charGap", "wordGap", "swing", "roger", "rogerDah", "shapeSpread", "tempoSpread", "pause"],
};

/** Whether `v` is a fist, as read back from a saved file. */
export function isFist(v: unknown): v is Fist {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f !== "object" || !HAND_KEYS.includes(f.key as HandKey)) return false;
  return FIST_NUMBERS[f.key as HandKey].every((k) => typeof f[k] === "number" && Number.isFinite(f[k]));
}

/** One character as keyed: the gap before it (0 for a word's first), its
 *  marks, and the spaces between them. */
export interface KeyedChar {
  readonly gap: number;
  readonly marks: readonly number[];
  readonly spaces: readonly number[];
}

/** One word as keyed: the gap before it (0 for the first), and its
 *  characters. */
export interface KeyedWord {
  readonly gap: number;
  readonly chars: readonly KeyedChar[];
}

/** How far the whole fist drifts from one character to the next, and the
 *  most it drifts. */
const DRIFT_STEP = 0.03;
const DRIFT_HOLD = 0.85;
const DRIFT_MOST = 0.12;

/** A pause before a letter, in keyer dits before the line is brought to
 *  speed: shortest and longest. */
const PAUSE_DITS: readonly [number, number] = [0.5, 1.5];

/** How much one dit differs from the next: hardly at all. */
const DIT_SPREAD = 0.015;

/** The shortest a gap made by hand gets, in keyer dits, before the line is
 *  brought to speed: never so short that it runs two marks together. */
const SHORTEST_GAP = 0.5;

/** `words` as keyed at `timing` by `fist`, or exactly with none. */
export function keyed(words: readonly string[], timing: Timing, fist?: Fist): KeyedWord[] {
  if (!fist) return exact(words, timing);
  const scale = scaleOf(timing, fist);
  const rand = seeded(seedOf(`${fist.seed}:${words.join(" ")}`));
  return byHand(words, timing, fist, rand).map((w) => ({
    gap: w.gap * scale,
    chars: w.chars.map((c) => ({
      gap: c.gap * scale,
      marks: c.marks.map((m) => m * scale),
      spaces: c.spaces.map((s) => s * scale),
    })),
  }));
}

/** A keyer: a dit one unit, a dah three, one between, and the station's own
 *  gaps between characters and words. */
function exact(words: readonly string[], timing: Timing): KeyedWord[] {
  const unit = timing.unitSec;
  const charGap = timing.charGapSec || 3 * unit;
  const wordGap = timing.wordGapSec || 7 * unit;
  return words.map((word, wi) => ({
    gap: wi > 0 ? wordGap : 0,
    chars: keyableSymbols(word).map((ch, li) => {
      const pattern = patternOf(ch)!;
      return {
        gap: li > 0 ? charGap : 0,
        marks: Array.from(pattern, (e) => (e === "." ? unit : 3 * unit)),
        spaces: Array.from(pattern.slice(1), () => unit),
      };
    }),
  }));
}

/** A spread around 1: about normal, its spread `sd`. */
function around(rand: () => number, sd: number): number {
  return 1 + (rand() + rand() + rand() - 1.5) * 2 * sd;
}

/** `words` as `fist` keys them, before the line is brought to speed. With
 *  no `rand`, each mark and gap is the operator's usual. Each kind of key
 *  has its own hand. */
function byHand(words: readonly string[], timing: Timing, fist: Fist, rand?: () => number): KeyedWord[] {
  switch (fist.key) {
    case "bug":
      // A fist kept before a habit was added gets that habit from its seed.
      return onBug(words, timing, { ...bugFist(fist.seed), ...fist }, rand);
  }
}

/** `words` as keyed on a bug: even dits from the arm, dahs and the gaps
 *  around them by hand. */
function onBug(words: readonly string[], timing: Timing, fist: BugFist, rand?: () => number): KeyedWord[] {
  const unit = timing.unitSec;
  const charGap = timing.charGapSec || 3 * unit;
  const wordGap = timing.wordGapSec || 7 * unit;
  const dit = 2 * fist.weight * unit;
  const armSpace = 2 * (1 - fist.weight) * unit;
  const vary = (sd: number) => (rand ? around(rand, sd) : 1);
  let drift = 0;
  let last = "";
  return words.map((word, wi) => {
    // A proper roger now and then, for an R on its own.
    const roger = rand && word === "R" && rand() < fist.roger ? fist.rogerDah : 1;
    return {
      gap: wi > 0 ? Math.max(wordGap * fist.wordGap * vary(fist.gapSpread), 1.5 * charGap) : 0,
      chars: keyableSymbols(word).map((ch, li) => {
        const pattern = patternOf(ch)!;
        if (rand) drift = Math.max(-DRIFT_MOST, Math.min(DRIFT_MOST, DRIFT_HOLD * drift + (around(rand, DRIFT_STEP) - 1)));
        // The operator's own shape for this letter, and this letter rushed
        // or dragged.
        const shape = shapeOf(fist, ch, pattern.length);
        const hand = (1 + drift) * (rand ? around(rand, fist.tempoSpread) : 1);
        const swung = li > 0 && last.at(-1) === pattern[0] ? fist.swing * unit : 0;
        const [lo, hi] = PAUSE_DITS;
        const paused = rand ? (rand() < fist.pause ? lo + (hi - lo) * rand() : 0) : fist.pause * (lo + hi) / 2;
        const gap =
          li > 0 ? Math.max(charGap * fist.charGap * (1 + drift) * vary(fist.gapSpread) + swung + paused * unit, 2 * unit) : 0;
        last = pattern;
        const marks: number[] = [];
        const spaces: number[] = [];
        for (let ei = 0; ei < pattern.length; ei++) {
          const e = pattern[ei];
          const next = pattern[ei + 1];
          if (e === ".") marks.push(dit * vary(DIT_SPREAD));
          else {
            const dah = dit * fist.dah * (next === "." ? 1 + fist.drag : 1) * roger * shape.marks[ei]!;
            marks.push(Math.max(dah * hand * vary(fist.dahSpread), 2.5 * dit));
          }
          if (next === undefined) continue;
          if (e === "." && next === ".") spaces.push(armSpace * vary(DIT_SPREAD));
          else {
            const usual = (e === "-" ? fist.afterDah * unit : fist.toDah * armSpace) * shape.spaces[ei]!;
            spaces.push(Math.max(usual * hand * vary(fist.gapSpread), SHORTEST_GAP * unit));
          }
        }
        return { gap, marks, spaces };
      }),
    };
  });
}

/** How `fist` shapes `ch`, its `n` elements: a share for each dah and for
 *  each space after an element, the same each time. Dits and the arm's own
 *  spaces take no share: the arm makes them. */
function shapeOf(fist: BugFist, ch: string, n: number): { marks: number[]; spaces: number[] } {
  const rand = seeded(seedOf(`shape:${fist.seed}:${ch}`));
  return {
    marks: Array.from({ length: n }, () => around(rand, fist.shapeSpread)),
    spaces: Array.from({ length: n }, () => around(rand, 1.5 * fist.shapeSpread)),
  };
}

/** Total length of `words` as keyed. */
function lengthOf(words: readonly KeyedWord[]): number {
  let t = 0;
  for (const w of words) {
    t += w.gap;
    for (const c of w.chars) {
      t += c.gap;
      for (const m of c.marks) t += m;
      for (const s of c.spaces) t += s;
    }
  }
  return t;
}

/** The standard word speed is measured on. */
const PARIS = ["PARIS", "PARIS"];

/** What brings `fist` to the station's speed: its usual PARIS takes as long
 *  as a keyer's at `timing`. */
function scaleOf(timing: Timing, fist: Fist): number {
  return lengthOf(exact(PARIS, timing)) / lengthOf(byHand(PARIS, timing, fist));
}
