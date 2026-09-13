/* The control row: transport, speeds, tolerance, level, intended text.
 *
 * Every one of these re-grades the recording rather than filtering a stored
 * result, which is why the intended-message box can be edited freely: typing a
 * different message is a legitimate question ("what if I had meant *this*"),
 * not a way to cheat a score that was fixed at record time.
 *
 * What is NOT here is anything that only changes how the chart is drawn — the
 * axis, the zoom, whether rests are collapsed. Those answer "what am I looking
 * at", not "what is being graded", and they live beside the thing they affect.
 * See `ViewControls` below.
 */

import { useCallback, useState } from "react";
import { ZOOM_MAX, ZOOM_MIN } from "@/render/geometry";
import type { ReviewSettings, ViewMode } from "@/types";
import {
  CHAR_MARKERS_HELP,
  COLLAPSE_RESTS_HELP,
  GAIN_HELP,
  PACE_CURSOR_HELP,
  PACE_LEAD_HELP,
  ZOOM_HELP,
} from "./copy";
import { PACE_LEAD_MAX_SEC, PACE_LEAD_MIN_SEC } from "@/render/geometry";
import { fmtGain, fmtPpu, fmtSeconds, fmtTolerance, fmtWpm } from "./format";
import { useUpperField } from "./useUpperField";

export interface ControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  hasExpected: boolean;
  playing: "you" | "tgt" | null;
  /** False when there is no recording to play — see `blankTake`. */
  canPlayYou: boolean;
  clock: number | null;
  onPlayYou(): void;
  onPlayTarget(): void;
  onStop(): void;
}

export function Controls(props: ControlsProps): React.ReactElement {
  const { settings: s, onChange } = props;
  const expected = useUpperField(
    useCallback((next: string) => onChange({ expected: next }), [onChange]),
  );

  return (
    <section className="controls">
      <div className="group transport">
        {/* The icon lives in its own fixed-width span so swapping play/stop
            cannot change the button's width and shift the row. */}
        <button
          className="play"
          onClick={props.onPlayYou}
          disabled={!props.canPlayYou}
          aria-pressed={props.playing === "you"}
        >
          <i className="ico">{props.playing === "you" ? "■" : "▶"}</i>
          Your sending
        </button>
        <button
          className="play alt"
          onClick={props.onPlayTarget}
          aria-pressed={props.playing === "tgt"}
        >
          <i className="ico">{props.playing === "tgt" ? "■" : "▶"}</i>
          Target
        </button>
        <button onClick={props.onStop} disabled={!props.playing} aria-label="Stop">
          ■
        </button>
        <span className="clock">{fmtSeconds(props.clock ?? 0)}</span>
      </div>

      <div className="group">
        <label htmlFor="wpm">
          Character speed <output id="wpm-out">{fmtWpm(s.charWpm)}</output>
        </label>
        <input
          type="range"
          id="wpm"
          min={5}
          max={45}
          step={1}
          value={s.charWpm}
          onChange={(e) => onChange({ charWpm: Number(e.target.value) })}
        />
      </div>

      <div className="group">
        <label htmlFor="farns">
          Overall (Farnsworth) <output id="farns-out">{fmtWpm(s.farnsworthWpm)}</output>
        </label>
        <input
          type="range"
          id="farns"
          min={5}
          /* Overall speed cannot exceed character speed, so the slider's
             ceiling follows the other one rather than letting the pair go
             invalid and silently clamping behind your back. */
          max={s.charWpm}
          step={1}
          value={s.farnsworthWpm}
          onChange={(e) => onChange({ farnsworthWpm: Number(e.target.value) })}
        />
      </div>

      <div className="group">
        <label htmlFor="tol">
          Tolerance <output id="tol-out">{fmtTolerance(s.tolerance)}</output>
        </label>
        <input
          type="range"
          id="tol"
          min={5}
          max={60}
          step={1}
          value={Math.round(s.tolerance * 100)}
          onChange={(e) => onChange({ tolerance: Number(e.target.value) / 100 })}
        />
      </div>

      <div className="group">
        <label htmlFor="gain" title={GAIN_HELP}>
          Listening level <output id="gain-out">{fmtGain(s.gainDb)}</output>
        </label>
        <input
          type="range"
          id="gain"
          min={-6}
          max={42}
          step={1}
          value={s.gainDb}
          onChange={(e) => onChange({ gainDb: Number(e.target.value) })}
        />
      </div>

      <div className="group grow">
        <label htmlFor="expected">
          Intended message{" "}
          {/* Where it came from is not worth a line. The box says what it is
              and holds what it holds; "from what you said you'd send" only
              restates the label. What IS worth saying is the case where the
              box is empty, because then the grade is against the decoder's own
              reading and the accuracy figure is a meaningless 100%. */}
          <span className="hint">
            {props.hasExpected ? "" : "(none given — grading against your own decode)"}
          </span>
        </label>
        <input
          type="text"
          id="expected"
          spellCheck={false}
          autoComplete="off"
          value={s.expected}
          ref={expected.ref}
          onChange={expected.onChange}
        />
      </div>

    </section>
  );
}

/** How long the count-in runs, in seconds.
 *
 * Held as text while it is being edited, for the reason every other number box
 * in this app is: clearing the field to type a new figure hands `onChange` an
 * empty string, and a control that falls back to the committed value on
 * anything unparseable puts the old number straight back under the caret — so
 * emptying "3" and typing "5" leaves you with 35, which then clamps to the
 * maximum. The clamp belongs to what gets committed, not to what is on screen
 * being typed. */
function LeadField({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange(v: number): void;
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="field row" title={PACE_LEAD_HELP}>
      <span className="fieldname">Delay start</span>
      <input
        type="number"
        id="pace-lead"
        min={PACE_LEAD_MIN_SEC}
        max={PACE_LEAD_MAX_SEC}
        step={1}
        value={text ?? String(seconds)}
        aria-label="Delay start in seconds"
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() === "" || !Number.isFinite(v)) return;
          onChange(
            Math.min(Math.max(Math.round(v), PACE_LEAD_MIN_SEC), PACE_LEAD_MAX_SEC),
          );
        }}
        // Back to showing what was actually committed, clamp included.
        onBlur={() => setText(null)}
      />
      <span className="unit">s</span>
    </label>
  );
}

export interface ViewControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  onFit(): void;
}

/** How the chart is drawn, next to the chart.
 *
 * Separated from the controls above because they answer a different question.
 * Everything up there changes the grade; nothing down here does — the axis,
 * the zoom and the rest policy change what is on screen and leave every number
 * exactly where it was. Mixed into one row of nine controls, the two kinds
 * were indistinguishable, and a zoom slider sitting beside a tolerance slider
 * implies they are the same sort of thing. */
export function ViewControls(props: ViewControlsProps): React.ReactElement {
  const { settings: s, onChange } = props;
  return (
    <section className="viewcontrols">
      <div className="group">
        <label htmlFor="view">View</label>
        <select
          id="view"
          value={s.view}
          onChange={(e) => onChange({ view: e.target.value as ViewMode })}
        >
          <option value="per-char">Per character</option>
          <option value="absolute">Absolute time</option>
          <option value="overlay">Overlay</option>
        </select>
      </div>

      <div className="group">
        <label htmlFor="zoom" title={ZOOM_HELP}>
          Zoom <output id="zoom-out">{fmtPpu(s.ppu)}</output>
        </label>
        {/* The button is a sibling of the label, not inside it: a label may not
            contain another labelable element. */}
        <div className="sliderow">
          <input
            type="range"
            id="zoom"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={1}
            value={s.ppu}
            onChange={(e) => onChange({ ppu: Number(e.target.value) })}
          />
          <button
            id="zoom-fit"
            onClick={props.onFit}
            title="Zoom so the session fills the width — what the chart does when it opens"
          >
            Fit
          </button>
        </div>
      </div>

      <div className="group">
        <label className="check" title={COLLAPSE_RESTS_HELP}>
          <input
            type="checkbox"
            checked={s.collapseRests}
            onChange={(e) => onChange({ collapseRests: e.target.checked })}
          />{" "}
          Collapse rests
        </label>
      </div>

      <div className="group">
        <label className="check" title={CHAR_MARKERS_HELP}>
          <input
            type="checkbox"
            id="char-markers"
            checked={s.charMarkers}
            onChange={(e) => onChange({ charMarkers: e.target.checked })}
          />{" "}
          Character markers
        </label>
      </div>

      <div className="group">
        <label className="check" title={PACE_CURSOR_HELP}>
          <input
            type="checkbox"
            id="pace-cursor"
            checked={s.paceCursor}
            onChange={(e) => onChange({ paceCursor: e.target.checked })}
          />{" "}
          Pacing cursor
        </label>
      </div>

      {/* Only with the cursor on. A count-in for a cursor that is not running
          is a setting for nothing, and it would be one more control in a row
          that is already busy. */}
      {s.paceCursor && (
        <div className="group">
          <LeadField
            seconds={s.paceLeadSec}
            onChange={(v) => onChange({ paceLeadSec: v })}
          />
        </div>
      )}
    </section>
  );
}
