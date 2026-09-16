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
  ADVANCED_GRADING_HELP,
  CAPTION_ALL_HELP,
  CHAR_MARKERS_HELP,
  COLLAPSE_RESTS_HELP,
  FLASH_CARD_HELP,
  FLASH_CUE_HELP,
  FLASH_LEAD_HELP,
  RUN_SCORES_HELP,
  SHOW_CHART_CONTROLS_HELP,
  SHOW_DOWNLOADS_HELP,
  SHOW_HINTS_HELP,
  SHOW_RUNS_HELP,
  RUN_SORT_HELP,
  WORD_PREVIEW_HELP,
  GAIN_HELP,
  PACE_CURSOR_HELP,
  PACE_LEAD_HELP,
  ZOOM_HELP,
} from "./copy";
import {
  FLASH_LEAD_MAX_MS,
  FLASH_LEAD_MIN_MS,
  PACE_LEAD_MAX_SEC,
  PACE_LEAD_MIN_SEC,
} from "@/render/geometry";
import { fmtGain, fmtPpu, fmtSeconds, fmtTolerance, fmtWpm } from "./format";
import { RUN_SORTS, type RunSort } from "./runOrder";
import { useUpperField } from "./useUpperField";

export interface ControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
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
        {/* Captioned like every other group. Without one it was the only thing
            on the row with nothing above it, and it had to be dropped onto the
            control band by hand to line up with the rest. */}
        <span className="caption">Audio</span>
        {/* The controls in a row of their own inside the group, so the caption
            can sit above them. The group is a column of two bands like every
            other; what makes this one different is that its control band holds
            four things rather than one. */}
        <div className="transportrow">
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
        <label htmlFor="expected">Intended message</label>
        {/* Says what the box is FOR, which is the thing worth knowing when it
            is empty: with nothing here there is no source of truth, so the
            grade falls back to the decoder's own reading of you and the
            accuracy figure is a meaningless 100%. It belongs in the
            placeholder rather than beside the label — it is only on screen
            while the box is empty, which is exactly when a placeholder is, and
            text that appears and disappears next to a label has to wrap
            somewhere the label does not. Inside the box it has a whole row to
            itself and clips instead of reflowing the row above it. */}
        {/* The clear button sits inside the box's right edge rather than
            beside it: this group is the one that absorbs the row's slack, and
            a button next to the field would take the room back from the only
            thing that wanted it. */}
        <div className="clearable">
          <input
            type="text"
            id="expected"
            spellCheck={false}
            autoComplete="off"
            placeholder="The source of truth to grade against"
            value={s.expected}
            ref={expected.ref}
            onChange={expected.onChange}
          />
          {s.expected !== "" && (
            <button
              type="button"
              className="clearbtn"
              data-testid="clear-expected"
              aria-label="Clear intended message"
              title="Clear"
              onClick={() => {
                onChange({ expected: "" });
                expected.ref.current?.focus();
              }}
            >
              {/* Drawn rather than typed. A glyph is placed by the font's
                  own metrics — its ink sits above the baseline, not on the
                  center line of the box around it — so an × centered as text
                  reads as riding high in the field. A shape centers on the
                  geometry. */}
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
                <path
                  d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

    </section>
  );
}

/** A small number box with its name beside it and its unit after it.
 *
 * Held as text while it is being edited, which is the whole reason this is a
 * component rather than three inputs. Clearing the field to type a new figure
 * hands `onChange` an empty string, and a control that falls back to the
 * committed value on anything unparseable puts the old number straight back
 * under the caret — so emptying "3" and typing "5" leaves you with 35, which
 * then clamps to the maximum and reads as the control ignoring you. The clamp
 * belongs to what gets committed, not to what is on screen being typed. */
function NumberField({
  id,
  name,
  unit,
  help,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  name: string;
  unit: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="field row" title={help}>
      <span className="fieldname">{name}</span>
      <input
        type="number"
        id={id}
        min={min}
        max={max}
        step={step}
        /* Sized by the widest number it can hold, so a field in seconds and a
           field in milliseconds are not the same box with three empty digits
           in one of them.
           The digits in `ch`, and everything that is not a digit in `em`:
           border-box means the width has to cover the padding and the border,
           and the browser draws its own spinner inside the field on top of
           that. Counted in characters alone, the allowance came out smaller
           than the furniture and the number itself had nowhere to go. */
        style={{ width: `calc(${String(max).length}ch + 3em)` }}
        value={text ?? String(value)}
        aria-label={`${name} in ${unit === "s" ? "seconds" : "milliseconds"}`}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() === "" || !Number.isFinite(v)) return;
          onChange(Math.min(Math.max(Math.round(v / step) * step, min), max));
        }}
        // Back to showing what was actually committed, clamp included.
        onBlur={() => setText(null)}
      />
      <span className="unit">{unit}</span>
    </label>
  );
}

export interface ChartSettingsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  /** How many attempts are in the session. With one there is nothing to
   *  order, and a control for arranging a single row is a control for
   *  nothing. */
  runs: number;
}

export interface ViewControlsProps extends ChartSettingsProps {
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
export function ViewControls(props: ViewControlsProps): React.ReactElement | null {
  const { settings: s, onChange } = props;
  /* Gone entirely rather than emptied, so the chart moves up into the room the
     row was taking. A section that renders nothing still holds its own margins,
     and a strip of blank page above a chart reads as something that failed to
     load. */
  if (!s.showChartControls) return null;
  return (
    <section className="viewcontrols">
        {props.runs > 1 && (
          <div className="group">
            <label htmlFor="run-sort" title={RUN_SORT_HELP}>
              Sort
            </label>
            <select
              id="run-sort"
              value={s.runSort}
              onChange={(e) => onChange({ runSort: e.target.value as RunSort })}
            >
              {RUN_SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}

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

        {/* Next to the axis, because it is the same kind of question: not what
            is graded, but what is on screen to read. Only with a stack — with
            one attempt every answer here is the same row.

            All three offered whenever it shows, short sessions included: "the
            last five" of three attempts is those three, which is what it says
            it is. Dropping an option once a session is short enough for two of
            them to agree would move the others under the pointer. */}
        {props.runs > 1 && (
          <div className="group">
            <label htmlFor="show-runs" title={SHOW_RUNS_HELP}>
              Show
            </label>
            <select
              id="show-runs"
              value={s.showRuns}
              onChange={(e) =>
                onChange({ showRuns: e.target.value as ReviewSettings["showRuns"] })
              }
            >
              <option value="all">All runs</option>
              <option value="last5">Last 5 runs</option>
              <option value="last">Last run</option>
            </select>
          </div>
        )}

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

    </section>
  );
}

/** The way in: the button in the corner of the header.
 *
 * In the header rather than on a row of controls, because every row of
 * controls on this page can be switched off — and a way in that goes away with
 * the thing it switched off is a setting nobody can undo. The corner is also
 * the one place that does not move as the page fills and empties. */
export function ChartSettingsButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle(): void;
}): React.ReactElement {
  return (
    <button
      className="iconbtn cornerbtn"
      data-testid="panel-toggle"
      aria-pressed={open}
      aria-controls="view-panel"
      aria-label="Chart settings"
      title="Chart settings"
      onClick={onToggle}
    >
      <span aria-hidden="true">⚙</span>
    </button>
  );
}

/** Everything the rows have no space for, in a band under the header.
 *
 * Three groups, named: how the chart is drawn, what else is on the page, and
 * what runs while you send. Without the names it is one heap of a dozen
 * checkboxes, and half of them do nothing to the chart in front of you. */
export function ChartSettingsPanel(props: ChartSettingsProps): React.ReactElement {
  const { settings: s, onChange } = props;
  return (
        <div className="viewpanel" id="view-panel">
          <div className="panelrow" data-panel="display">
            <span className="uplabel">Chart display</span>
            <div className="panelgroups">
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
                  Marks only
                </label>
              </div>

              {/* Both only with a stack. With one attempt on screen the scores
                  would repeat the band under the chart, and there is no "every
                  row" to caption. */}
              {props.runs > 1 && (
                <>
                  <div className="group">
                    <label className="check" title={RUN_SCORES_HELP}>
                      <input
                        type="checkbox"
                        id="run-scores"
                        checked={s.runScores}
                        onChange={(e) => onChange({ runScores: e.target.checked })}
                      />{" "}
                      Scores
                    </label>
                  </div>

                  <div className="group">
                    <label className="check" title={CAPTION_ALL_HELP}>
                      <input
                        type="checkbox"
                        id="caption-all"
                        checked={s.captionAll}
                        onChange={(e) => onChange({ captionAll: e.target.checked })}
                      />{" "}
                      Decode all
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="panelrow" data-panel="practice">
            <span className="uplabel">Practice aids</span>
            <div className="panelgroups">
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

              {/* Only with the cursor on. A count-in for a cursor that is not
                  running is a setting for nothing. */}
              {s.paceCursor && (
                <div className="group">
                  <NumberField
                    id="pace-lead"
                    name="Delay start"
                    unit="s"
                    help={PACE_LEAD_HELP}
                    value={s.paceLeadSec}
                    min={PACE_LEAD_MIN_SEC}
                    max={PACE_LEAD_MAX_SEC}
                    step={1}
                    onChange={(v) => onChange({ paceLeadSec: v })}
                  />
                </div>
              )}

              <div className="group">
                <label className="check" title={FLASH_CARD_HELP}>
                  <input
                    type="checkbox"
                    id="flash-card"
                    checked={s.flashCard}
                    onChange={(e) => onChange({ flashCard: e.target.checked })}
                  />{" "}
                  Flash card
                </label>
              </div>

              {/* All three only with the card up — a cue for something not on
                  screen, a lead on a cue that never fires, and a word preview
                  under a card that is not there, are settings for nothing. */}
              {s.flashCard && (
                <div className="group">
                  <label className="check" title={FLASH_CUE_HELP}>
                    <input
                      type="checkbox"
                      id="flash-cue"
                      checked={s.flashCue}
                      onChange={(e) => onChange({ flashCue: e.target.checked })}
                    />{" "}
                    Flash cue
                  </label>
                </div>
              )}

              {s.flashCard && (
                <div className="group">
                  <label className="check" title={WORD_PREVIEW_HELP}>
                    <input
                      type="checkbox"
                      id="word-preview"
                      checked={s.wordPreview}
                      onChange={(e) => onChange({ wordPreview: e.target.checked })}
                    />{" "}
                    Word preview
                  </label>
                </div>
              )}

              {s.flashCard && s.flashCue && (
                <div className="group">
                  <NumberField
                    id="flash-lead"
                    name="Flash lead"
                    unit="ms"
                    help={FLASH_LEAD_HELP}
                    value={s.flashLeadMs}
                    min={FLASH_LEAD_MIN_MS}
                    max={FLASH_LEAD_MAX_MS}
                    step={10}
                    onChange={(v) => onChange({ flashLeadMs: v })}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Not the chart: these two put a whole block on the page or take it
              away, which is a different kind of decision from how the marks
              above are drawn. Grouped by that rather than by what they happen
              to contain — a row of buttons and three tables have nothing else
              in common. */}
          <div className="panelrow" data-panel="extras">
            <span className="uplabel">Also show</span>
            <div className="panelgroups">
              <div className="group">
                <label className="check" title={SHOW_CHART_CONTROLS_HELP}>
                  <input
                    type="checkbox"
                    id="show-chart-controls"
                    checked={s.showChartControls}
                    onChange={(e) => onChange({ showChartControls: e.target.checked })}
                  />{" "}
                  Chart controls
                </label>
              </div>

              <div className="group">
                <label className="check" title={SHOW_DOWNLOADS_HELP}>
                  <input
                    type="checkbox"
                    id="show-downloads"
                    checked={s.showDownloads}
                    onChange={(e) => onChange({ showDownloads: e.target.checked })}
                  />{" "}
                  Downloads
                </label>
              </div>

              <div className="group">
                <label className="check" title={SHOW_HINTS_HELP}>
                  <input
                    type="checkbox"
                    id="show-hints"
                    checked={s.showHints}
                    onChange={(e) => onChange({ showHints: e.target.checked })}
                  />{" "}
                  Hints
                </label>
              </div>

              <div className="group">
                <label className="check" title={ADVANCED_GRADING_HELP}>
                  <input
                    type="checkbox"
                    id="advanced-grading"
                    checked={s.advancedGrading}
                    onChange={(e) => onChange({ advancedGrading: e.target.checked })}
                  />{" "}
                  Advanced grading
                </label>
              </div>
            </div>
          </div>
        </div>
  );
}
