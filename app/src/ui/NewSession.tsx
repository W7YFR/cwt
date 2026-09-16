/* Starting a session on purpose.
 *
 * A session is several attempts at ONE message at ONE speed — that is what
 * makes its rows comparable and its drift traces worth putting on the same
 * axis. Changing the target halfway through is therefore a bigger act than
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

import { useEffect, useState } from "react";
import { useUpperField } from "./useUpperField";

export interface NewSessionProps {
  charWpm: number;
  farnsworthWpm: number;
  expected: string;
  onStart(next: { expected: string; charWpm: number; farnsworthWpm: number }): void;
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
  /* Upper case as it is typed, not only once Start is pressed. The message is
     upper-cased on the way out either way, and a box that shows one thing
     while promising another is the sort of small lie that makes you check. */
  const sent = useUpperField<HTMLTextAreaElement>(setText);
  const box = sent.ref;

  /* Straight into the textarea: the message is the reason the dialog opened,
     and the speeds usually carry over from the session before it. */
  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, []);

  const start = () =>
    props.onStart({
      expected: oneLine(text),
      charWpm,
      // Overall speed can never exceed character speed. Clamped here rather
      // than refused, so a leftover Farnsworth setting cannot block a start.
      farnsworthWpm: Math.min(farnsworthWpm, charWpm),
    });

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
          if (e.key === "Enter" && e.target !== box.current) start();
        }}
      >
        <h2 id="newsession-title">New session</h2>
        <p className="hint">
          Everything recorded so far is cleared. The attempts in a session are
          all at one message and one speed, which is what lets them be read
          against each other.
        </p>

        <label htmlFor="ns-text">Target message</label>
        <textarea
          id="ns-text"
          ref={box}
          rows={4}
          spellCheck={false}
          value={text}
          placeholder="The source of truth to grade against"
          onChange={sent.onChange}
        />

        <div className="speeds">
          <div className="group">
            <label htmlFor="ns-wpm">Character speed</label>
            <SpeedField id="ns-wpm" value={charWpm} onChange={setCharWpm} />
          </div>
          <div className="group">
            <label htmlFor="ns-farns">Overall speed</label>
            <SpeedField
              id="ns-farns"
              value={farnsworthWpm}
              onChange={setFarnsworthWpm}
              max={charWpm}
            />
          </div>
        </div>

        <div className="confirm">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" data-testid="start-session" onClick={start}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

/** A speed in words per minute.
 *
 * Held as text while it is being edited, for the reason `NumberField` is: a
 * control that falls back to the committed value on anything unparseable puts
 * the old number straight back under the caret. */
function SpeedField({
  id,
  value,
  onChange,
  max = 60,
}: {
  id: string;
  value: number;
  onChange(v: number): void;
  max?: number;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      id={id}
      min={5}
      max={60}
      step={1}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= 5) onChange(Math.min(n, max));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
