/* One calibration recording in, one answer out.
 *
 * The pieces this stands on are all in dsp/ and all tested there: splitting a
 * continuous take into its drills, measuring the release offset from the two
 * held-paddle drills, and judging the setup from the decay after a release.
 * What lives here is the orchestration — which section feeds which
 * measurement, and what to say when one of them is missing.
 *
 * It is kept out of the wizard component on purpose. The interesting part of
 * a calibration is arithmetic over a Float32Array, and arithmetic that can
 * only be exercised by rendering a screen and clicking through five prompts is
 * arithmetic that will not get exercised. Everything below runs against a wav
 * file in the pure tier.
 *
 * The failure cases matter more than the success case, because the success
 * case is already covered by dsp/calibrate.ts and the failure cases are what a
 * person actually meets. Each one has to say what to do next: "hold the dah
 * paddle for the second drill" is useful, "calibration failed" is not.
 */

import {
  PROBE,
  assessSetup,
  calibrationIsUsable,
  correctsNothing,
  measureCalibration,
  pairDrills,
  segmentsFrom,
  setupAdvice,
  splitSections,
  type Calibration,
  type Section,
  type SetupQuality,
} from "@/dsp";
import { buildTimeline, estimateTiming } from "@/timing";

/** One thing to send, and how long to spend sending it. */
export interface Drill {
  readonly key: string;
  readonly seconds: number;
  readonly title: string;
  readonly body: string;
  /** How this drill reads in the list on the preamble, where the whole
   *  sequence is described before any of it is asked for. Separate from
   *  `title`, which is what the screen says while you are doing it: "hold the
   *  dit paddle" is an instruction, "a constant stream of dits" is an item in
   *  a list of what you are about to be asked for. */
  readonly summary: string;
  /** An aside on the summary, for the one drill that has one. */
  readonly note?: string;
  /** Seconds between cues, for a drill that is called rather than held.
   *
   * A held paddle needs no cue — you squeeze and the keyer does the rest. A
   * drill of isolated elements does: "one dit every two seconds" asks somebody
   * to keep time in their head for the length of the drill, against a single
   * number counting down from eight, and what comes back is whatever their
   * sense of two seconds happens to be. Calling each one removes the guesswork
   * from the part of the recording the setup verdict is measured from. */
  readonly cueSec?: number;
}

/** When a drill is cued, how many cues it gets.
 *
 * The first lands one interval in, so there is something to wait for rather
 * than a cue you have already missed by the time you have read it. */
export function cueCount(drill: Drill): number {
  return drill.cueSec ? Math.floor(drill.seconds / drill.cueSec) : 0;
}

/** Quiet between drills. Not dead time: it is what the splitter finds the
 *  section boundaries from, and it is also the few seconds in which the next
 *  drill is announced before its clock starts. */
export const REST_SEC = 4;

/** What to ask for, and for how long.
 *
 * The durations are a measurement decision rather than a design one, which is
 * why they live beside the analysis that consumes them. Measured against the
 * corpus by truncating a real calibration recording:
 *
 *   - The held drills converge immediately. Cut to 1.5 seconds they give an
 *     offset of 3.00 ms against the full recording's 2.75, and every length
 *     from 2 seconds up is within 0.15 ms — a fifth of a percent of a dit.
 *     Four seconds is generous.
 *   - The isolated drill needs three releases to be judged at all, which at
 *     two seconds apart is five seconds of recording. Four cues two seconds
 *     apart gives four releases, and the drill runs a second past the last one
 *     so the cue is still on screen when the dit is sent rather than vanishing
 *     as the rest begins.
 *
 * There is deliberately no silence drill. One was asked for and nothing ever
 * read it: the noise floor is not an input to any measurement here, and the
 * pauses either side of every drill already give the splitter the quiet it
 * needs. It cost ten seconds of somebody's attention for nothing.
 *
 * The message at the end feeds no measurement either — but unlike silence it
 * is the one part where the operator watches the thing work, which is worth
 * ten seconds. The preamble promises ten and the constant is where that
 * promise is kept, so the two cannot drift.
 */
const MESSAGE_SEC = 12;

export const DRILLS: readonly Drill[] = [
  {
    key: "dits",
    seconds: 4,
    title: "Hold the dit paddle",
    body: "Squeeze and hold it, and let the keyer run.",
    summary: "a constant stream of dits",
  },
  {
    key: "dahs",
    seconds: 4,
    title: "Hold the dah paddle",
    body: "The same again on the other side.",
    summary: "a constant stream of dahs",
  },
  {
    key: "isolated",
    seconds: 9,
    cueSec: 2,
    title: "One dit on each cue",
    body: "Wait for the cue, then send a single dit. The silence after each one is what gets measured.",
    summary: "one dit every two seconds",
  },
  {
    key: "message",
    seconds: MESSAGE_SEC,
    title: "Send anything you like",
    body: "A call sign, CQ, your name — whatever you like. It gets read back to you.",
    summary: `a ${MESSAGE_SEC} second message of your choosing`,
    note: "Ideally send it from a macro, so the spacing is perfect.",
  },
];

/** Why a calibration could not be made, as a code rather than as a sentence.
 *
 * The sentence beside it is for a person and is expected to be reworded; this
 * is what anything else should branch on or assert against. Keeping the two
 * apart is what stops the copy being load-bearing. */
export type CalibrationProblem =
  /** Nothing was keyed at all. */
  | "no-keying"
  /** One or both held-paddle drills are not in the recording. */
  | "missing-drill"
  /** The drills are there but the elements are all different lengths, so
   *  nothing in the recording looks like a held paddle any more. */
  | "shattered"
  /** Drills were measured and disagree with each other. */
  | "disagree"
  /** Too few elements to measure. */
  | "too-few";

export interface CalibrationRun {
  /** Everything the recording was found to contain, in order. */
  readonly sections: readonly Section[];
  /** The measured profile. Present even when it is not usable, because the
   *  numbers are what explain the refusal. */
  readonly calibration: Calibration | null;
  /** How much room is in this setup, and how fast it can be sent at. */
  readonly quality: SetupQuality;
  /** Whether the profile is worth storing and applying. */
  readonly usable: boolean;
  /** The recording was measurable and the answer was "nothing".
   *
   * Not a failure — it is the best outcome there is, and the one every
   * loopback path gives. It is kept apart from `usable` because the two lead
   * somewhere different: a usable profile is worth naming and saving, and a
   * profile that corrects nothing is worth knowing about and not worth
   * storing. See `correctsNothing`. */
  readonly nothingToCorrect: boolean;
  /** What went wrong, as a code. Null when nothing did. */
  readonly reason: CalibrationProblem | null;
  /** The same thing in the operator's terms. */
  readonly problem: string | null;
  /** What to do about it — the placement advice, or the next step. */
  readonly advice: string;
  /** The closing message, read back through the profile that was just
   *  measured. Null when there was no message in the recording.
   *
   *  The only part of a calibration an operator can check with their own eyes.
   *  Without it the last drill asks for something and then says nothing about
   *  it, which is worse than not asking. */
  readonly readback: Readback | null;
}

export interface Readback {
  readonly text: string;
  readonly charWpm: number;
}

/** One stretch of the recording, named by what it was taken to be.
 *
 * The sections as the splitter found them, not as the wizard asked for them,
 * and that is the point: when a calibration comes back wrong the most useful
 * thing available is hearing what it thought each drill was. A refusal that
 * says "the drills disagree" becomes obvious the moment the dah drill plays
 * back somebody's dits. */
export interface Playable {
  readonly key: string;
  readonly label: string;
  readonly fromSec: number;
  readonly toSec: number;
}

/** The keyed parts of a calibration recording, in order, each named.
 *
 * Silence is left out — there is nothing to hear in it, and the pauses are the
 * one part of the recording nobody needs to check. */
export function playablesOf(run: CalibrationRun): Playable[] {
  const { dits, dahs } = pairDrills(run.sections);
  const mixed = run.sections.filter((s) => s.kind === "mixed");
  const message = mixed.length > 0 ? mixed[mixed.length - 1] : null;

  const named = (s: Section): { key: string; label: string } => {
    if (s === dits) return { key: "dits", label: "Held dits" };
    if (s === dahs) return { key: "dahs", label: "Held dahs" };
    if (s.kind === "isolated") return { key: "isolated", label: "Single dits" };
    if (s === message) return { key: "message", label: "Your message" };
    // Something the splitter found that no measurement asked for. Worth
    // hearing precisely because it was not expected.
    return { key: "other", label: "Other keying" };
  };

  return run.sections
    .filter((s) => s.kind !== "silence")
    .map((s, i) => {
      const { key, label } = named(s);
      return {
        key: `${key}-${i}`,
        label,
        fromSec: s.startSec,
        toSec: s.startSec + s.durationSec,
      };
    });
}

/** Which part of the recording the setup verdict should be measured from.
 *
 * The isolated-element drill, when there is one: two seconds between elements
 * means every release has room for its whole tail, which is the one thing the
 * decay measurement needs. A message with word spacing in it is the next best.
 * The held-paddle drills are the worst possible source — 80 ms between
 * elements at 15 wpm, so nothing can be measured in them at all — which is
 * exactly why the wizard asks for isolated dits even though the calibration
 * itself does not need them. */
function qualitySection(sections: readonly Section[]): Section | null {
  const isolated = sections.find((s) => s.kind === "isolated");
  if (isolated) return isolated;
  const mixed = sections.filter((s) => s.kind === "mixed");
  return mixed.length > 0 ? mixed[mixed.length - 1]! : null;
}

/** Decode the closing message the way a real take of it would be decoded.
 *
 * Through the profile when there is one, because that is what every later
 * recording from this setup will get — reading it back uncorrected would show
 * the operator something the app is never going to do again. */
function readbackOf(
  samples: Float32Array,
  rate: number,
  sections: readonly Section[],
  calibration: Calibration | null,
): Readback | null {
  const mixed = sections.filter((s) => s.kind === "mixed");
  const message = mixed.length > 0 ? mixed[mixed.length - 1]! : null;
  if (!message) return null;
  try {
    const { segments } = segmentsFrom(
      samples.subarray(message.from, message.to),
      rate,
      calibration ? { calibration } : {},
    );
    const timing = estimateTiming(segments);
    const text = buildTimeline(segments, timing).text.trim();
    if (!text) return null;
    return { text, charWpm: timing.charWpm };
  } catch {
    // Nothing readable in it. The rest of the calibration still stands.
    return null;
  }
}

function marksIn(
  samples: Float32Array,
  rate: number,
  section: Section,
): number[] {
  /* Measured with the correction at full strength — see calibrate.ts, where
     the reason a zero-offset profile is declared here rather than nothing at
     all is the whole basis of the measurement being a constant. */
  return segmentsFrom(samples.subarray(section.from, section.to), rate, {
    calibration: PROBE,
  })
    .segments.filter((s) => s[0] === 1)
    .map((s) => s[1]);
}

/** Take one continuous calibration recording apart and measure the setup.
 *
 * `samples` should be peak-normalized. `wpm` is the speed the keyer was set
 * to, which is what makes the held-paddle drills a measurement rather than an
 * observation: the operator supplies the intent and the keyer supplies the
 * timing, so the true element length is known before the recording is made. */
export function analyzeCalibration(
  samples: Float32Array,
  rate: number,
  wpm: number,
): CalibrationRun {
  const sections = splitSections(samples, rate);
  const keyed = sections.filter((s) => s.kind !== "silence");

  const source = qualitySection(sections);
  const quality = source
    ? assessSetup(samples.subarray(source.from, source.to), rate, { wpm })
    : assessSetup(samples, rate, { wpm });

  const fail = (
    reason: CalibrationProblem,
    problem: string,
    advice: string,
  ): CalibrationRun => ({
    sections,
    calibration: null,
    quality,
    usable: false,
    nothingToCorrect: false,
    reason,
    problem,
    advice,
    // Shown even on a refusal: what the message came back as is often the
    // clearest evidence of what went wrong.
    readback: readbackOf(samples, rate, sections, null),
  });

  if (keyed.length === 0) {
    return fail(
      "no-keying",
      "I could not hear any keying in that recording.",
      "Check that the sidetone is reaching the input you picked, then try again.",
    );
  }

  const { dits, dahs } = pairDrills(sections);
  if (!dits || !dahs) {
    /* Two very different causes reach here and they need different answers.
       Either the drills were not sent — the paddle slipped, or somebody keyed
       a message where dits were asked for — or they were sent and the room
       shattered them into elements of every length, so nothing in the
       recording looks like a held paddle any more. The second is what the far
       microphone in the corpus does, and telling its owner to hold the paddle
       would send them off to repeat a recording that cannot work. */
    const roomy = quality.verdict === "marginal" || quality.verdict === "unusable";
    return fail(
      roomy ? "shattered" : "missing-drill",
      roomy
        ? "The elements in that recording are not all the same length, so I could " +
            "not pick out the held-paddle drills."
        : dits
          ? "I found one held-paddle drill but not the other."
          : "I could not find the held-paddle drills.",
      roomy
        ? setupAdvice(quality)
        : "Each one wants a few seconds of a single held paddle — dits for one, " +
          "dahs for the other — with a pause between them.",
    );
  }

  const calibration = measureCalibration(
    [
      { marks: marksIn(samples, rate, dits), units: 1 },
      { marks: marksIn(samples, rate, dahs), units: 3 },
    ],
    wpm,
  );

  if (!calibrationIsUsable(calibration)) {
    /* The refusal that matters. A number is always available — one drill on
       its own will happily suggest 34 ms — and storing it would apply it to
       every later recording from this setup, confidently and wrongly. Drills
       that disagree are not measuring one thing. */
    const ms = (calibration.spreadSec * 1000).toFixed(0);
    const few = calibration.elements < 4;
    return fail(
      few ? "too-few" : "disagree",
      few
        ? "There were not enough elements in the drills to measure anything."
        : `The two drills disagree by ${ms} ms, so there is no single number to store.`,
      setupAdvice(quality),
    );
  }

  const nothing = correctsNothing(calibration);
  return {
    sections,
    calibration,
    quality,
    usable: true,
    nothingToCorrect: nothing,
    reason: null,
    problem: null,
    advice: nothing
      ? "Your keying is arriving at the length it was sent — nothing is being " +
        "added to your elements, so there is nothing to take back off. Record " +
        "as you are."
      : setupAdvice(quality),
    readback: readbackOf(samples, rate, sections, calibration),
  };
}
