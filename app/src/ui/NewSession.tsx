/* Starting a session on purpose.
 *
 * A session is several attempts at ONE message, at ONE speed, over the same
 * number of passes — that is what makes its rows comparable and its drift
 * traces worth putting on the same axis. Changing the target halfway through is therefore a bigger act than
 * editing a text box, and it used to be available only as that: type over the
 * intended message and every attempt already recorded is re-graded against
 * text it never aimed at.
 *
 * The first plan was to warn about it. This is better, because a warning tells
 * you that you might be doing the wrong thing while leaving you to do it
 * anyway — whereas a way to say "new session" is the right thing, named. The
 * box stays editable for what it is good at: fixing a typo in your own
 * callsign, where re-grading is exactly what you want.
 *
 * A textarea rather than a line, because practice text is usually pasted from
 * somewhere and arrives with newlines in it. Whitespace collapses on the way
 * out, so a pasted paragraph is one message.
 */

import { useEffect, useMemo, useState } from "react";
import { DRILLS, fillDrills } from "@/drills";
import { loadUser } from "@/io/storage";
import { TIMES_MAX, TIMES_MIN, passCount } from "@/timing";
import { TIMES_HELP } from "./copy";
import { DrillPicker } from "./DrillPicker";
import { RecDot } from "./Record";
import { useUpperField } from "./useUpperField";

export interface NewSessionProps {
  charWpm: number;
  farnsworthWpm: number;
  /** How many passes of the message make up one attempt — see ReviewSettings. */
  times: number;
  expected: string;
  /** Begin the session. `record` asks for the microphone to open as the
   *  dialog closes — the same act, without the trip back through the record
   *  bar to press the button that was always going to be pressed next. */
  onStart(
    next: {
      expected: string;
      charWpm: number;
      farnsworthWpm: number;
      times: number;
    },
    record: boolean,
  ): void;
  onCancel(): void;
}

/** One message out of however it was pasted in. */
export function oneLine(text: string): string {
  return text.toUpperCase().trim().split(/\s+/).join(" ");
}

export function NewSession(props: NewSessionProps): React.ReactElement {
  const [text, setText] = useState(props.expected.toUpperCase());
  const [charWpm, setCharWpm] = useState(props.charWpm);
  const [farnsworthWpm, setFarnsworthWpm] = useState(props.farnsworthWpm);
  const [times, setTimes] = useState(props.times);
  /* Upper case as it is typed, not only once Start is pressed. The message is
     upper-cased on the way out either way, and a box that shows one thing
     while promising another is the sort of small lie that makes you check. */
  const drills = useMemo(() => fillDrills(DRILLS, loadUser()), []);
  const sent = useUpperField<HTMLTextAreaElement>(setText);
  const box = sent.ref;

  /* Straight into the textarea: the message is the reason the dialog opened,
     and the speeds usually carry over from the session before it. */
  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, []);

  const start = (record: boolean) =>
    props.onStart(
      {
        expected: oneLine(text),
        charWpm,
        // Overall speed can never exceed character speed. Clamped here rather
        // than refused, so a leftover Farnsworth setting cannot block a start.
        farnsworthWpm: Math.min(farnsworthWpm, charWpm),
        times: passCount(times),
      },
      record,
    );

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="newsession-title"
        data-testid="new-session"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
          // Enter sends from the speed boxes; in the textarea it is a newline,
          // which collapses away anyway and is not worth stealing.
          if (e.key === "Enter" && e.target !== box.current) start(false);
        }}
      >
        <h2 id="newsession-title">New session</h2>
        <p className="hint">
          Everything recorded so far is cleared. The attempts in a session are
          all at one message, one speed and one number of passes, which is what
          lets them be read against each other.
        </p>

        <div className="fieldrow">
          <label htmlFor="ns-text">Target message</label>
          <DrillPicker
            drills={drills}
            onPick={(d) => {
              setText(d.text);
              box.current?.focus();
            }}
          />
        </div>
        <textarea
          id="ns-text"
          ref={box}
          rows={4}
          spellCheck={false}
          value={text}
          placeholder="The source of truth to grade against"
          onChange={sent.onChange}
        />

        {/* The three numbers a session is fixed at, in one row. Times belongs
            here and not only in the control row above the chart: it is as much
            a property of what the attempts are as the speed is, and a stack of
            rows where some are one pass and some are five is no more
            comparable than a stack at two speeds. */}
        <div className="numbers">
          <div className="group">
            <label htmlFor="ns-wpm">Character speed</label>
            <CountField id="ns-wpm" value={charWpm} onChange={setCharWpm} min={5} />
          </div>
          <div className="group">
            <label htmlFor="ns-farns">Overall speed</label>
            <CountField
              id="ns-farns"
              value={farnsworthWpm}
              onChange={setFarnsworthWpm}
              min={5}
              max={charWpm}
            />
          </div>
          <div className="group" title={TIMES_HELP}>
            <label htmlFor="ns-times">Times</label>
            <CountField
              id="ns-times"
              value={times}
              onChange={setTimes}
              min={TIMES_MIN}
              max={TIMES_MAX}
              hardMax={TIMES_MAX}
            />
          </div>
        </div>

        {/* Two ways out, because there are two things you came to do.
            Save settles what the session is and leaves you on the review with
            the target ready to play — the right ending when you want to hear
            it first, or set it up now and send later. The dot is the other
            case, and the common one: you know what you are about to send, and
            the next click after Save would have been the record button
            anyway.

            Neither is emphasized. The dot is last in the row, where the eye
            ends up, and it carries the same red dot as every other way into
            the microphone — which is already enough to tell it from the button
            beside it. An accent border on top of that would be a second way of
            saying the same thing, and the app keeps that one for rows where
            the buttons are alike enough to need it. */}
        <div className="confirm">
          <button onClick={props.onCancel}>Cancel</button>
          <button data-testid="start-session" onClick={() => start(false)}>
            Save
          </button>
          <button
            className="iconbtn"
            data-testid="start-session-recording"
            aria-label="Save and record"
            title="Save and start recording straight away"
            onClick={() => start(true)}
          >
            <RecDot />
          </button>
        </div>
      </div>
    </div>
  );
}

/** A whole number: a speed in words per minute, or a count of passes.
 *
 * Held as text while it is being edited, for the reason `NumberField` is: a
 * control that falls back to the committed value on anything unparseable puts
 * the old number straight back under the caret.
 *
 * `max` is the ceiling the value is committed under, which for the overall
 * speed is the character speed and moves as that one is typed; `hardMax` is
 * what the box itself says, and stays put so the stepper does not shrink
 * under the pointer. */
function CountField({
  id,
  value,
  onChange,
  min,
  max = 60,
  hardMax = 60,
}: {
  id: string;
  value: number;
  onChange(v: number): void;
  min: number;
  max?: number;
  hardMax?: number;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      id={id}
      min={min}
      max={hardMax}
      step={1}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= min) onChange(Math.min(n, max));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
