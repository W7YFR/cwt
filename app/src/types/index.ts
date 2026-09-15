/* The shared vocabulary.
 *
 * Every other module imports its shapes from here and nothing else imports
 * from those modules in turn, so this file is the one place the data model is
 * written down. That's deliberate: it is what the agreement fixtures test
 * as the thing that keeps shapes honest across the app, and it's why `dsp/`
 * and `timing/` can be pure functions with no environment at all.
 *
 * Times are in SECONDS throughout, never samples and never milliseconds.
 * Durations expressed relative to the dit length are in UNITS, and are named
 * `*Units` without exception. Those two conventions are what let a 48 kHz
 * recording, an 8 kHz decode, and a synthesized target all share one timeline.
 */

// --------------------------------------------------------------------------
// Audio and segmentation
// --------------------------------------------------------------------------

/** Mono audio at a known rate. The only thing `dsp/` accepts. */
export interface AudioClip {
  readonly samples: Float32Array;
  readonly rate: number;
  /** Peak of the samples as loaded, before any normalization. */
  readonly peak: number;
}

/** One key-down or key-up run: `[state, seconds]`, state 1 = tone present.
 *
 * A tuple rather than an object because there are thousands of them and they
 * cross the JSON boundary into saved reports, where `[1,0.06]` beats
 * `{"state":1,"seconds":0.06}` by a factor of four. */
export type Segment = readonly [state: 0 | 1, seconds: number];

// --------------------------------------------------------------------------
// Timing model
// --------------------------------------------------------------------------

/** A dit length plus every threshold derived from it.
 *
 * Produced two ways: `targetTiming()` builds the ideal for a chosen speed,
 * `estimateTiming()` measures one off a recording. Both produce this shape so
 * the grader never needs to know which it was handed. */
export interface Timing {
  /** Dit length in seconds. Everything else follows from this. */
  readonly unitSec: number;
  /** Character (element) speed. */
  readonly charWpm: number;
  /** Overall speed including Farnsworth spacing; never above `charWpm`. */
  readonly farnsworthWpm: number;
  /** Mark threshold: longer than this reads as a dah. */
  readonly ditDahSplit: number;
  /** Gap threshold: longer than this leaves the character. */
  readonly elementCharSplit: number;
  /** Gap threshold: longer than this ends the word. */
  readonly charWordSplit: number;
  /** Nominal inter-character silence, seconds. */
  readonly charGapSec: number;
  /** Nominal inter-word silence, seconds. */
  readonly wordGapSec: number;
  /** Human-readable remarks from the estimator (e.g. Farnsworth detected). */
  readonly notes: readonly string[];
}

// --------------------------------------------------------------------------
// Timeline
// --------------------------------------------------------------------------

/** What a block is: two kinds of mark, three kinds of spacing, plus the rest.
 *
 * `pause` is not a spacing class. It's the sender stopping between
 * transmissions, and it carries no target, which is what keeps a 200-unit
 * breather out of the grade. */
export type BlockKind =
  | "dit"
  | "dah"
  | "element-gap"
  | "char-gap"
  | "word-gap"
  | "pause";

/** The five classes that actually get graded, in report order. */
export const GRADED_KINDS = [
  "dit",
  "dah",
  "element-gap",
  "char-gap",
  "word-gap",
] as const satisfies readonly BlockKind[];

export type GradedKind = (typeof GRADED_KINDS)[number];

/** One keyed mark or one gap, located in absolute time.
 *
 * `kind` is what the decoder *read*, inferred from duration alone — so a
 * Farnsworth-spaced letter gap sent against a tighter target reads as a word
 * gap. `targetKind` is what it was *meant* to be. They're identical until
 * `retarget()` learns otherwise from the intended text.
 *
 * Grading always reads `targetKind`/`targetUnits`. The decoded text and the
 * word-boundary diff always read `kind`, because that is genuinely what came
 * off the air. Keeping both is what makes `retarget` safe to run after
 * pairing: it cannot invalidate the pairing it was handed.
 *
 * Mutable, unlike most shapes here, precisely because `retarget` rewrites the
 * target fields in place on a timeline that other structures already point
 * into. */
export interface Block {
  t0: number;
  t1: number;
  kind: BlockKind;
  /** Measured duration in dit units of the reference timing. */
  units: number;
  /** What a machine sender would have produced. 0 means "not graded". */
  targetUnits: number;
  /** Decoded text preceding a char/word gap, for the report's context column. */
  context: string;
  /** The class this block is graded as; starts equal to `kind`. */
  targetKind: BlockKind;
}

/** One decoded character and the blocks that produced it. */
export interface Char {
  /** "L", "<SK>", or "?" when the pattern matched nothing. */
  char: string;
  pattern: string;
  t0: number;
  t1: number;
  /** Marks and intra-character gaps, in time order. */
  blocks: Block[];
  /** The char/word gap that preceded this character, if any. */
  leadGap: Block | null;
}

/** A decode with its timing structure preserved. */
export interface Timeline {
  text: string;
  chars: Char[];
  /** Every block in time order — marks and gaps both. */
  blocks: Block[];
  /** Keyed span; set for synthesized ideals, 0 for measured decodes. */
  duration: number;
}

// --------------------------------------------------------------------------
// Pairing a decode against an intended message
// --------------------------------------------------------------------------

export type EditOp = "equal" | "sub" | "del" | "ins";

/** One aligned position between a decode and the intended message. */
export interface Slot {
  op: EditOp;
  actual: Char | null;
  ideal: Char | null;
  /** Verdict on the word boundary *before* this character, if there was one. */
  spaceOp: EditOp | null;
}

/** One step of a token alignment. `a` is expected, `b` is what was decoded. */
export interface AlignOp {
  op: EditOp;
  a: string | null;
  b: string | null;
}

/** Text-level scoring of a decode against the intended message. */
export interface Comparison {
  expected: string;
  decoded: string;
  /** Matched symbols over expected symbols. */
  accuracy: number;
  nExpected: number;
  substitutions: number;
  /** Symbols the decode had that the target didn't. */
  insertions: number;
  /** Target symbols the decode missed. */
  deletions: number;
  /** Inline annotated diff, e.g. `CQ DE [W7YFR→W7YFP]`. */
  diff: string;
  /** The raw ops, so a renderer can mark up runs without re-parsing `diff`. */
  ops: AlignOp[];
}

// --------------------------------------------------------------------------
// Grading
// --------------------------------------------------------------------------

export interface ClassStat {
  name: GradedKind;
  n: number;
  meanUnits: number;
  /** Population standard deviation (numpy's ddof=0), not the sample one. */
  stdUnits: number;
  targetUnits: number;
}

export interface Deviation {
  timeSec: number;
  kind: BlockKind;
  valueUnits: number;
  targetUnits: number;
  context: string;
}

export interface Analysis {
  /** The target timing this was graded against. */
  ref: Timing;
  /** The speed actually measured off the recording, for the headline. */
  measured: Timing;
  stats: ClassStat[];
  /** Worst first, capped — see `MAX_DEVIATIONS`. */
  deviations: Deviation[];
  /** Share of graded blocks inside tolerance. */
  withinTolFrac: number;
  /** Relative tolerance used, e.g. 0.30. */
  tolerance: number;
  /** Rests excluded from grading rather than counted as spacing errors. */
  nPauses: number;
}

// --------------------------------------------------------------------------
// A recording and its review
// --------------------------------------------------------------------------

/** Everything needed to review one recording, and nothing derived from it.
 *
 * Deliberately raw: segments in seconds, expected text as text. That's what
 * lets the review re-grade at any speed, Farnsworth spacing, tolerance or
 * intended message without going near the audio again — and it's why this
 * survives as a saved file. */
export interface Take {
  readonly id: string;
  /** ISO 8601, seconds precision. */
  readonly recordedAt: string;
  /** Where the audio came from: a filename, "microphone", "demo". */
  readonly source: string;
  readonly toneHz: number;
  /** Rate the segments were measured at — now always the recording's own. */
  readonly rate: number;
  readonly durationSec: number;
  readonly peak: number;
  readonly segments: readonly Segment[];
  readonly decoded: string;
  /** What the sender meant to key, if they said. */
  readonly expected: string | null;
  readonly expectedSource: string | null;
  readonly measured: Timing;
  /** Target speed the review opens at. */
  readonly target: { charWpm: number; farnsworthWpm: number; explicit: boolean };
  /** Silence to put either side of synthesized target audio, seconds. */
  readonly padSec: number;
  /** The calibration profile this was decoded against, if any.
   *
   * Recorded on the take rather than derived at read time, because a profile
   * can be renamed, recalibrated or deleted and this has to keep meaning what
   * it meant. Without it a directory of reports stops being one time series
   * the moment somebody recalibrates. Optional because takes saved before
   * calibration existed do not have one. */
  readonly profile?: TakeProfile | null;
}

/** Which calibration produced a take, recorded on the take itself. */
export interface TakeProfile {
  readonly id: string;
  readonly nickname: string;
  /** What it corrected by, so a report says how much was taken off and not
   *  only that something was. */
  readonly releaseOffsetSec: number;
  /** True when that number was adjusted by hand rather than measured. A
   *  directory of reports is meant to be one time series, and the two are not
   *  the same kind of fact. */
  readonly adjusted?: boolean;
}

/** Live, user-adjustable review settings. Not part of a `Take`: the same
 *  recording can be looked at through any number of these. */
export interface ReviewSettings {
  charWpm: number;
  farnsworthWpm: number;
  tolerance: number;
  expected: string;
  collapseRests: boolean;
  /** Run a pacing cursor along the target track while recording. Off by
   *  default: it is a practice aid, not a way of reading the chart. */
  paceCursor: boolean;
  /** Seconds of count-in before that cursor sets off. */
  paceLeadSec: number;
  /** Draw each character as one marker rather than as its dits and dahs. */
  charMarkers: boolean;
  /** Put each attempt's two scores in the gutter beside its name.
   *
   * Only ever drawn with a stack on screen — with one attempt the band under
   * the chart is already its score. */
  runScores: boolean;
  /** Show the notes under the chart: what clicking and scrolling do, and
   *  which keys work.
   *
   * On by default — a hint nobody has seen yet cannot be asked for — and off
   * once you know, which is when a permanent instruction becomes furniture. */
  showHints: boolean;
  /** Which attempts the chart draws: every one, or only the most recent.
   *
   * "Last" is for the loop rather than the comparison — send it, look at it,
   * send it again — where the rows behind the one you just made are in the
   * way rather than in the picture. */
  showRuns: "all" | "last";
  /** Offer the four download buttons.
   *
   * Off by default. Getting a file out is an occasional act — archiving a
   * session, sending one to somebody — and a row of four buttons across the
   * page is a permanent invitation to something you do rarely. */
  showDownloads: boolean;
  /** Show the grading tables under the chart: the per-class breakdown, what to
   *  work on next, and the comparison against the intended text.
   *
   * Off by default. They are the deepest thing on the page and the slowest to
   * read, and the two figures in the scores band answer "how did that go" on
   * their own. */
  advancedGrading: boolean;
  /** Caption every attempt with what it decoded to, rather than only the one
   *  being read.
   *
   * The band is reserved on every row either way, so this costs no height —
   * what it costs is a page of text where you may only have wanted one row
   * of it. */
  captionAll: boolean;
  /** Show the next character to send, large, with a countdown to it. */
  flashCard: boolean;
  /** Flash that card on the beat. Separate from showing it: the card is a
   *  reference you glance at, the flash is a cue you react to. */
  flashCue: boolean;
  /** How far ahead of the beat the flash fires, milliseconds — your reaction
   *  time, which is yours. */
  flashLeadMs: number;
  /** Spell the word being sent under the card, greening each letter as it
   *  passes. The card alone says nothing about where a word ends. */
  wordPreview: boolean;
  /** What order the attempts in a session are drawn in. Changes where a row
   *  sits and nothing else — not what it is called, and not what is graded. */
  runSort: RunSort;
  gainDb: number;
  view: ViewMode;
  ppu: number;
}

/** What order a session's attempts are drawn in — see ui/runOrder.ts. */
export type RunSort = "oldest" | "newest" | "best" | "worst";

export type ViewMode = "per-char" | "absolute" | "overlay";

/** Everything the review derives from a `Take` plus its settings. Recomputed
 *  whenever either changes; cheap enough to do synchronously. */
export interface Review {
  readonly take: Take;
  readonly ref: Timing;
  readonly actual: Timeline;
  readonly ideal: Timeline;
  readonly slots: Slot[];
  readonly analysis: Analysis;
  readonly comparison: Comparison | null;
  /** How many gaps `retarget` reclassified from the intended text. */
  readonly retargeted: number;
}
