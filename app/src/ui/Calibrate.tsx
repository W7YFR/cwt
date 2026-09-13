/* Measuring a microphone and a room, as something a person can actually do.
 *
 * One continuous recording, not six. Starting and stopping a recorder between
 * each drill is a poor thing to ask of anybody — and the person being asked is
 * holding a paddle, not a mouse — so the prompts run on a clock while the
 * recorder keeps rolling, and the recording is taken apart afterwards. Nothing
 * here tells the analysis where the sections are; it finds them itself, which
 * is why the timings below are a guide rather than a contract. Leaving four
 * seconds of pause where five was asked for costs nothing.
 *
 * Two drills are the measurement: a held dit paddle and a held dah paddle,
 * whose element lengths the keyer supplies and are therefore known before the
 * recording is made. The isolated dits are not part of the calibration at all
 * — they are what the setup verdict is measured from, because a release needs
 * a couple of seconds of quiet after it before its tail can be seen. The
 * message at the end is a check you can read with your own eyes.
 *
 * What the screen is really for is the advice at the end. The single largest
 * effect measured anywhere in this work was moving a microphone closer to the
 * speaker, and a wizard that reports a correction factor while saying nothing
 * about placement would be hiding its most useful finding behind its least.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DRILLS,
  REST_SEC,
  analyzeCalibration,
  type Drill,
  type CalibrationRun,
} from "@/io/calibration";
import { normalized } from "@/dsp";
import {
  saveProfile,
  selectProfile,
  suggestedName,
  type Profile,
} from "@/io/profiles";
import type { AudioClip } from "@/types";
import { DevicePicker, LevelMeter, RecDot } from "./Record";
import { useRecorder } from "./useRecorder";

/** Speed to offer first. Slow enough that a room has to be very bad indeed to
 *  defeat it, which makes a first calibration likely to succeed. */
const DEFAULT_WPM = 15;

export interface Step extends Drill {
  /** Rests are the pauses between drills, and they are load-bearing: the
   *  quiet is what tells the splitter where one section ends, and it is also
   *  where the next drill gets announced. */
  readonly rest?: boolean;
}

/** The drills, each with a rest in front of it.
 *
 * In front rather than between, which is the difference between a wizard you
 * can follow and one you are always a step behind. A drill announced only when
 * its own clock starts gives you no time to read it, understand it and get a
 * hand to the paddle — so every drill gets a few seconds ahead of it in which
 * the next thing is on screen and nothing is being asked of you yet.
 *
 * The rests are load-bearing for a second reason as well: the quiet in them is
 * what the splitter finds the section boundaries from. */
export function buildSteps(drills: readonly Drill[] = DRILLS): Step[] {
  return drills.flatMap((d, i) => [
    {
      key: `rest-${i}`,
      seconds: REST_SEC,
      title: i === 0 ? "Get ready" : "Pause",
      body:
        i === 0
          ? "Nothing to do yet. The recording has started."
          : "Hands off the paddle — the quiet is part of the measurement.",
      rest: true,
    },
    d,
  ]);
}

export const STEPS = buildSteps();

type Stage = "setup" | "recording" | "measuring" | "result";

export interface CalibrateProps {
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  onError(message: string): void;
  /** Saved and selected — the caller re-reads the store. */
  onSaved(profile: Profile): void;
  onClose(): void;
  /** Injected so a test does not have to mock the clock. */
  now?(): Date;
}

export function Calibrate(props: CalibrateProps): React.ReactElement {
  const { onError, onSaved } = props;
  const [wpm, setWpm] = useState(DEFAULT_WPM);
  const [stage, setStage] = useState<Stage>("setup");
  const [step, setStep] = useState(0);
  const [run, setRun] = useState<CalibrationRun | null>(null);
  const [nickname, setNickname] = useState("");

  /* The speed is read inside a callback that must not be rebuilt on every
     keystroke, or the recorder would be torn down mid-drill. */
  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;

  const onClip = useCallback(
    (clip: AudioClip) => {
      setStage("measuring");
      // Peak-normalized, like every other path into the DSP — the threshold
      // works on absolute amplitude and a quiet recording would otherwise
      // measure a different room from a loud one.
      const forAnalysis = normalized(clip);
      setRun(analyzeCalibration(forAnalysis.samples, forAnalysis.rate, wpmRef.current));
      setStage("result");
    },
    [],
  );

  const rec = useRecorder({ deviceId: props.deviceId, onClip, onError });

  /* Only ever a fallback for the name field. What names a setup is where the
     microphone is, which no device list knows. */
  const deviceLabel = rec.devices.find((d) => d.deviceId === props.deviceId)?.label;

  /* Phases run on the recorder's own clock rather than on a timer of their
     own, so the prompt on screen and the audio being captured cannot drift
     apart. The recording never stops between drills — the pauses are part of
     it, and are what the splitter finds the section boundaries from — so
     "next" moves where this step began rather than pausing anything.

     `stepStart` is state and is set in the same update as `step`, not in an
     effect afterwards. Set later, the render in between would compute a step
     that had already run out of time and advance straight through it. */
  const [stepStart, setStepStart] = useState(0);
  const current = STEPS[step] ?? STEPS[STEPS.length - 1]!;
  const left = Math.max(0, Math.ceil(current.seconds - (rec.elapsed - stepStart)));
  const last = step >= STEPS.length - 1;

  const advance = useCallback((at: number) => {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
    setStepStart(at);
  }, []);

  const finish = useCallback(() => {
    void rec.finish();
  }, [rec]);

  useEffect(() => {
    if (stage !== "recording" || left > 0) return;
    // From the boundary rather than from now, so a late render does not shorten
    // the step that follows it.
    if (last) finish();
    else advance(stepStart + current.seconds);
  }, [advance, current.seconds, finish, last, left, stage, stepStart]);

  const start = useCallback(async () => {
    setStep(0);
    setStepStart(0);
    setRun(null);
    setStage("recording");
    await rec.start();
  }, [rec]);

  const skip = useCallback(() => {
    if (last) finish();
    else advance(rec.elapsed);
  }, [advance, finish, last, rec.elapsed]);

  const cancel = useCallback(() => {
    void rec.discard();
    setStage("setup");
  }, [rec]);

  const save = useCallback(() => {
    if (!run?.calibration) return;
    const when = (props.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, "+00:00");
    const name = nickname.trim() || suggestedName(deviceLabel, when);
    const profile: Profile = {
      id: `${when.replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`,
      nickname: name,
      deviceId: props.deviceId,
      deviceLabel,
      wpm: run.calibration.wpm,
      releaseOffsetSec: run.calibration.releaseOffsetSec,
      spreadSec: run.calibration.spreadSec,
      elements: run.calibration.elements,
      verdict: run.quality.verdict,
      decaySec: run.quality.decaySec,
      maxWpm: run.quality.maxWpm,
      recordedAt: when,
    };
    saveProfile(profile);
    selectProfile(profile.id);
    onSaved(profile);
  }, [deviceLabel, nickname, onSaved, props, run]);

  if (stage === "measuring") {
    return (
      <div className="busy" role="status">
        measuring your room…
      </div>
    );
  }

  if (stage === "result" && run) {
    return (
      <Result
        run={run}
        nickname={nickname}
        onNickname={setNickname}
        suggestion={suggestedName(deviceLabel, new Date().toISOString())}
        onSave={save}
        onRetry={() => void start()}
        onClose={props.onClose}
      />
    );
  }

  if (stage === "recording") {
    /* On a rest the screen is about what comes next, not about the rest
       itself: that is the whole point of having one. The step number follows
       the same rule and counts the drill being led up to, rather than blanking
       out for four seconds in the middle of a sequence somebody is trying to
       keep their place in. */
    const upcoming = current.rest
      ? (STEPS.slice(step + 1).find((s) => !s.rest) ?? null)
      : null;
    const shown = upcoming ?? current;
    const number = DRILLS.findIndex((d) => d.key === shown.key) + 1;

    return (
      <div className="calibrate recording">
        <div className="reclight" data-testid="stepcount" data-step={number}>
          <span className="dot" />
          step {number} of {DRILLS.length}
        </div>

        {current.rest ? (
          <>
            <h2 className="prompt rest" data-testid="prompt" data-rest="true">
              {current.title}
            </h2>
            <div className="upnext" data-testid="upnext" data-step={shown.key}>
              <span className="uplabel">Next up</span>
              <strong>{shown.title}</strong>
              <p className="lede">{shown.body}</p>
            </div>
            <div className="countdown" aria-live="polite">
              <span className="cdlabel">starts in</span> {left}s
            </div>
          </>
        ) : (
          <>
            <h2 className="prompt" data-testid="prompt" data-rest="false">
              {current.title}
            </h2>
            <p className="lede">{current.body}</p>
            <div className="countdown" aria-live="polite">
              {left}s
            </div>
          </>
        )}

        <LevelMeter level={rec.level} />
        <div className="rowbuttons">
          <button className="big" onClick={skip}>
            {last ? "Done" : "Next"}
          </button>
          <button onClick={finish}>Stop here and measure</button>
        </div>
        <button className="link" onClick={cancel}>
          cancel
        </button>
      </div>
    );
  }

  return (
    <div className="calibrate">
      <h2>Calibrate this microphone</h2>
      <p className="lede">
        Four short prompts, about forty seconds. Calibrating lets this read
        your sending as accurately as your setup allows.
      </p>
      <p className="lede" data-testid="placement-note">
        If a microphone is listening to a speaker,{" "}
        <strong>move it as close as you can</strong> before starting.
      </p>

      <label className="group">
        Keyer speed
        <span className="hint">the speed your keyer is set to</span>
        <input
          type="number"
          min={5}
          max={40}
          value={wpm}
          aria-label="Keyer speed in words per minute"
          onChange={(e) => setWpm(Number(e.target.value) || DEFAULT_WPM)}
        />
      </label>

      <DevicePicker
        devices={rec.devices}
        value={props.deviceId}
        onChange={props.onDeviceChange}
      />

      <div className="rowbuttons">
        <button className="big" onClick={() => void start()}>
          <RecDot /> Start calibrating
        </button>
        <button onClick={props.onClose}>Back</button>
      </div>
    </div>
  );
}

interface ResultProps {
  run: CalibrationRun;
  nickname: string;
  suggestion: string;
  onNickname(v: string): void;
  onSave(): void;
  onRetry(): void;
  onClose(): void;
}

const VERDICT_LABEL: Record<string, string> = {
  clean: "Nothing to correct",
  good: "Good",
  marginal: "Marginal",
  unusable: "Not usable",
  unknown: "Could not tell",
};

function Result(props: ResultProps): React.ReactElement {
  const { run } = props;
  const ms = (v: number) => `${(v * 1000).toFixed(1)} ms`;

  return (
    <div className="calibrate result">
      <h2 data-testid="outcome" data-usable={String(run.usable)}>
        {run.usable ? "Measured" : "Not measured"}
      </h2>

      {run.problem && (
        <p className="banner error" role="alert" data-reason={run.reason ?? ""}>
          {run.problem}
        </p>
      )}

      <dl className="readout">
        <div>
          <dt>Setup</dt>
          <dd
            className={`verdict ${run.quality.verdict}`}
            data-testid="verdict"
            data-verdict={run.quality.verdict}
          >
            {VERDICT_LABEL[run.quality.verdict] ?? run.quality.verdict}
          </dd>
        </div>
        {Number.isFinite(run.quality.decaySec) && (
          <div>
            <dt>Tail</dt>
            <dd>{ms(run.quality.decaySec)} after each element</dd>
          </div>
        )}
        {Number.isFinite(run.quality.maxWpm) && (
          <div>
            <dt>Good to about</dt>
            <dd>{run.quality.maxWpm} wpm</dd>
          </div>
        )}
        {run.calibration && (
          <div>
            <dt>Correction</dt>
            <dd>{ms(run.calibration.releaseOffsetSec)} off every element</dd>
          </div>
        )}
      </dl>

      {run.readback && (
        <div className="readback" data-testid="readback">
          <span className="uplabel">What I read back</span>
          <strong data-testid="readback-text">{run.readback.text}</strong>
          <span className="hint">at {run.readback.charWpm.toFixed(1)} wpm</span>
        </div>
      )}

      <p className="lede advice">{run.advice}</p>

      {run.usable ? (
        <>
          <label className="group">
            Name this calibration to reuse it later
            <input
              type="text"
              placeholder={props.suggestion}
              value={props.nickname}
              aria-label="Name this calibration"
              data-testid="nickname"
              onChange={(e) => props.onNickname(e.target.value)}
            />
          </label>
          <div className="rowbuttons">
            <button className="big" onClick={props.onSave}>
              Save and use it
            </button>
            <button onClick={props.onRetry}>Record again</button>
          </div>
        </>
      ) : (
        <div className="rowbuttons">
          <button className="big" onClick={props.onRetry}>
            Try again
          </button>
          <button onClick={props.onClose}>Back</button>
        </div>
      )}
    </div>
  );
}
