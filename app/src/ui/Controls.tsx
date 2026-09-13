/* The control row: transport, speeds, tolerance, level, intended text, view.
 *
 * Every one of these re-grades the recording rather than filtering a stored
 * result, which is why the intended-message box can be edited freely: typing a
 * different message is a legitimate question ("what if I had meant *this*"),
 * not a way to cheat a score that was fixed at record time.
 */

import { useCallback } from "react";
import { ZOOM_MAX, ZOOM_MIN } from "@/render/geometry";
import type { ReviewSettings, ViewMode } from "@/types";
import { COLLAPSE_RESTS_HELP, GAIN_HELP, ZOOM_HELP } from "./copy";
import { fmtGain, fmtPpu, fmtSeconds, fmtTolerance, fmtWpm } from "./format";
import { useUpperField } from "./useUpperField";

export interface ControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  expectedSource: string | null;
  hasExpected: boolean;
  playing: "you" | "tgt" | null;
  clock: number | null;
  onPlayYou(): void;
  onPlayTarget(): void;
  onStop(): void;
  onFit(): void;
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
        <button className="play" onClick={props.onPlayYou} aria-pressed={props.playing === "you"}>
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
          <span className="hint">
            {props.expectedSource
              ? `from ${props.expectedSource}`
              : props.hasExpected
                ? ""
                : "(none given — grading against your own decode)"}
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
    </section>
  );
}
