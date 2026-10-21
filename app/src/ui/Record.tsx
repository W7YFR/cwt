/* The recording controls, in the two sizes the app needs them.
 *
 * `RecordBar` is the compact one, for the review header: once you have looked
 * at a take the next thing you want is almost always another attempt at the
 * same thing, and sending you back to the landing screen to get it would throw
 * away the settings you just dialed in. The pieces it shares with the landing
 * screen's larger arrangement live here too, so the two cannot drift.
 */

import { useMemo, useRef } from "react";
import { ACCEPTED } from "@/capture/file";
import type { InputDevice } from "@/capture/mic";
import { loadDrills, type Drill } from "@/drills";
import type { Profile } from "@/io/profiles";
import { DrillPicker } from "./DrillPicker";
import { fmtElapsed } from "./format";
import { IconCog, IconRecord, IconUpload } from "./Icons";
import { MicDebug } from "./MicDebug";
import { OPEN_FILE_CLOSED, OPEN_FILE_HELP } from "./copy";
import type { RecorderHandle } from "./useRecorder";
import { RECORD_MODES, type RecordMode } from "./mode";
import { MODE_HELP } from "./copy";

/** The dot on every button that starts a recording.
 *
 * Its own component so the three buttons that carry one cannot drift apart,
 * and red because that is what a record button is — the bare character
 * inherits the button's text color and reads as a bullet. Hidden from
 * assistive tech: the label beside it already says what it does. */
export function RecDot(): React.ReactElement {
  return (
    <span className="recdot">
      <IconRecord />
    </span>
  );
}

/** The way to the configuration screen.
 *
 * Shared and identically placed on both screens, because a control that moves
 * between screens is one somebody has to look for twice. Nothing behind it is
 * needed to use the app — it is where things get tidied up, not where they get
 * decided — so it sits out of the way and stays out of the tab order's path.
 */
export function Cog({ onClick }: { onClick(): void }): React.ReactElement {
  return (
    <button
      className="iconbtn cornerbtn"
      onClick={onClick}
      title="Configuration"
      aria-label="Configuration"
      data-testid="cog"
    >
      <IconCog />
    </button>
  );
}

export interface DevicePickerProps {
  devices: InputDevice[];
  value: string | undefined;
  onChange(id: string | undefined): void;
  /** Shown above the control. Worth giving wherever another select is in
   *  reach: two unlabeled dropdowns in the same place read as one control that
   *  has changed its mind, which is exactly how the wizard's microphone picker
   *  read against the landing screen's calibration picker. */
  label?: string;
}

/** Only rendered when there is a choice to make: one input is not a decision,
 *  it is a fact, and a select with a single option is noise. */
export function DevicePicker({
  devices,
  value,
  onChange,
  label,
}: DevicePickerProps): React.ReactElement | null {
  if (devices.length <= 1) return null;
  const select = (
    <select
      aria-label="Input device"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">Default input</option>
      {/* Keyed by position as well as by id, because the id is not reliably
          unique: a browser that has granted the microphone but is still
          withholding the identifiers hands back several inputs with an empty
          `deviceId`, and React then sees one option that keeps changing its
          mind. The position is stable for as long as the list is. */}
      {devices.map((d, i) => (
        <option key={`${d.deviceId}:${i}`} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <label className="field">
      <span className="fieldname">{label}</span>
      {select}
    </label>
  );
}

/** The way into the calibration wizard.
 *
 * Its own component because two places offer it, and they offer it for two
 * different reasons: beside the calibration picker, which is where you find
 * out there is nothing to apply, and beside the device picker, which is the
 * only setup control a take opened from a file has. Written once so the two
 * cannot drift into being two differently-worded buttons for one act.
 */
export function CalibrateButton({
  active,
  applied,
  onClick,
}: {
  /** The calibration saved for this input, if there is one. */
  active: Profile | null;
  /** Whether that calibration is being applied to what is on screen.
   *
   * False for a take opened from a file: the measurement still exists and
   * recalibrating still means something, but a file is read exactly as
   * recorded — so "in use" would be a claim about the numbers on this page
   * that is not true of them. */
  applied: boolean;
  onClick(): void;
}): React.ReactElement {
  return (
    <button
      className="cal"
      data-testid="calibrate"
      onClick={onClick}
      title={
        active
          ? applied
            ? `Measure this microphone again — in use: ${active.nickname}`
            : `Measure this microphone again — saved: ${active.nickname}`
          : "Measure this microphone, so your timing is yours and not the sound path's"
      }
    >
      {active ? "Recalibrate" : "Calibrate"}
    </button>
  );
}

export function LevelMeter({ level }: { level: number }): React.ReactElement {
  return (
    <div className="meter" aria-hidden="true">
      <i
        className={level > 0.95 ? "hot" : ""}
        style={{ width: `${Math.min(level, 1) * 100}%` }}
      />
    </div>
  );
}

export interface RecordBarProps {
  rec: RecorderHandle;
  /** True for a microphone take, false for an opened file. A file is read
   *  exactly as recorded, and the bar says so beside its name. */
  appliesToTake: boolean;
  /** Seconds left of the pacing cursor's lead-in; 0 once it is running, null
   *  when there is no cursor. */
  leadLeft: number | null;
  /** Throw the recording away and stay here. Absent when there is nothing to
   *  throw away, and Clear is off. */
  onClear?: (() => void) | undefined;
  /** Start over at a new message and a new speed. */
  onNewSession?: (() => void) | undefined;
  /** Start a new session at a drill's text, at the current speeds. */
  onDrill?: ((drill: Drill) => void) | undefined;
  /** Open a recording from disk.
   *
   * Beside dropping one on the page rather than instead of it. The drop target
   * is the whole window and says nothing about itself until something is being
   * dragged over it, so on its own it is a feature you have to already know
   * about. */
  onFile?: ((file: File) => void) | undefined;
  /** False once the session has something in it — see the title below. */
  canOpenFile?: boolean | undefined;
  /** How the next take records, beside the button that starts it. The
   *  options of each mode are in Settings. */
  mode?: RecordMode | undefined;
  onMode?: ((mode: RecordMode) => void) | undefined;
  /** What the recording is called, for a take that came from a file.
   *
   * Here rather than beside the bar in the review, because it is half of one
   * line: a filename and the note saying how that file is being read belong
   * together, and laid out as separate children of the header the note could
   * only ever sit above the name or at the end of a row of buttons. Ignored
   * for a microphone take, which has no name worth the room — "microphone" is
   * the same word every time and is already implied by having just recorded. */
  source?: string | undefined;
}

/** Record another, without leaving the review. */
export function RecordBar({
  rec,
  appliesToTake,
  leadLeft,
  onClear,
  onNewSession,
  onDrill,
  onFile,
  canOpenFile = true,
  mode,
  onMode,
  source,
}: RecordBarProps): React.ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  // Read on mount: the configuration page, where the details and the custom
  // drills change, replaces this screen while it is open.
  const drills = useMemo(loadDrills, []);

  if (rec.recorder) {
    return (
      <div className="recordbar recording">
        {/* Counting down to the cursor setting off, then the ordinary clock.
            Blue while you are waiting and green once it is your turn — the
            same two signals the calibration wizard uses, for the same reason:
            it has to be readable out of the corner of an eye by somebody
            looking at a paddle. */}
        <span
          className="reclight"
          data-testid="reclight"
          data-state={leadLeft ? "waiting" : "sending"}
        >
          <span className="dot" />
          {leadLeft ? `in ${leadLeft}` : fmtElapsed(rec.elapsed)}
        </span>
        <LevelMeter level={rec.level} />
        {/* The three of them in a group, so a narrow screen can move them as
            one. Loose in the row they wrap individually — "Stop and review"
            breaking across two lines while Cancel hangs off the edge — and the
            clock and the meter, which are the things you are actually watching
            while you key, get shoved along by whichever button went first.
            The group's own gap is the row's, so where there is room for one
            line this is laid out exactly as it was. */}
        <div className="recbtns">
          <button className="primary" onClick={() => void rec.finish()} disabled={rec.busy}>
            Stop and review
          </button>
          {/* Between finishing and throwing it away, because that is where it
              sits in the decision: you are keeping the device open and having
              another go, which is neither of the other two. */}
          <button onClick={rec.restart}>Restart</button>
          <button onClick={() => void rec.discard()}>Cancel</button>
        </div>
        <span className="hint">enter to finish · r to restart · esc to cancel</span>
      </div>
    );
  }

  return (
    <>
      <div className="recordbar">
        {onFile && (
          <>
            {/* Icon only, and first, because opening a file is the rarer of the
                two ways in — it reads as the smaller sibling of Record rather
                than as a competing headline. */}
            <button
              className="iconbtn"
              data-testid="open-file"
              disabled={!canOpenFile}
              aria-label="Open a recording"
              title={canOpenFile ? OPEN_FILE_HELP : OPEN_FILE_CLOSED}
              onClick={() => fileInput.current?.click()}
            >
              <IconUpload />
            </button>
            {/* The button is the control; this is only the file dialog it
                opens. Left in the tab order it is a stop on nothing: focus
                lands on a clipped 1px box with no visible ring. */}
            <input
              ref={fileInput}
              className="visually-hidden"
              tabIndex={-1}
              type="file"
              accept={ACCEPTED}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
                // Cleared, or choosing the same file twice in a row is silent.
                e.target.value = "";
              }}
            />
          </>
        )}
        {/* One button, three things it can mean, because there is only ever one
            of them true and a second button for the rare ones would be two
            controls that are never both useful.

            Blocked, it is barred: nothing on the page can lift that, so a live
            button would open a prompt the browser never shows. Unasked, it asks
            — the landing screen separates the two for the same reason, and here
            the separation is in what the click does rather than in which button
            you clicked. Otherwise it records, which is what it is for.

            Unasked, it also says so in words. The landing screen no longer
            asks first, so this is where a first visit meets the question, and
            a red dot that opens a permission prompt is not what it promised. */}
        <button
          className={rec.needAccess ? undefined : "iconbtn"}
          data-testid="record-another"
          onClick={() => void (rec.needAccess ? rec.grantAccess() : rec.start())}
          disabled={rec.busy || rec.blocked || rec.probing}
          aria-label={
            rec.blocked
              ? "Recording unavailable — microphone blocked"
              : rec.needAccess
                ? "Allow the microphone"
                : "Record another"
          }
          title={
            rec.blocked
              ? "Microphone access is blocked for this site. Allow it in your browser's settings for this page, then reload."
              : rec.needAccess
                ? "Allow the microphone first — nothing is recorded by asking"
                : "Record another — or press R"
          }
        >
          <RecDot />
          {rec.needAccess && " Allow microphone"}
        </button>
        {/* Not "back": this keeps the session — the message, the speeds, the
            pacing cursor — and drops only what was recorded into it, which is
            the loop. Set it up, hear the target, send it, look at it, wipe it,
            send it again. */}
        {onNewSession && (
          <button
            onClick={onNewSession}
            data-testid="new-session-open"
            title="Clear the session and set a new message and speed"
          >
            New session
          </button>
        )}
        {onDrill && <DrillPicker drills={drills} onPick={onDrill} floating />}
        {mode && onMode && <ModeSwitch mode={mode} onMode={onMode} />}
        {/* Always here, as on the other pages, so the bar does not move. Off
            with nothing to clear. */}
        <button
          onClick={onClear}
          disabled={!onClear}
          data-testid="clear-take"
          title="Drop this recording and keep the message, the speeds and the settings"
        >
          Clear
        </button>
      </div>

      {/* Nothing at all without `?micdebug` in the URL. */}
      <MicDebug rec={rec} />

      {/* Outside the bar, not in it.

          This is an annotation on the recording rather than another control
          in the row — and on a narrow screen that difference is what lets it
          drop to a line of its own instead of squeezing four buttons. */}
      {!appliesToTake && (
        /* The name, and what is being done to it, on one line.
           A filename is the one thing in this header whose width nobody
           controls, so it gets a row rather than a place in the button row —
           but a row of its own was more room than a name needs, and the note
           beside it had nowhere better to be. Together they read as one
           statement about the recording on screen. */
        <div className="srcrow">
          {source !== undefined && <p className="src">{source}</p>}
          <span className="calchip none" data-testid="calchip">
            <span className="dot" aria-hidden="true" />
            read exactly as recorded
          </span>
        </div>
      )}
    </>
  );
}

/** Plain, Paced or Zen: one choice, so one control. A row of pressed and
 *  unpressed buttons rather than a select, because the choice is made often
 *  and all three should be in view. */
function ModeSwitch({
  mode,
  onMode,
}: {
  mode: RecordMode;
  onMode(mode: RecordMode): void;
}): React.ReactElement {
  return (
    <div className="modeswitch" role="group" aria-label="Recording mode" data-testid="mode">
      {RECORD_MODES.map((m) => (
        <button
          key={m.value}
          aria-pressed={mode === m.value}
          title={MODE_HELP[m.value]}
          onClick={() => onMode(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
