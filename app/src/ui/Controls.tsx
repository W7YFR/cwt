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

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ZOOM_MAX, ZOOM_MIN } from "@/render/geometry";
import type { LetterSize, ReviewSettings, Timing, ViewMode } from "@/types";
import type { RecordMode } from "./mode";
import { IconBug, IconPlay, IconStop, IconStraightKey } from "./Icons";
import { TIMES_MAX, TIMES_MIN } from "@/timing";
import { NOISE_MAX_DB, NOISE_OFF_DB, NOISE_STEP_DB, noiseOn, QRN_LEVELS, QSB_MAX_DB, QSB_STEP_DB } from "@/audio/qsb";
import type { AgcMode } from "@/audio/agc";
import { QRM_MAX_DB, QRM_OFF_DB, QRM_STEP_DB, qrmOn } from "@/copy/band";
import { loadPrefs, loadUser, savePrefs } from "@/io/storage";
import { STRAIGHT_MOST_WPM, type Fist, type KeyKind } from "@/timing/fist";
import type { PreviewMode } from "./usePreview";
import { DEFAULT_PITCH, PITCH_MAX_HZ, PITCH_MIN_HZ, PITCH_STEP_HZ, type PitchRange } from "@/qso/station";
import { BREAK } from "@/morse";
import {
  BREAK_MAX_SEC,
  BREAK_MIN_SEC,
} from "@/timing/timeline";
import {
  ADVANCED_GRADING_HELP,
  IGNORE_CONSTRUCTION_HELP,
  CAPTION_ALL_HELP,
  LETTER_SIZE_HELP,
  CHAR_MARKERS_HELP,
  COLLAPSE_RESTS_HELP,
  RUN_SCORES_HELP,
  SHOW_CHART_CONTROLS_HELP,
  SHOW_HINTS_HELP,
  SHOW_RUNS_HELP,
  RUN_SORT_HELP,
  GAIN_HELP,
  QSB_HELP,
  BAND_ON_HELP,
  AGC_HELP,
  KEY_STYLE_HELP,
  NOISE_HELP,
  QRN_HELP,
  BREAK_IN_HELP,
  QRM_HELP,
  PITCH_HELP,
  PREVIEW_HELP,
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
import {
  notesToValues,
  unsetNotes,
  useInsertAtCursor,
  type UnsetNotes,
} from "./SlotMenu";

/** The two speed sliders, character and overall. The practice page and the
 *  QSO page both draw these, so a speed is set the same way on each. */
/** What the two speeds set. */
const TOLERANCE_HELP =
  "How far a mark or a gap may be from its target length and still count as right.";
const CHAR_SPEED_HELP =
  "How fast the dits and dahs inside each character go, in words per minute.";
const FARNSWORTH_HELP =
  "How fast the message goes overall. Set below the character speed, the characters " +
  "keep their speed and the gaps between them grow longer.";

export function SpeedSliders({
  charWpm,
  farnsworthWpm,
  onChange,
  locked = false,
  idPrefix = "",
  charHelp,
}: {
  charWpm: number;
  farnsworthWpm: number;
  onChange(patch: { charWpm?: number; farnsworthWpm?: number }): void;
  /** Shown, but not to be changed. */
  locked?: boolean;
  /** Before each id, for a pair that is not your own speed: a friend's. */
  idPrefix?: string;
  /** More to say behind the character speed's question mark. */
  charHelp?: string;
}): React.ReactElement {
  // Behind a question mark in the settings panels. The control row has
  // never had a tooltip on these, so it gets none.
  const charAbout = useHelp(charHelp ? `${CHAR_SPEED_HELP} ${charHelp}` : CHAR_SPEED_HELP);
  const farnsAbout = useHelp(FARNSWORTH_HELP);
  return (
    <>
      <div className="group" inert={locked} data-locked={locked}>
        <label htmlFor={`${idPrefix}wpm`}>
          Character speed <output id={`${idPrefix}wpm-out`}>{fmtWpm(charWpm)}</output>
        </label>
        <input
          type="range"
          id={`${idPrefix}wpm`}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={1}
          value={charWpm}
          onChange={(e) => onChange({ charWpm: Number(e.target.value) })}
        />
        {charAbout.tip}
      </div>

      <div className="group" inert={locked} data-locked={locked}>
        <label htmlFor={`${idPrefix}farns`}>
          Overall (Farnsworth) <output id={`${idPrefix}farns-out`}>{fmtWpm(farnsworthWpm)}</output>
        </label>
        <input
          type="range"
          id={`${idPrefix}farns`}
          min={SPEED_MIN}
          /* Overall speed cannot exceed character speed, so the slider's
             ceiling follows the other one rather than letting the pair go
             invalid and silently clamping behind your back. */
          max={charWpm}
          step={1}
          value={farnsworthWpm}
          onChange={(e) => onChange({ farnsworthWpm: Number(e.target.value) })}
        />
        {farnsAbout.tip}
      </div>
    </>
  );
}

export interface ControlsProps {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  /** This session was opened from a file rather than keyed. A file holds
   *  whatever it holds, so how many passes you are about to send is not a
   *  question about it. */
  fromFile: boolean;
  /** A take is running, so nothing here can change. */
  locked?: boolean;
  /** A paste left notes such as "(your call)" with no value, or null when it
   *  left none. */
  onUnsetNotes?: ((unset: UnsetNotes | null) => void) | undefined;
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
  const insert = useInsertAtCursor(expected.ref, s.expected, (next) =>
    onChange({ expected: next }),
  );
  /* A note such as "(YOUR CALL)" left in the message fills in once its value
     is set. Checked as the row appears, which is on the way back from
     Configuration. A note still with no value warns again. */
  useEffect(() => {
    const user = loadUser();
    const filled = notesToValues(s.expected, user);
    if (filled !== s.expected) onChange({ expected: filled });
    const unset = unsetNotes(filled, user);
    if (unset) props.onUnsetNotes?.(unset);
  }, []);

  // A pasted note such as "(your call)" goes in as its value. The box is one
  // line, so each line break goes in as a break.
  const paste: React.ClipboardEventHandler<HTMLInputElement> = (e) => {
    const pasted = e.clipboardData.getData("text/plain");
    const user = loadUser();
    props.onUnsetNotes?.(unsetNotes(pasted, user));
    const filled = notesToValues(pasted, user).trim().replace(/\s*\n\s*/g, ` ${BREAK} `);
    if (filled === pasted) return;
    e.preventDefault();
    insert(filled.toUpperCase());
  };

  return (
    <section className="controls" inert={props.locked === true} data-locked={props.locked === true}>
      {/* The message and how many of it, on one line. A wrapper, because the
          message group claims a whole row by itself — it is the one control
          here whose useful width has no upper bound — so the two share a line
          by being one item on it, with the box taking whatever the count
          does not. */}
      <div className="msgrow">
        <div className="group grow">
          <label htmlFor="expected">Message</label>
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
              onPaste={paste}
            />
            {s.expected !== "" && (
              <button
                type="button"
                className="clearbtn"
                data-testid="clear-expected"
                aria-label="Clear the message"
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

/** How far off a mark may be and still count as right, in percent. */
export function ToleranceSlider({
  tolerance,
  onChange,
}: {
  tolerance: number;
  onChange(tolerance: number): void;
}): React.ReactElement {
  const about = useHelp(TOLERANCE_HELP);
  return (
    <div className="group">
      <label htmlFor="tol" title={about.title}>
        Tolerance <output id="tol-out">{fmtTolerance(tolerance)}</output>
      </label>
      <input
        type="range"
        id="tol"
        min={5}
        max={60}
        step={1}
        value={Math.round(tolerance * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      {about.tip}
    </div>
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
/** Inside the settings panels: each setting's explanation sits behind a
 *  small question mark after its name, not on the whole setting as a
 *  tooltip. Elsewhere, as in the control row, the tooltip stays. */
const HelpTips = createContext(false);

/** The least room kept between an explanation box and the window's edge,
 *  and between the box and its question mark, in pixels. */
const TIP_EDGE = 12;
const TIP_GAP = 6;

/** A question mark in a small circle. Hovered or focused, it shows `text`
 *  beside it; a screen reader reads it as the button's description.
 *
 *  The box is drawn at the top of the page, placed by the question mark, so
 *  the settings band, which clips what overflows it, cannot cut it off. It
 *  opens below, or above where there is no room below, and stays inside the
 *  window either side. */
/** Where a fixed box can go: the edges of the box `position: fixed`
 *  measures from, in window coordinates. */
function fixedFrame(): { left: number; right: number; top: number } {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;right:0;top:0;height:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { left: r.left, right: r.right, top: r.top };
}

/** A themed tooltip for `text`, drawn at the top of the page and placed by
 *  `anchor`: below it, or above where there is no room below, and inside the
 *  window either side. Spread `on` on the element that shows it. */
/** A control or a choice named in a tip's text, between asterisks, as in
 *  `*Fast*`: in italics in a tip, so it reads apart from the words around
 *  it. */
const TIP_NAME = /\*([^*\n]+)\*/g;

/** `text` for a browser's own tooltip, which has no italics: the names
 *  without their asterisks. */
export function plainTip(text: string): string {
  return text.replace(TIP_NAME, "$1");
}

/** `text` for a tip, its names in italics. */
function tipText(text: string): React.ReactNode {
  const parts = text.split(TIP_NAME);
  // Split on a group: every odd part is a name.
  return parts.map((part, i) => (i % 2 ? <em key={i}>{part}</em> : part));
}

function useTip<T extends HTMLElement>(
  text: string,
): {
  id: string;
  anchor: React.RefObject<T | null>;
  on: { onMouseEnter(): void; onMouseLeave(): void; onFocus(): void; onBlur(): void };
  box: React.ReactNode;
} {
  const id = useId();
  const anchor = useRef<T>(null);
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !box.current) return;
    const d = anchor.current.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    /* The page keeps a scrollbar's width free on both sides (see `html` in
       base.css), and a fixed box is placed inside them, not from the window's
       edge. Measured, because a browser with overlay scrollbars still keeps
       the room while reporting none. */
    const frame = fixedFrame();
    const room = frame.right - TIP_EDGE;
    const left = Math.max(frame.left + TIP_EDGE, Math.min(d.left - 10, room - b.width));
    const below = d.bottom + TIP_GAP;
    const top = below + b.height > window.innerHeight - TIP_EDGE ? d.top - TIP_GAP - b.height : below;
    setAt({ top: top - frame.top, left: left - frame.left });
  }, [open]);
  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setAt(null);
  };
  return {
    id,
    anchor,
    on: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide },
    box: createPortal(
      <span
        ref={box}
        className="tip"
        role="tooltip"
        id={id}
        hidden={!open}
        style={at ? { top: at.top, left: at.left } : { visibility: "hidden" }}
      >
        {tipText(text)}
      </span>,
      document.body,
    ),
  };
}

function HelpTip({ text }: { text: string }): React.ReactElement {
  const tip = useTip<HTMLButtonElement>(text);
  return (
    <span className="helptip">
      <button
        ref={tip.anchor}
        type="button"
        className="helpdot"
        aria-label="More about this setting"
        aria-describedby={tip.id}
        onClick={(e) => e.preventDefault()}
        {...tip.on}
      >
        ?
      </button>
      {tip.box}
    </span>
  );
}

/** The tooltip for a setting, or its question mark, by where it is drawn.
 *  The question mark is the last thing in the setting's `.group`, outside its
 *  label: the panels put it at the right end of the row, it is not dimmed
 *  with a barred setting, and it is no part of the control's name. */
function useHelp(text: string | undefined): { title?: string; tip: React.ReactNode } {
  const tips = useContext(HelpTips);
  if (!text) return { tip: null };
  return tips ? { tip: <HelpTip text={text} /> } : { title: plainTip(text), tip: null };
}

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
  const about = useHelp(help);
  return (
    <>
      <label className="field row" data-disabled={disabled === true} title={about.title}>
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
      {about.tip}
    </>
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
  /** Replay what plays each time it reaches its end. L toggles it too. */
  loop?: boolean;
  onLoop?(): void;
}

/** A select with its caption above it, barred in place when it cannot apply. */
export function SelectGroup({
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
  const about = useHelp(
    help === undefined && !barred ? undefined : barredTitle(barred ?? null, help ?? ""),
  );
  return (
    <div className="group" data-disabled={Boolean(barred)} title={about.title}>
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
      {about.tip}
    </div>
  );
}

/** One choice of a few, all in view: a caption over joined buttons, the
 *  one in force pressed, as the Practice and QSO switch is. One click
 *  changes it. */
export function ChoiceGroup({
  id,
  label,
  help,
  value,
  options,
  barred = null,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  /** Why it does nothing now, when another setting rules it out. */
  barred?: string | null;
  /** Each choice, with a sentence on what it does. The chosen one's shows
   *  under the buttons. */
  options: ReadonlyArray<{ value: string; label: string; note?: string }>;
  onChange(value: string): void;
}): React.ReactElement {
  const note = options.find((o) => o.value === value)?.note;
  const about = useHelp(help === undefined && !barred ? undefined : barredTitle(barred, help ?? ""));
  return (
    <div className="group choicegroup" title={about.title} data-disabled={barred !== null}>
      <span className="caption" id={`${id}-label`}>
        {label}
      </span>
      <div
        className="modeswitch"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={note ? `${id}-note` : undefined}
        data-testid={id}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={barred !== null}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* Every choice's note in the same place, only the chosen one in view,
          so the row is as tall as its tallest note and never changes height
          when the choice does. */}
      {options.some((o) => o.note) && (
        <span className="note notes" id={`${id}-note`}>
          {options.map((o) => (
            <span key={o.value} aria-hidden={o.value !== value} data-on={o.value === value}>
              {o.note ?? ""}
            </span>
          ))}
        </span>
      )}
      {about.tip}
    </div>
  );
}

const LETTER_SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

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
          {/* A switch beside the chart it plays, rather than a setting: L
              toggles it too. */}
          {props.onLoop && (
            <button
              className="loop"
              data-testid="loop"
              aria-pressed={props.loop === true}
              title={LOOP_HELP}
              onClick={props.onLoop}
            >
              Loop
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** One checkbox, barred in place when another setting rules it out.
 *
 * A barred setting keeps its place and its value, dimmed, with the reason
 * first in its tooltip. Hidden, the settings around it moved every time
 * another one changed, and there was no way to find out it existed. */
export function Check({
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
  const about = useHelp(barredTitle(barred, help));
  return (
    <div className="group">
      <label className="check" title={about.title}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={barred !== null}
          onChange={(e) => onChange(e.target.checked)}
        />{" "}
        {label}
      </label>
      {about.tip}
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
  /** Shown, but not to be changed: a session has the microphone open. */
  locked?: boolean;
}

/** A page's settings, as a form: one section after another, each setting a
 *  row with its name on the left and its control on the right. Each setting's
 *  explanation is behind a question mark after its name. */
export function SettingsForm({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <HelpTips.Provider value={true}>
      <div className="viewpanel formpanel">{children}</div>
    </HelpTips.Provider>
  );
}

/** How loud playback is, with what else plays on the page's Sound tab.
 *  `preview` plays the settings as they are changed, on a page that makes
 *  its sound from them. */
export function SoundSection({
  gainDb,
  onGainDb,
  preview,
  children,
}: {
  gainDb: number;
  onGainDb(gainDb: number): void;
  preview?: { mode: PreviewMode | null; setMode(mode: PreviewMode | null): void; barred?: string | null };
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Section name="audio" title="Sound">
      <div className="panelgroups">
        {preview && <PreviewButtons {...preview} />}
        <ListeningLevel gainDb={gainDb} onChange={onGainDb} />
        {children}
      </div>
    </Section>
  );
}

/** Preview: All, Pitch and Band, each playing the sound settings as they
 *  are changed, until pressed again or the settings close. */
function PreviewButtons({
  mode,
  setMode,
  barred = null,
}: {
  mode: PreviewMode | null;
  setMode(mode: PreviewMode | null): void;
  barred?: string | null;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, PREVIEW_HELP));
  const button = (of: PreviewMode, label: string) => (
    <button
      type="button"
      data-testid={`sound-preview-${of}`}
      aria-label={`Preview ${label.toLowerCase()}`}
      aria-pressed={mode === of}
      disabled={barred !== null}
      title={about.title}
      onClick={() => setMode(mode === of ? null : of)}
    >
      <i className="ico">{mode === of ? <IconStop /> : <IconPlay />}</i>
      {label}
    </button>
  );
  return (
    <div className="group" data-disabled={barred !== null}>
      <span className="caption" id="sound-preview-label">
        Preview
      </span>
      <div className="previewrow" role="group" aria-labelledby="sound-preview-label">
        {button("all", "All")}
        {button("pitch", "Pitch")}
        {button("band", "Band")}
      </div>
      {about.tip}
    </div>
  );
}

/** The microphone and its calibration: the page's part of the Microphone
 *  tab, where the page has a recorder. */
export function MicrophoneSection({ audio }: { audio: AudioSetup }): React.ReactElement {
  return (
    <Section name="microphone" title="In use">
      <div className="panelgroups">
        <AudioGroups audio={audio} />
      </div>
    </Section>
  );
}

/** The options of one way to record: in Settings under While I record, and
 *  under the mode in the Mode chip. */
export function ModeOptions({
  mode,
  settings: s,
  onChange,
}: {
  mode: RecordMode;
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
}): React.ReactElement {
  if (mode === "plain")
    return (
      <>
      <Check
        id="plain-follow"
        label="Scroll the chart with me, and stop when I finish"
        help={PLAIN_FOLLOW_HELP}
        checked={s.plainFollow}
        onChange={(v) => onChange({ plainFollow: v })}
      />
      <Check
        id="plain-grading"
        label="Grade each character as I key it"
        help={PLAIN_GRADING_HELP}
        checked={s.plainGrading}
        onChange={(v) => onChange({ plainGrading: v })}
      />
      </>
    );
  if (mode === "zen")
    return (
      <>
      <Check
        id="zen-progress"
        label="Show where I am in the message"
        help={ZEN_PROGRESS_HELP}
        checked={s.zenProgress}
        onChange={(v) => onChange({ zenProgress: v })}
      />
      <Check
        id="zen-grading"
        label="Grade each character as I key it"
        help={ZEN_GRADING_HELP}
        checked={s.zenGrading}
        barred={s.zenProgress ? null : NEEDS_LIVE_PROGRESS}
        onChange={(v) => onChange({ zenGrading: v })}
      />
      </>
    );
  return (
    <>
      <Check
        id="pace-absolute"
        label="Show Absolute time while recording"
        help={PACE_ABSOLUTE_HELP}
        checked={s.paceAbsolute}
        onChange={(v) => onChange({ paceAbsolute: v })}
      />
      <div className="group">
        <NumberField
          id="pace-lead"
          name="Count-in"
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
    </>
  );
}

/** The Send page's own settings.
 *
 * Grouped by the question each answers: the two ways to record, what you
 * send, how it is graded, how the chart is drawn, and what else is on the
 * page. A setting that another one rules out stays in its place, dimmed,
 * with the reason in its tooltip. */
export function SendSettings({
  settings: s,
  onChange,
}: {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
}): React.ReactElement {
  return (
    <>
      {/* The options of the three ways to record: the settings changed from
          one sitting to the next. Which mode records is picked beside the
          record button; these are set ahead of it, so they stay live whichever
          is picked. */}
      <Section name="modes" title="While I record">
        <div className="panelgroups">
          <Subgroup label="Plain">
            <ModeOptions mode="plain" settings={s} onChange={onChange} />
          </Subgroup>
          <Subgroup label="Zen">
            <ModeOptions mode="zen" settings={s} onChange={onChange} />
          </Subgroup>
          <Subgroup label="Paced">
            <ModeOptions mode="paced" settings={s} onChange={onChange} />
          </Subgroup>
        </div>
      </Section>

      <Section name="target" title="The message">
        <div className="panelgroups">
          <div className="group">
            <NumberField
              id="break-sec"
              name="Rest at each break"
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
        <div className="panelgroups checks">
          <ToleranceSlider tolerance={s.tolerance} onChange={(tolerance) => onChange({ tolerance })} />
          <Check
            id="ignore-construction"
            label="Grade only the spacing, for a keyer"
            help={IGNORE_CONSTRUCTION_HELP}
            checked={s.ignoreConstruction}
            onChange={(v) => onChange({ ignoreConstruction: v })}
          />
        </div>
      </Section>

      <Section name="display" title="The chart">
        <div className="panelgroups checks">
          <Check
            id="collapse-rests"
            label="Shrink long pauses"
            help={COLLAPSE_RESTS_HELP}
            checked={s.collapseRests}
            onChange={(v) => onChange({ collapseRests: v })}
          />
          <Check
            id="char-markers"
            label="Collapse character construction"
            help={CHAR_MARKERS_HELP}
            checked={s.charMarkers}
            onChange={(v) => onChange({ charMarkers: v })}
          />
          <Check
            id="run-scores"
            label="Show each run's scores"
            help={RUN_SCORES_HELP}
            checked={s.runScores}
            onChange={(v) => onChange({ runScores: v })}
          />
          <Check
            id="caption-all"
            label="Caption every run"
            help={CAPTION_ALL_HELP}
            checked={s.captionAll}
            onChange={(v) => onChange({ captionAll: v })}
          />
          <ChoiceGroup
            id="letter-size"
            label="Letter size"
            help={LETTER_SIZE_HELP}
            value={s.letterSize}
            options={LETTER_SIZES}
            onChange={(v) => onChange({ letterSize: v as LetterSize })}
          />
        </div>
      </Section>

      {/* Not the chart: these put a whole block on the page or take it away,
          which is a different kind of decision from how the marks above are
          drawn. */}
      <Section name="extras" title="On the page">
        <div className="panelgroups checks">
          <Check
            id="show-chart-controls"
            label="Show the chart's controls"
            help={SHOW_CHART_CONTROLS_HELP}
            checked={s.showChartControls}
            onChange={(v) => onChange({ showChartControls: v })}
          />
          <Check
            id="show-hints"
            label="Show hints"
            help={SHOW_HINTS_HELP}
            checked={s.showHints}
            onChange={(v) => onChange({ showHints: v })}
          />
          <Check
            id="advanced-grading"
            label="Show the detailed grading tables"
            help={ADVANCED_GRADING_HELP}
            checked={s.advancedGrading}
            onChange={(v) => onChange({ advancedGrading: v })}
          />
        </div>
      </Section>
    </>
  );
}

/** The Send page's part of the Sound tab: how loud. */
export function SendSound({
  gainDb,
  onGainDb,
}: {
  gainDb: number;
  onGainDb(gainDb: number): void;
}): React.ReactElement {
  return <SoundSection gainDb={gainDb} onGainDb={onGainDb} />;
}

/** A few settings that belong together, such as the options of one way to
 *  record. Its name sits in the name column beside the first of them; a
 *  setting with a name of its own, such as Count-in, keeps it on its own row.
 *  Lines separate these groups, not the settings inside one. */
export function Subgroup({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="subgroup" role="group" aria-label={label}>
      <span className="subhead" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

/** One named section of the panel. A group to assistive tech, named by its
 *  heading, so a checkbox called "Enabled" says what it enables. */
export function Section({
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

/** How loud playback is, in dB. The practice page's settings and the QSO
 *  page both draw this. */
export function ListeningLevel({
  gainDb,
  onChange,
}: {
  gainDb: number;
  onChange(gainDb: number): void;
}): React.ReactElement {
  const about = useHelp(GAIN_HELP);
  return (
    <div className="group">
      <label htmlFor="gain" title={about.title}>
        Playback volume <output id="gain-out">{fmtGain(gainDb)}</output>
      </label>
      <input
        type="range"
        id="gain"
        min={-6}
        max={42}
        step={1}
        value={gainDb}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** Noise, QRN, QRM and QSB on or off together, their settings kept. The
 *  Copy page and the QSO page both draw this. */
export function BandOnCheck({
  on,
  barred = null,
  onChange,
}: {
  on: boolean;
  barred?: string | null;
  onChange(on: boolean): void;
}): React.ReactElement {
  return <Check id="band-on" label="Play noise, QRN, QRM and QSB" help={BAND_ON_HELP} checked={on} barred={barred} onChange={onChange} />;
}

/** The AGC's settings, each with what it does. */
const AGCS: ReadonlyArray<{ value: AgcMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "slow", label: "Slow" },
  { value: "fast", label: "Fast" },
];

/** The receiver's AGC. The Copy page and the QSO page both draw this. */
export function AgcChoice({
  agc,
  barred,
  onChange,
}: {
  agc: AgcMode;
  barred: string | null;
  onChange(agc: AgcMode): void;
}): React.ReactElement {
  return (
    <ChoiceGroup
      id="agc"
      label="AGC"
      help={AGC_HELP}
      value={agc}
      options={AGCS}
      barred={barred}
      onChange={(v) => onChange(v as AgcMode)}
    />
  );
}

/** The straight key's top speed, said where a station's speed is set. */
export const STRAIGHT_SPEED_HELP = `A station on a straight key sends no faster than ${STRAIGHT_MOST_WPM} WPM.`;

/** The keys a station may send with, each with how it sounds: the friend
 *  form and Paddle both list them. */
export const KEY_OPTIONS: ReadonlyArray<{ key: KeyKind; label: string; help: string }> = [
  { key: "keyer", label: "Keyer", help: "Every dit and dah exact." },
  { key: "bug", label: "Bug", help: "Even dits, and long dahs made by hand that vary." },
  { key: "straight", label: "Straight key", help: `Every dit and dah made by hand, with wide gaps between letters. ${STRAIGHT_SPEED_HELP}` },
];

/** A checkbox for each key, all on one row, for the keys in `keys`. Each
 *  says how it sounds on hover. The last one checked cannot be cleared: a
 *  station sends with at least one. */
export function KeyChecks({
  idPrefix,
  keys,
  barred = null,
  allowNone = false,
  onChange,
}: {
  idPrefix: string;
  keys: readonly KeyKind[];
  barred?: string | null;
  /** The friend form says when none is checked, so it may clear the last. */
  allowNone?: boolean;
  onChange(keys: KeyKind[]): void;
}): React.ReactElement {
  return (
    <div className="group" data-disabled={barred !== null}>
      <div className="keyrow" data-testid={`${idPrefix}keys`}>
        {KEY_OPTIONS.map((k) => {
          const on = keys.includes(k.key);
          const why = barred ?? (on && keys.length === 1 && !allowNone ? ONE_KEY : null);
          return (
            <label key={k.key} className="check" title={plainTip(why ?? k.help)}>
              <input
                type="checkbox"
                id={`${idPrefix}key-${k.key}`}
                checked={on}
                disabled={why !== null}
                onChange={(e) =>
                  onChange(KEY_OPTIONS.map((o) => o.key).filter((o) => (o === k.key ? e.target.checked : keys.includes(o))))
                }
              />{" "}
              {k.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** The keys `keys` holds, by name, in the order of `KEY_OPTIONS`: Keyer
 *  or bug, or Keyer, bug or straight key. */
export function keysLabel(keys: readonly KeyKind[]): string {
  const names = KEY_OPTIONS.filter((k) => keys.includes(k.key)).map((k, i) => (i ? k.label.toLowerCase() : k.label));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join("");
}

/** A key by name, in a sentence: a bug, a straight key. */
export function keyName(key: KeyKind): string {
  return `a ${KEY_OPTIONS.find((k) => k.key === key)!.label.toLowerCase()}`;
}

/** The key a line was sent on, beside its speed: an icon for a key worked
 *  by hand, and nothing for a keyer. Hovering it names the key. It never
 *  names the station, whose call may be blurred. */
export function KeyMark({ fist }: { fist: Fist | undefined }): React.ReactElement | null {
  return fist ? <KeyIcon kind={fist.key} /> : null;
}

/** The icon of a key worked by hand, with its themed tooltip. */
function KeyIcon({ kind }: { kind: Exclude<KeyKind, "keyer"> }): React.ReactElement {
  const says = `The station sent this line on ${keyName(kind)}.`;
  const tip = useTip<HTMLSpanElement>(says);
  return (
    <span ref={tip.anchor} className="lkey" data-key={kind} role="img" aria-label={says} {...tip.on}>
      {kind === "bug" ? <IconBug /> : <IconStraightKey />}
      {tip.box}
    </span>
  );
}

/** What Paddle's chip shows: Default, Any with every key checked, or the
 *  keys it sets. */
export function paddleLabel(ks: { keys: readonly KeyKind[] | null }): string {
  if (ks.keys === null) return "Default";
  return KEY_OPTIONS.every((k) => ks.keys!.includes(k.key)) ? "Any" : keysLabel(ks.keys);
}

const ONE_KEY = "One must stay checked. Check another first.";

/** What the stations send with: Default as on the air, or only the ones
 *  you check. */
const KEY_STYLES: ReadonlyArray<{ value: "default" | "only"; label: string; note: string }> = [
  { value: "default", label: "Default", note: "Mostly a keyer, now and then a bug or a straight key, as on the air." },
  { value: "only", label: "Only these", note: "Each station uses one of the ones you check." },
];

/** Paddle, kept as a preference the Copy and QSO pages share. `keys` is the
 *  keys every station sends with, or null for Default. */
export function useKeyStyle(): {
  style: "default" | "only";
  checked: readonly KeyKind[];
  keys: readonly KeyKind[] | null;
  setStyle(style: "default" | "only"): void;
  setChecked(keys: KeyKind[]): void;
} {
  const [style, setStyleRaw] = useState(() => loadPrefs().keyStyle ?? "default");
  const [checked, setCheckedRaw] = useState<readonly KeyKind[]>(() => loadPrefs().styleKeys ?? ["keyer"]);
  return {
    style,
    checked,
    keys: style === "only" ? checked : null,
    setStyle: (next) => {
      setStyleRaw(next);
      savePrefs({ ...loadPrefs(), keyStyle: next });
    },
    setChecked: (next) => {
      setCheckedRaw(next);
      savePrefs({ ...loadPrefs(), styleKeys: next });
    },
  };
}

/** Paddle: what the stations send with. The Copy and QSO pages both
 *  draw this. */
export function KeyStyleGroup({ ks }: { ks: ReturnType<typeof useKeyStyle> }): React.ReactElement {
  return (
    <>
      <ChoiceGroup
        id="key-style"
        label="Paddle"
        help={KEY_STYLE_HELP}
        value={ks.style}
        options={KEY_STYLES}
        onChange={(v) => ks.setStyle(v as "default" | "only")}
      />
      <KeyChecks
        idPrefix="style-"
        keys={ks.checked}
        barred={ks.style === "only" ? null : "Pick *Only these* to choose."}
        onChange={ks.setChecked}
      />
    </>
  );
}

/** QSB: how deep a generated station fades. The Copy page and the QSO page
 *  both draw this. */
export function QsbSlider({
  qsbDb,
  barred = null,
  onChange,
}: {
  qsbDb: number;
  barred?: string | null;
  onChange(qsbDb: number): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, QSB_HELP));
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="qsb" title={about.title}>
        QSB <output id="qsb-out">{qsbDb > 0 ? `${qsbDb} dB` : "Off"}</output>
      </label>
      <input
        type="range"
        id="qsb"
        min={0}
        max={QSB_MAX_DB}
        step={QSB_STEP_DB}
        value={qsbDb}
        disabled={barred !== null}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** How loud the band noise is under a generated station. The Copy page and
 *  the QSO page both draw this. */
export function NoiseSlider({
  noiseDb,
  barred = null,
  onChange,
}: {
  noiseDb: number;
  barred?: string | null;
  onChange(noiseDb: number): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, NOISE_HELP));
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="noise" title={about.title}>
        Noise <output id="noise-out">{noiseOn(noiseDb) ? `${noiseDb} dB` : "Off"}</output>
      </label>
      <input
        type="range"
        id="noise"
        min={NOISE_OFF_DB}
        max={NOISE_MAX_DB}
        step={NOISE_STEP_DB}
        value={noiseDb}
        disabled={barred !== null}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** QRN: static crashes on a generated station. The Copy page and the QSO
 *  page both draw this. */
export function QrnSlider({
  qrn,
  barred = null,
  onChange,
}: {
  qrn: number;
  barred?: string | null;
  onChange(qrn: number): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, QRN_HELP));
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="qrn" title={about.title}>
        QRN <output id="qrn-out">{QRN_LEVELS[qrn] ?? QRN_LEVELS[0]}</output>
      </label>
      <input
        type="range"
        id="qrn"
        min={0}
        max={QRN_LEVELS.length - 1}
        step={1}
        value={qrn}
        disabled={barred !== null}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** QRM: another station near a generated one. The Copy page and the QSO
 *  page both draw this. */
export function QrmSlider({
  qrmDb,
  barred = null,
  onChange,
}: {
  qrmDb: number;
  barred?: string | null;
  onChange(qrmDb: number): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, QRM_HELP));
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="qrm" title={about.title}>
        QRM <output id="qrm-out">{qrmOn(qrmDb) ? `${qrmDb} dB` : "Off"}</output>
      </label>
      <input
        type="range"
        id="qrm"
        min={QRM_OFF_DB}
        max={QRM_MAX_DB}
        step={QRM_STEP_DB}
        value={qrmDb}
        disabled={barred !== null}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** Station pitch, kept as a preference the Copy and QSO pages share. */
export function usePitchRange(): { pitch: PitchRange; setPitch(pitch: PitchRange): void } {
  const [pitch, setPitchRaw] = useState<PitchRange>(() => loadPrefs().stationPitch ?? DEFAULT_PITCH);
  return {
    pitch,
    setPitch: (next) => {
      setPitchRaw(next);
      savePrefs({ ...loadPrefs(), stationPitch: { lowHz: next.lowHz, highHz: next.highHz } });
    },
  };
}

/** Station pitch: the lowest and highest pitch a generated station sends
 *  at, one slider with a handle at each end. The Copy page and the QSO page
 *  both draw this. */
export function PitchSlider({
  pitch,
  barred = null,
  onChange,
}: {
  pitch: PitchRange;
  barred?: string | null;
  onChange(pitch: PitchRange): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, PITCH_HELP));
  const { lowHz, highHz } = pitch;
  const at = (hz: number) => (hz - PITCH_MIN_HZ) / (PITCH_MAX_HZ - PITCH_MIN_HZ);
  // The low end's handle on top once it nears the top of the slider, so the
  // two ends together can still be dragged down.
  const lowOnTop = at(lowHz) > 0.5;
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="pitch-low" title={about.title}>
        Station pitch <output id="pitch-out">{lowHz === highHz ? `${lowHz} Hz` : `${lowHz}–${highHz} Hz`}</output>
      </label>
      <div className="pitchrange" data-low-on-top={lowOnTop} style={{ "--from": at(lowHz), "--to": at(highHz) } as React.CSSProperties}>
        <input
          type="range"
          id="pitch-low"
          aria-label="Lowest station pitch"
          min={PITCH_MIN_HZ}
          max={PITCH_MAX_HZ}
          step={PITCH_STEP_HZ}
          value={lowHz}
          disabled={barred !== null}
          onChange={(e) => onChange({ lowHz: Math.min(Number(e.target.value), highHz), highHz })}
        />
        <input
          type="range"
          id="pitch-high"
          aria-label="Highest station pitch"
          min={PITCH_MIN_HZ}
          max={PITCH_MAX_HZ}
          step={PITCH_STEP_HZ}
          value={highHz}
          disabled={barred !== null}
          onChange={(e) => onChange({ lowHz, highHz: Math.max(Number(e.target.value), lowHz) })}
        />
      </div>
      {about.tip}
    </div>
  );
}

/** The break-in delay a radio starts with, near enough. */
export const DEFAULT_BREAK_IN_MS = 800;

/** The longest break-in delay, in ms. */
const BREAK_IN_MAX_MS = 2000;

/** How long the QSO page's band stays cut after your last mark, as a
 *  radio's break-in delay. */
export function BreakInSlider({
  ms,
  barred,
  onChange,
}: {
  ms: number;
  barred: string | null;
  onChange(ms: number): void;
}): React.ReactElement {
  const about = useHelp(barredTitle(barred, BREAK_IN_HELP));
  return (
    <div className="group" data-disabled={barred !== null}>
      <label htmlFor="break-in" title={about.title}>
        Break-in delay <output id="break-in-out">{ms > 0 ? `${ms} ms` : "Full"}</output>
      </label>
      <input
        type="range"
        id="break-in"
        min={0}
        max={BREAK_IN_MAX_MS}
        step={50}
        value={ms}
        disabled={barred !== null}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {about.tip}
    </div>
  );
}

/** The microphone, barred in place when there is only one. The practice
 *  page's settings and the QSO page both draw this. */
export function MicrophoneGroup({
  devices,
  deviceId,
  onDeviceChange,
  locked = false,
}: {
  devices: readonly InputDevice[];
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  /** Shown, but not to be changed. */
  locked?: boolean;
}): React.ReactElement {
  const oneInput = devices.length <= 1 ? ONE_INPUT : null;
  const about = useHelp(barredTitle(oneInput, MIC_HELP));
  return (
    <div
      className="group"
      data-disabled={oneInput !== null}
      title={about.title}
      inert={locked}
      data-locked={locked}
    >
      <label htmlFor="input-device">Microphone</label>
      <select
        id="input-device"
        value={deviceId ?? ""}
        disabled={oneInput !== null}
        onChange={(e) => onDeviceChange(e.target.value || undefined)}
      >
        <option value="">Default input</option>
        {/* Keyed by position as well as by id: before the browser hands
            over the identifiers, several inputs share an empty one. */}
        {devices.map((d, i) => (
          <option key={`${d.deviceId}:${i}`} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
      {about.tip}
    </div>
  );
}

/** The microphone and its calibration, each barred in place when there is
 *  nothing to choose. */
export function AudioGroups({ audio }: { audio: AudioSetup }): React.ReactElement {
  const choices = profilesFor([...audio.profiles], audio.deviceId, audio.profileId);
  const active = audio.profiles.find((p) => p.id === audio.profileId) ?? null;
  const calBarred = !audio.appliesToTake
    ? CAL_FILE
    : audio.rereading
      ? CAL_REREADING
      : choices.length === 0
        ? CAL_NONE
        : null;
  const calAbout = useHelp(barredTitle(calBarred, CAL_HELP));
  return (
    <>
      <MicrophoneGroup
        devices={audio.devices}
        deviceId={audio.deviceId}
        onDeviceChange={audio.onDeviceChange}
        locked={audio.locked === true}
      />

      <div
        className="group"
        inert={audio.locked === true}
        data-locked={audio.locked === true}
        data-testid="calpick"
        data-disabled={calBarred !== null}
        title={calAbout.title}
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
        {calAbout.tip}
      </div>
    </>
  );
}
