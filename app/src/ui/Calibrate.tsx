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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DRILLS,
  REST_SEC,
  analyzeCalibration,
  cueCount,
  playablesOf,
  type Drill,
  type CalibrationRun,
} from "@/io/calibration";
import { keepCalibration, linkCalibration, loadPrefs, savePrefs } from "@/io/storage";
import { normalized } from "@/dsp";
import { encodeWav, encodeWavBuffer } from "@/audio/wav";
import { createPlayer, type Player } from "@/audio/player";
import { CAL_CORRECTION_HELP, CAL_MAXWPM_HELP, CAL_TAIL_HELP } from "./copy";
import { CalPreview } from "./CalPreview";
import { useUpperField } from "./useUpperField";
import {
  saveProfile,
  selectProfile,
  suggestedName,
  type Profile,
} from "@/io/profiles";
import type { AudioClip } from "@/types";
import { DevicePicker, LevelMeter, RecDot } from "./Record";
import { APP_NAME } from "./Wordmark";
import { useRecorder } from "./useRecorder";

/** Speed to offer first, when nothing better is known. Slow enough that a room
 *  has to be very bad indeed to defeat it, which makes a first calibration
 *  likely to succeed. */
const DEFAULT_WPM = 15;

/** The speed is a property of the keyer, not of a calibration.
 *
 * Retyping it every time is the sort of friction that stops somebody
 * recalibrating after they have moved the microphone — which is the one moment
 * a calibration most needs redoing. */
function rememberedWpm(): number {
  const saved = loadPrefs().keyerWpm;
  return typeof saved === "number" && saved >= 5 && saved <= 40 ? saved : DEFAULT_WPM;
}

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
      // A rest is never listed on the preamble; it is what separates the
      // things that are.
      summary: "",
      rest: true,
    },
    d,
  ]);
}

export const STEPS = buildSteps();

/** Where each step ends, in seconds from the start of the recording. */
export const BOUNDS: readonly number[] = STEPS.reduce<number[]>((acc, s) => {
  acc.push((acc[acc.length - 1] ?? 0) + s.seconds);
  return acc;
}, []);

/** How long the whole sequence takes. */
export const TOTAL_SEC = BOUNDS[BOUNDS.length - 1]!;

/** Which step a recording of this length is in.
 *
 * Derived from the clock rather than accumulated by a counter, and that is the
 * whole design. A counter has to be advanced by something, which means an
 * effect that fires once per boundary and must not fire twice — and it did:
 * one stale render, or one effect re-run against a dependency that changes
 * identity every render, and the sequence skips a drill or runs to the end.
 * Asking "what time is it" instead has no such state to get wrong, and it
 * makes restarting free, since zeroing the recorder's clock is the same thing
 * as going back to the first step. */
export function stepAt(elapsed: number): number {
  const i = BOUNDS.findIndex((b) => elapsed < b);
  return i === -1 ? STEPS.length - 1 : i;
}

type Stage = "setup" | "recording" | "measuring" | "result";

export interface CalibrateProps {
  /** The calibration in use right now, if any. Shown so that "Recalibrate"
   *  can say what it is about to do — it makes a new calibration and leaves
   *  this one alone, which is not what the word implies. */
  current: Profile | null;
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
  /* Held as text, not as a number.
     Clearing the box to type a new speed sends an empty string through
     `onChange`, and a numeric state that falls back to a default on anything
     unparseable puts "15" straight back into the field you just emptied — so
     the next keystroke lands on the end of it. The fallback belongs to the
     measurement, which does need a number, not to the field. */
  const [wpmText, setWpmText] = useState(() => String(rememberedWpm()));
  const wpm = Number(wpmText) || DEFAULT_WPM;
  const [stage, setStage] = useState<Stage>("setup");
  const [run, setRun] = useState<CalibrationRun | null>(null);
  /* Kept so the result can be played back. The analysis runs on a normalized
     copy; this is the recording as it was captured, which is what should come
     out of the speakers. */
  const [clip, setClip] = useState<AudioClip | null>(null);
  const [nickname, setNickname] = useState("");
  /* What the closing message was meant to be. Prefilled from the landing
     screen, because somebody who has already typed what they are practicing
     has almost certainly just sent it again. Optional: without it the preview
     grades against its own decode, which still shows the element lengths. */
  const [expected, setExpected] = useState(() => loadPrefs().expected ?? "");
  /* An offset set by hand, or null for the one that was measured.
     Null rather than seeding it with the measurement, so "has this been
     changed" is a fact about the state and not a floating-point comparison. */
  const [offsetSec, setOffsetSec] = useState<number | null>(null);

  /* The speed is read inside a callback that must not be rebuilt on every
     keystroke, or the recorder would be torn down mid-drill. */
  const wpmRef = useRef(wpm);
  wpmRef.current = wpm;

  const onClip = useCallback(
    (clip: AudioClip) => {
      setStage("measuring");
      setClip(clip);
      // Peak-normalized, like every other path into the DSP — the threshold
      // works on absolute amplitude and a quiet recording would otherwise
      // measure a different room from a loud one.
      const forAnalysis = normalized(clip);
      const result = analyzeCalibration(
        forAnalysis.samples,
        forAnalysis.rate,
        wpmRef.current,
      );
      setRun(result);
      setStage("result");

      /* Kept whatever came of it, and the refusals above all. A calibration
         that misbehaves in somebody's room used to leave nothing behind to
         look at — the one artifact that could explain the answer was the one
         thing thrown away. */
      const when = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
      const id = `cal-${when.replace(/[-:T]/g, "").slice(0, 14)}`;
      attempt.current = id;
      void keepCalibration({
        id,
        recordedAt: when,
        audio: encodeWav(clip.samples, clip.rate),
        durationSec: clip.samples.length / clip.rate,
        wpm: wpmRef.current,
        reason: result.reason,
        verdict: result.quality.verdict,
        offsetSec: result.calibration?.releaseOffsetSec ?? null,
        profileId: null,
        deviceLabel: deviceRef.current ?? null,
      });
    },
    [],
  );

  /* The id of the attempt just recorded, so saving a profile can point back at
     the audio it came from. */
  const attempt = useRef<string | null>(null);

  const rec = useRecorder({ deviceId: props.deviceId, onClip, onError });

  /* Only ever a fallback for the name field. What names a setup is where the
     microphone is, which no device list knows. */
  const deviceLabel = rec.devices.find((d) => d.deviceId === props.deviceId)?.label;
  // Read inside `onClip`, which must not be rebuilt when the device list
  // resolves — that would tear the recorder down mid-drill.
  const deviceRef = useRef(deviceLabel);
  deviceRef.current = deviceLabel;

  /* Prompts run on the recorder's own clock rather than on a timer of their
     own, so the prompt on screen and the audio being captured cannot drift
     apart. The recording never stops between drills — the pauses are part of
     it, and are what the splitter finds the section boundaries from. */
  const step = stepAt(rec.elapsed);
  const current = STEPS[step]!;
  const stepStart = step === 0 ? 0 : BOUNDS[step - 1]!;
  const left = Math.max(0, Math.ceil(current.seconds - (rec.elapsed - stepStart)));

  /* Stopping is the one thing here that is not derived, so it is the one thing
     that needs guarding. The effect below runs on every render whose clock has
     moved, and two of those can land before the recorder reports that it has
     closed — which would stop an already-released device. */
  const stopping = useRef(false);

  const finish = useCallback(() => {
    if (stopping.current) return;
    stopping.current = true;
    void rec.finish();
  }, [rec]);

  useEffect(() => {
    if (stage !== "recording" || !rec.recorder) return;
    if (rec.elapsed < TOTAL_SEC) return;
    finish();
  }, [finish, rec.elapsed, rec.recorder, stage]);

  const start = useCallback(async () => {
    savePrefs({ ...loadPrefs(), keyerWpm: wpmRef.current });
    stopping.current = false;
    setRun(null);
    setClip(null);
    setOffsetSec(null);
    setStage("recording");
    await rec.start();
  }, [rec]);

  /* Begin again from the lead-in, keeping the device open. What was captured
     so far is thrown away — a restart that kept it would leave two of some
     drills in one recording and let the splitter choose between them — and
     because the step is the clock, zeroing the clock is the whole of it. */
  const restart = useCallback(() => {
    rec.restart();
  }, [rec]);

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
      releaseOffsetSec: offsetSec ?? run.calibration.releaseOffsetSec,
      // Kept whether or not it was changed, so "reset" has a target and a
      // report can say which kind of number it leaned on.
      measuredOffsetSec: run.calibration.releaseOffsetSec,
      spreadSec: run.calibration.spreadSec,
      elements: run.calibration.elements,
      verdict: run.quality.verdict,
      decaySec: run.quality.decaySec,
      maxWpm: run.quality.maxWpm,
      recordedAt: when,
    };
    saveProfile(profile);
    selectProfile(profile.id);
    if (attempt.current) void linkCalibration(attempt.current, profile.id);
    onSaved(profile);
  }, [deviceLabel, nickname, offsetSec, onSaved, props, run]);

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
        clip={clip}
        expected={expected}
        onExpected={setExpected}
        offsetSec={offsetSec}
        onOffsetSec={setOffsetSec}
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

        {/* Fixed rows, so a longer prompt cannot push the clock down the page.
            The sequence is read at a glance by somebody whose hands are on a
            paddle, and a countdown that moves between steps is read twice. */}
        <div className="stage">
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
              {current.cueSec ? (
                <Cue drill={current} into={rec.elapsed - stepStart} />
              ) : (
                <div className="countdown" aria-live="polite">
                  {left}s
                </div>
              )}
            </>
          )}
        </div>

        <LevelMeter level={rec.level} />
        {/* No way to skip a step and no way to stop early.
            Every drill is a measurement or the thing a measurement is checked
            against, so a sequence run halfway produces a refusal rather than a
            shorter answer — and offering the button implied otherwise. What is
            left is starting over, and leaving. */}
        <div className="rowbuttons">
          <button onClick={restart}>Restart</button>
          <button className="link" onClick={cancel}>
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="calibrate">
      <h2>Calibrate your microphone.</h2>

      <div className="lede preamble" data-testid="setup-note">
        <p>
          The best way to use {APP_NAME} is by connecting your keyer&rsquo;s
          sidetone directly to your computer. This prevents microphone issues
          that make it difficult to process your keying. If a direct line in is
          not possible, calibration is your next best option.
        </p>
        <p>
          During calibration you will receive {DRILLS.length} prompts, separated
          by a {REST_SEC} second pause. In order, you will send:
        </p>
        {/* Built from the drill list rather than retyped beside it, so the
            promise on this screen and the sequence that follows cannot drift
            apart — the count, the order and the length of the message are all
            the same constants the recording runs on. */}
        <ol className="drilllist" data-testid="drilllist">
          {DRILLS.map((d) => (
            <li key={d.key} data-step={d.key}>
              {d.summary}
              {d.note && <span className="hint"> {d.note}</span>}
            </li>
          ))}
        </ol>
      </div>

      {props.current && (
        <p className="hint" data-testid="keeps-current">
          <b>Note:</b> Your previous calibration <b>{props.current.nickname}</b> will be retained.<br />
          Running the wizard again creates a new
          calibration and keeps the old ones.
        </p>
      )}

      <label className="field row">
        <span className="fieldname">Keyer speed</span>
        <input
          type="number"
          min={5}
          max={40}
          value={wpmText}
          aria-label="Keyer speed in words per minute"
          onChange={(e) => setWpmText(e.target.value)}
        />
      </label>

      <DevicePicker
        label="Microphone"
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

/** The clock for a called drill.
 *
 * A number counting down from nine tells you how long the drill has left,
 * which is not what you need to know: you need to know when the next dit is.
 * So the clock counts to the next cue and then calls it, and the drill's own
 * remaining time stops being on screen at all — it is the wizard's business,
 * not the operator's.
 *
 * The call stays up for a moment after the beat rather than blinking out on
 * it, because a cue that vanishes at the instant you are meant to act on it is
 * one you are always slightly late for. After the last cue it simply stays,
 * through the second of drill that follows it. */
const CALL_SEC = 0.7;

export function Cue({
  drill,
  into,
}: {
  drill: Drill;
  into: number;
}): React.ReactElement {
  const every = drill.cueSec ?? 0;
  const total = cueCount(drill);
  const fired = every > 0 ? Math.floor(Math.max(into, 0) / every) : 0;
  const calling = fired >= 1 && into - fired * every < CALL_SEC;
  const waiting = fired + 1 <= total;
  const now = calling || !waiting;

  return (
    <div
      className={`countdown cue ${now ? "now" : ""}`}
      aria-live="polite"
      data-testid="cue"
      data-cue={now ? "now" : "wait"}
      data-fired={Math.min(fired, total)}
    >
      {now ? (
        "dit"
      ) : (
        <>
          <span className="cdlabel">dit in</span>{" "}
          {Math.max(1, Math.ceil((fired + 1) * every - into))}s
        </>
      )}
    </div>
  );
}

interface ResultProps {
  run: CalibrationRun;
  clip: AudioClip | null;
  expected: string;
  onExpected(text: string): void;
  /** A correction set by hand, or null for the measured one. */
  offsetSec: number | null;
  onOffsetSec(v: number | null): void;
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

/** Hearing the recording back, a section at a time.
 *
 * The audio context is built on the first click and not before: this screen
 * renders in environments that have no Web Audio at all, and a calibration
 * nobody plays back should cost nothing. */
function Sections({
  run,
  clip,
}: {
  run: CalibrationRun;
  clip: AudioClip | null;
}): React.ReactElement | null {
  const player = useRef<Player | null>(null);
  const bytes = useRef<ArrayBuffer | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => () => player.current?.destroy(), []);

  const parts = clip ? playablesOf(run) : [];

  const play = (key: string, fromSec: number, toSec: number) => {
    if (!clip) return;
    if (!player.current) {
      player.current = createPlayer({ onEnded: () => setPlaying(null) });
    }
    if (playing === key) {
      player.current.stop();
      setPlaying(null);
      return;
    }
    bytes.current ??= encodeWavBuffer(clip.samples, clip.rate);
    setPlaying(key);
    void player.current.playBuffer(bytes.current, fromSec, toSec);
  };

  if (parts.length === 0) return null;

  return (
    <div className="sections" data-testid="sections">
      <span className="uplabel">What I heard</span>
      <div className="rowbuttons">
        {parts.map((p) => (
          <button
            key={p.key}
            data-testid="section-play"
            data-section={p.key}
            onClick={() => play(p.key, p.fromSec, p.toSec)}
          >
            <i className="ico">{playing === p.key ? "■" : "▶"}</i>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Overriding the measured correction by hand.
 *
 * One control, because there is one number. A calibration carries four and
 * only `releaseOffsetSec` is an input to anything: `spreadSec` and `elements`
 * are evidence *about* the measurement — how much the drills disagreed, and
 * how many elements stood behind it — and `wpm` is the speed they were keyed
 * at. Sliders for those would be three controls that change nothing.
 *
 * Behind a disclosure because the measured answer is right nearly always, and
 * a knob on screen invites turning. What it is for is the case an algorithm
 * taking a median cannot handle: noticing that the answer looks wrong. That
 * only works with the chart above it moving as this moves, which is why it
 * sits below the preview and not beside the numbers.
 *
 * No clamping beyond the slider's own ends. `MAX_SHRINK` in dsp/calibrate.ts
 * already refuses to take more than 60% off a mark, so a silly value here is
 * bounded by the same guard a measured one is. */
function Advanced({
  measuredSec,
  wpm,
  value,
  onChange,
}: {
  measuredSec: number;
  wpm: number;
  value: number | null;
  onChange(v: number | null): void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const current = value ?? measuredSec;
  // Two dits at the speed it was calibrated at. Past that the guard in the DSP
  // is doing all the work anyway.
  const max = Math.max(2 * (1.2 / (wpm || 15)), measuredSec * 2);
  const changed = value !== null && value !== measuredSec;

  return (
    <div className="advanced" data-testid="advanced" data-open={String(open)}>
      <button className="link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide advanced" : "Advanced"}
      </button>
      {open && (
        <div className="advbody">
          <label htmlFor="cal-offset">
            Correction{" "}
            <output id="cal-offset-out" data-testid="offset-out">
              {(current * 1000).toFixed(1)} ms
            </output>
          </label>
          <div className="sliderow">
            <input
              type="range"
              id="cal-offset"
              min={0}
              max={Math.round(max * 10000)}
              step={1}
              value={Math.round(current * 10000)}
              data-testid="offset"
              onChange={(e) => onChange(Number(e.target.value) / 10000)}
            />
            <button onClick={() => onChange(null)} disabled={!changed}>
              Reset
            </button>
          </div>
          <p className="hint" data-testid="offset-state" data-adjusted={String(changed)}>
            {changed
              ? `Set by hand. The drills measured ${(measuredSec * 1000).toFixed(1)} ms, and reports made with this calibration will say the number was adjusted.`
              : "As measured from the drills."}
          </p>
        </div>
      )}
    </div>
  );
}

function Result(props: ResultProps): React.ReactElement {
  const measured = props.run;
  const sent = useUpperField(props.onExpected);
  /* Everything below reads the adjusted run, so the readout, the preview and
     what gets saved cannot disagree about which number is in force. */
  const run = useMemo<CalibrationRun>(() => {
    if (props.offsetSec === null || !measured.calibration) return measured;
    return {
      ...measured,
      calibration: { ...measured.calibration, releaseOffsetSec: props.offsetSec },
    };
  }, [measured, props.offsetSec]);
  const ms = (v: number) => `${(v * 1000).toFixed(1)} ms`;
  /* A verdict of "unknown" has nothing in it. "Setup: could not tell" reads as
     a finding and is not one, and on a screen already reporting that something
     went wrong it is one more thing to take in for no gain. */
  const told = run.quality.verdict !== "unknown";

  return (
    <div className="calibrate result">
      <h2 data-testid="outcome" data-usable={String(run.usable)}>
        {run.usable ? "Measured" : "Something's not working"}
      </h2>

      {run.problem && (
        <p className="banner error" role="alert" data-reason={run.reason ?? ""}>
          {run.problem}
        </p>
      )}

      <dl className="readout">
        {told && (
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
        )}
        {Number.isFinite(run.quality.decaySec) && (
          <div>
            <dt title={CAL_TAIL_HELP}>Tail</dt>
            <dd>{ms(run.quality.decaySec)} after each element</dd>
          </div>
        )}
        {Number.isFinite(run.quality.maxWpm) && (
          <div>
            <dt title={CAL_MAXWPM_HELP}>Max WPM</dt>
            <dd>{run.quality.maxWpm} wpm</dd>
          </div>
        )}
        {run.calibration && (
          <div>
            <dt title={CAL_CORRECTION_HELP}>Correction</dt>
            <dd>{ms(run.calibration.releaseOffsetSec)} off every element</dd>
          </div>
        )}
      </dl>

      <Sections run={run} clip={props.clip} />

      {run.readback && (
        <div className="readback" data-testid="readback">
          <span className="uplabel">What I read back</span>
          <strong data-testid="readback-text">{run.readback.text}</strong>
          <span className="hint">at {run.readback.charWpm.toFixed(1)} wpm</span>
        </div>
      )}

      {props.clip && (
        <>
          {/* The readback says whether the decode is right. A calibration is
              about whether the *lengths* are right, and only the chart shows
              that — so the target is worth asking for here even though the
              drill did not. */}
          <label className="field">
            <span className="fieldname">What did you send?</span>
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="optional — gives the chart something to aim at"
              value={props.expected}
              ref={sent.ref}
              onChange={sent.onChange}
              aria-label="What did you send"
              data-testid="cal-expected"
            />
          </label>
          <CalPreview clip={props.clip} run={run} expected={props.expected} />
        </>
      )}

      {measured.calibration && (
        <Advanced
          measuredSec={measured.calibration.releaseOffsetSec}
          wpm={measured.calibration.wpm}
          value={props.offsetSec}
          onChange={props.onOffsetSec}
        />
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
