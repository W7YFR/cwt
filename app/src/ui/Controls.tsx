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
import { IconCog } from "./Icons";
import { ZOOM_MAX, ZOOM_MIN } from "@/render/geometry";
import type { ReviewSettings, Timing, ViewMode } from "@/types";
import { TIMES_MAX, TIMES_MIN } from "@/timing";
import {
  BREAK_MAX_SEC,
  BREAK_MIN_SEC,
  REPEAT_PAUSE_MAX_SEC,
  REPEAT_PAUSE_MIN_SEC,
} from "@/timing/timeline";
import {
  ADVANCED_GRADING_HELP,
  IGNORE_CONSTRUCTION_HELP,
  CAPTION_ALL_HELP,
  CHAR_MARKERS_HELP,
  COLLAPSE_RESTS_HELP,
  RUN_SCORES_HELP,
  SHOW_CHART_CONTROLS_HELP,
  SHOW_DOWNLOADS_HELP,
  SHOW_HINTS_HELP,
  SHOW_RUNS_HELP,
  RUN_SORT_HELP,
  GAIN_HELP,
  PACE_ABSOLUTE_HELP,
  TIMES_FILE_HELP,
  TIMES_HELP,
  ZEN_PROGRESS_HELP,
  ZEN_GRADING_HELP,
  LOOP_HELP,
  PLAIN_FOLLOW_HELP,
  PLAIN_GRADING_HELP,
  PACE_LEAD_HELP,
  BREAK_HELP,
  REPEAT_PAUSE_HELP,
  ZOOM_HELP,
  CAL_FILE,
  CAL_HELP,
  CAL_NONE,
  CAL_REREADING,
  MIC_HELP,
  NEEDS_LIVE_PROGRESS,
  NEEDS_RUNS,
  NEEDS_RUNS_SHOWN,
  ONE_INPUT,
  barredTitle,
} from "./copy";
import type { InputDevice } from "@/capture/mic";
import { profilesFor, type Profile } from "@/io/profiles";
import { CalibrateButton } from "./Record";

/** The range of both speed sliders. */
export const SPEED_MIN = 5;
export const SPEED_MAX = 45;

/** Target speeds that match a run's measured ones, as the sliders can hold
 *  them: whole words per minute, in range, overall never above character.
 *  Null when the run gives no speed to fit. */
export function fitSpeed(
  measured: Timing,
): { charWpm: number; farnsworthWpm: number } | null {
  if (!(measured.charWpm > 0) || !(measured.farnsworthWpm > 0)) return null;
  const clamp = (v: number, hi: number) => Math.min(Math.max(Math.round(v), SPEED_MIN), hi);
  const charWpm = clamp(measured.charWpm, SPEED_MAX);
  return { charWpm, farnsworthWpm: clamp(measured.farnsworthWpm, charWpm) };
}
import {
  PACE_LEAD_MAX_SEC,
  PACE_LEAD_MIN_SEC,
} from "@/render/geometry";
import { fmtGain, fmtPpu, fmtTolerance, fmtWpm } from "./format";
import { RUN_SORTS, recentCount, type RunSort } from "./runOrder";
import { useUpperField } from "./useUpperField";

export interface ControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  /** This session was opened from a file rather than keyed. A file holds
   *  whatever it holds, so how many passes you are about to send is not a
   *  question about it. */
  fromFile: boolean;
}

/** The row over the chart: what you send, at what speed, judged how closely.
 *
 * Only the settings changed from take to take. Everything set once and left
 * alone is in the settings panel, and playback is on the chart itself. */
export function Controls(props: ControlsProps): React.ReactElement {
  const { settings: s, onChange } = props;
  const expected = useUpperField(
    useCallback((next: string) => onChange({ expected: next }), [onChange]),
  );

  return (
    <section className="controls">
      <div className="group">
        <label htmlFor="wpm">
          Character speed <output id="wpm-out">{fmtWpm(s.charWpm)}</output>
        </label>
        <input
          type="range"
          id="wpm"
          min={SPEED_MIN}
          max={SPEED_MAX}
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
          min={SPEED_MIN}
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

      {/* The message and how many of it, on one line. A wrapper, because the
          message group claims a whole row by itself — it is the one control
          here whose useful width has no upper bound — so the two share a line
          by being one item on it, with the box taking whatever the count
          does not. */}
      <div className="msgrow">
        <div className="group grow">
          <label htmlFor="expected">Intended message</label>
          {/* Says what the box is FOR, which is the thing worth knowing when it
              is empty: with nothing here there is no source of truth, so the
              grade falls back to the decoder's own reading of you and the
              accuracy figure is a meaningless 100%. */}
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

        <div className="group">
          <NumberField
            id="times"
            name="Times"
            unit=""
            help={props.fromFile ? TIMES_FILE_HELP : TIMES_HELP}
            value={s.times}
            min={TIMES_MIN}
            max={TIMES_MAX}
            step={1}
            disabled={props.fromFile}
            onChange={(v) => onChange({ times: v })}
          />
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
  spoken,
  help,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  name: string;
  unit: string;
  disabled?: boolean;
  /** The unit said out loud, for the accessible name. Defaults to the symbol,
   *  which is right for a word like "times" and wrong for "s". */
  spoken?: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="field row" data-disabled={disabled === true} title={help}>
      <span className="fieldname">{name}</span>
      <input
        type="number"
        id={id}
        min={min}
        max={max}
        step={step}
        disabled={disabled === true}
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
        aria-label={unit ? `${name} in ${spoken ?? unit}` : name}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() === "" || !Number.isFinite(v)) return;
          onChange(Math.min(Math.max(Math.round(v / step) * step, min), max));
        }}
        // Back to showing what was actually committed, clamp included.
        onBlur={() => setText(null)}
      />
      {unit !== "" && <span className="unit">{unit}</span>}
    </label>
  );
}

export interface ChartSettingsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  /** How many attempts are in the session. With one there is nothing to
   *  order or compare, and the settings for that are barred. */
  runs: number;
}

export interface ViewControlsProps extends ChartSettingsProps {
  onFit(): void;
}

/** A select with its caption above it, barred in place when it cannot apply. */
function SelectGroup({
  id,
  label,
  help,
  barred,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  barred?: string | null;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
}): React.ReactElement {
  const title = help === undefined && !barred ? undefined : barredTitle(barred ?? null, help ?? "");
  return (
    <div className="group" data-disabled={Boolean(barred)} title={title}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={Boolean(barred)}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const VIEWS = [
  { value: "per-char", label: "Per character" },
  { value: "absolute", label: "Absolute time" },
  { value: "overlay", label: "Overlay" },
] as const;

const SHOW_RUNS = [
  { value: "all", label: "All runs" },
  { value: "last5", label: "Last 5 runs" },
  { value: "last3", label: "Last 3 runs" },
  { value: "last", label: "Last run" },
] as const;

/** How the chart is drawn, next to the chart.
 *
 * Separated from the controls above because they answer a different question.
 * Everything up there changes the grade; nothing down here does. */
export function ViewControls(props: ViewControlsProps): React.ReactElement | null {
  const { settings: s, onChange } = props;
  /* Gone entirely rather than emptied, so the chart moves up into the room the
     row was taking. Taking the row away is what Chart controls is for. */
  if (!s.showChartControls) return null;
  /* How many rows the chart is actually drawing — the session, capped by
     whatever window Show has in force. What Sort is about. */
  const want = recentCount(s.showRuns);
  const drawn = want === null ? props.runs : Math.min(want, props.runs);
  return (
    <section className="viewcontrols">
      <SelectGroup
        id="run-sort"
        label="Sort"
        help={RUN_SORT_HELP}
        barred={drawn > 1 ? null : props.runs > 1 ? NEEDS_RUNS_SHOWN : NEEDS_RUNS}
        value={s.runSort}
        options={RUN_SORTS}
        onChange={(v) => onChange({ runSort: v as RunSort })}
      />

      <SelectGroup
        id="view"
        label="View"
        value={s.view}
        options={VIEWS}
        onChange={(v) => onChange({ view: v as ViewMode })}
      />

      <SelectGroup
        id="show-runs"
        label="Show"
        help={SHOW_RUNS_HELP}
        barred={props.runs > 1 ? null : NEEDS_RUNS}
        value={s.showRuns}
        options={SHOW_RUNS}
        onChange={(v) => onChange({ showRuns: v as ReviewSettings["showRuns"] })}
      />

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
      aria-label="Settings"
      title="Settings"
      onClick={onToggle}
    >
      <IconCog />
    </button>
  );
}

/** One checkbox, barred in place when another setting rules it out.
 *
 * A barred setting keeps its place and its value, dimmed, with the reason
 * first in its tooltip. Hidden, the settings around it moved every time
 * another one changed, and there was no way to find out it existed. */
function Check({
  id,
  label,
  help,
  checked,
  barred = null,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  barred?: string | null;
  onChange(checked: boolean): void;
}): React.ReactElement {
  return (
    <div className="group">
      <label className="check" title={barredTitle(barred, help)}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={barred !== null}
          onChange={(e) => onChange(e.target.checked)}
        />{" "}
        {label}
      </label>
    </div>
  );
}

/** The input and its correction: what the Audio group sets. Absent where
 *  there is no recorder to set them for. */
export interface AudioSetup {
  devices: readonly InputDevice[];
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): void;
  /** False for a file, which is read exactly as recorded. */
  appliesToTake: boolean;
  /** The session is being re-read under a new calibration. */
  rereading: boolean;
  onCalibrate?: (() => void) | undefined;
}

export interface SettingsPanelProps extends ChartSettingsProps {
  audio?: AudioSetup;
  /** Replay what plays each time it reaches its end. Not a saved setting: it
   *  is the transport's, and L toggles it too. */
  loop?: boolean;
  onLoop?(): void;
}

/** Every setting the control row has no room for, in a band under the header.
 *
 * Grouped by the question each answers: what you hear, what you send, how it
 * is graded, the two ways to record, how the chart is drawn, and what else is
 * on the page. A setting that another one rules out stays in its place,
 * dimmed, with the reason in its tooltip. */
export function ChartSettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const { settings: s, onChange } = props;
  return (
    <div className="viewpanel" id="view-panel">
      <Section name="audio" title="Audio">
        {/* Two lines: where the sound comes from, then how it plays back. */}
        {props.audio && (
          <div className="panelgroups">
            <AudioGroups audio={props.audio} />
          </div>
        )}
        <div className="panelgroups">
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
          {props.onLoop && (
            <Check
              id="loop"
              label="Loop"
              help={LOOP_HELP}
              checked={props.loop ?? false}
              onChange={() => props.onLoop?.()}
            />
          )}
        </div>
      </Section>

      <Section name="target" title="Target">
        <div className="panelgroups">
          <div className="group">
            <NumberField
              id="repeat-pause"
              name="Repeat pause"
              unit="s"
              spoken="seconds"
              help={REPEAT_PAUSE_HELP}
              value={s.repeatPauseSec}
              min={REPEAT_PAUSE_MIN_SEC}
              max={REPEAT_PAUSE_MAX_SEC}
              step={1}
              onChange={(v) => onChange({ repeatPauseSec: v })}
            />
          </div>
          <div className="group">
            <NumberField
              id="break-sec"
              name="Break length"
              unit="s"
              spoken="seconds"
              help={BREAK_HELP}
              value={s.breakSec}
              min={BREAK_MIN_SEC}
              max={BREAK_MAX_SEC}
              step={1}
              onChange={(v) => onChange({ breakSec: v })}
            />
          </div>
        </div>
      </Section>

      <Section name="grading" title="Grading">
        <div className="panelgroups">
          <Check
            id="ignore-construction"
            label="Spacing only"
            help={IGNORE_CONSTRUCTION_HELP}
            checked={s.ignoreConstruction}
            onChange={(v) => onChange({ ignoreConstruction: v })}
          />
        </div>
      </Section>

      <Section name="display" title="Chart">
        <div className="panelgroups">
          <Check
            id="collapse-rests"
            label="Collapse rests"
            help={COLLAPSE_RESTS_HELP}
            checked={s.collapseRests}
            onChange={(v) => onChange({ collapseRests: v })}
          />
          <Check
            id="char-markers"
            label="Marks only"
            help={CHAR_MARKERS_HELP}
            checked={s.charMarkers}
            onChange={(v) => onChange({ charMarkers: v })}
          />
          <Check
            id="run-scores"
            label="Scores"
            help={RUN_SCORES_HELP}
            checked={s.runScores}
            onChange={(v) => onChange({ runScores: v })}
          />
          <Check
            id="caption-all"
            label="Decode all"
            help={CAPTION_ALL_HELP}
            checked={s.captionAll}
            onChange={(v) => onChange({ captionAll: v })}
          />
        </div>
      </Section>

      {/* Not the chart: these put a whole block on the page or take it away,
          which is a different kind of decision from how the marks above are
          drawn. */}
      <Section name="extras" title="Page">
        <div className="panelgroups">
          <Check
            id="show-chart-controls"
            label="Chart controls"
            help={SHOW_CHART_CONTROLS_HELP}
            checked={s.showChartControls}
            onChange={(v) => onChange({ showChartControls: v })}
          />
          <Check
            id="show-downloads"
            label="Downloads"
            help={SHOW_DOWNLOADS_HELP}
            checked={s.showDownloads}
            onChange={(v) => onChange({ showDownloads: v })}
          />
          <Check
            id="show-hints"
            label="Hints"
            help={SHOW_HINTS_HELP}
            checked={s.showHints}
            onChange={(v) => onChange({ showHints: v })}
          />
          <Check
            id="advanced-grading"
            label="Advanced grading"
            help={ADVANCED_GRADING_HELP}
            checked={s.advancedGrading}
            onChange={(v) => onChange({ advancedGrading: v })}
          />
        </div>
      </Section>

      {/* The options of the three ways to record, on a row of their own: they
          are the settings changed from one sitting to the next, and the rest
          are set once. Which mode records is picked beside the record button;
          these are set ahead of it, so they stay live whichever is picked. */}
      <div className="panelrow modes" data-panel="modes" role="group" aria-labelledby="panel-modes">
        <span className="uplabel" id="panel-modes">
          Recording modes
        </span>
        <div className="modesrow">
          <Section name="plain" title="Plain">
            <div className="aid">
              <Check
                id="plain-follow"
                label="Follow"
                help={PLAIN_FOLLOW_HELP}
                checked={s.plainFollow}
                onChange={(v) => onChange({ plainFollow: v })}
              />
              <Check
                id="plain-grading"
                label="Live grading"
                help={PLAIN_GRADING_HELP}
                checked={s.plainGrading}
                onChange={(v) => onChange({ plainGrading: v })}
              />
            </div>
          </Section>

          <Section name="zen" title="Zen">
            <div className="aid">
              <Check
                id="zen-progress"
                label="Live progress"
                help={ZEN_PROGRESS_HELP}
                checked={s.zenProgress}
                onChange={(v) => onChange({ zenProgress: v })}
              />
              <Check
                id="zen-grading"
                label="Live grading"
                help={ZEN_GRADING_HELP}
                checked={s.zenGrading}
                barred={s.zenProgress ? null : NEEDS_LIVE_PROGRESS}
                onChange={(v) => onChange({ zenGrading: v })}
              />
            </div>
          </Section>

          <Section name="pacing" title="Pacing">
            <div className="aid">
              <Check
                id="pace-absolute"
                label="Clock axis"
                help={PACE_ABSOLUTE_HELP}
                checked={s.paceAbsolute}
                onChange={(v) => onChange({ paceAbsolute: v })}
              />
              <div className="group">
                <NumberField
                  id="pace-lead"
                  name="Delay start"
                  unit="s"
                  spoken="seconds"
                  help={PACE_LEAD_HELP}
                  value={s.paceLeadSec}
                  min={PACE_LEAD_MIN_SEC}
                  max={PACE_LEAD_MAX_SEC}
                  step={1}
                  onChange={(v) => onChange({ paceLeadSec: v })}
                />
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

/** One named section of the panel. A group to assistive tech, named by its
 *  heading, so a checkbox called "Enabled" says what it enables. */
function Section({
  name,
  title,
  children,
}: {
  name: string;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const id = `panel-${name}`;
  return (
    <div className="panelrow" data-panel={name} role="group" aria-labelledby={id}>
      <span className="uplabel" id={id}>
        {title}
      </span>
      {children}
    </div>
  );
}

/** The microphone and its calibration, each barred in place when there is
 *  nothing to choose. */
function AudioGroups({ audio }: { audio: AudioSetup }): React.ReactElement {
  const oneInput = audio.devices.length <= 1 ? ONE_INPUT : null;
  const choices = profilesFor([...audio.profiles], audio.deviceId, audio.profileId);
  const active = audio.profiles.find((p) => p.id === audio.profileId) ?? null;
  const calBarred = !audio.appliesToTake
    ? CAL_FILE
    : audio.rereading
      ? CAL_REREADING
      : choices.length === 0
        ? CAL_NONE
        : null;
  return (
    <>
      <div className="group" data-disabled={oneInput !== null} title={barredTitle(oneInput, MIC_HELP)}>
        <label htmlFor="input-device">Microphone</label>
        <select
          id="input-device"
          value={audio.deviceId ?? ""}
          disabled={oneInput !== null}
          onChange={(e) => audio.onDeviceChange(e.target.value || undefined)}
        >
          <option value="">Default input</option>
          {/* Keyed by position as well as by id: before the browser hands
              over the identifiers, several inputs share an empty one. */}
          {audio.devices.map((d, i) => (
            <option key={`${d.deviceId}:${i}`} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div
        className="group"
        data-testid="calpick"
        data-disabled={calBarred !== null}
        title={barredTitle(calBarred, CAL_HELP)}
      >
        <label htmlFor="calibration">Calibration</label>
        <div className="sliderow">
          <select
            id="calibration"
            value={audio.appliesToTake ? (audio.profileId ?? "") : ""}
            disabled={calBarred !== null}
            onChange={(e) => audio.onProfileChange(e.target.value || undefined)}
          >
            <option value="">No calibration</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname} — {(p.releaseOffsetSec * 1000).toFixed(1)} ms, {p.verdict}
              </option>
            ))}
          </select>
          {audio.onCalibrate && (
            <CalibrateButton active={active} applied={audio.appliesToTake} onClick={audio.onCalibrate} />
          )}
          {/* Only while it is happening: re-reading takes long enough to need
              saying. Not hidden while empty, so it is announced when filled. */}
          <span className="hint" aria-live="polite">
            {audio.rereading ? "re-reading the session…" : ""}
          </span>
        </div>
      </div>
    </>
  );
}
