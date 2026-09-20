/* The recording controls, in the two sizes the app needs them.
 *
 * `RecordBar` is the compact one, for the review header: once you have looked
 * at a take the next thing you want is almost always another attempt at the
 * same thing, and sending you back to the landing screen to get it would throw
 * away the settings you just dialed in. The pieces it shares with the landing
 * screen's larger arrangement live here too, so the two cannot drift.
 */

import { useRef } from "react";
import { ACCEPTED } from "@/capture/file";
import type { InputDevice } from "@/capture/mic";
import { profilesFor, type Profile } from "@/io/profiles";
import { fmtElapsed } from "./format";
import { OPEN_FILE_CLOSED, OPEN_FILE_HELP } from "./copy";
import type { RecorderHandle } from "./useRecorder";

/** The dot on every button that starts a recording.
 *
 * Its own component so the three buttons that carry one cannot drift apart,
 * and red because that is what a record button is — the bare character
 * inherits the button's text color and reads as a bullet. Hidden from
 * assistive tech: the label beside it already says what it does. */
export function RecDot(): React.ReactElement {
  return (
    <span className="recdot" aria-hidden="true">
      ●
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
      <span aria-hidden="true">⚙</span>
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
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
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
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  /** Saved calibrations, and which one is in use. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): void;
  /** Whether changing it re-reads the recording on screen.
   *
   * True for a microphone take, false for an opened file — a file came from
   * somewhere else and is never corrected, so the picker would be claiming an
   * effect it is not allowed to have. */
  appliesToTake: boolean;
  /** True while the recording is being read again. */
  rereading: boolean;
  /** Seconds left of the pacing cursor's lead-in; 0 once it is running, null
   *  when there is no cursor. */
  leadLeft: number | null;
  /** Throw the recording away and stay here. Absent when there is nothing to
   *  throw away. */
  onClear?: (() => void) | undefined;
  /** Start over at a new message and a new speed. */
  onNewSession?: (() => void) | undefined;
  /** Open a recording from disk.
   *
   * Beside dropping one on the page rather than instead of it. The drop target
   * is the whole window and says nothing about itself until something is being
   * dragged over it, so on its own it is a feature you have to already know
   * about. */
  onFile?: ((file: File) => void) | undefined;
  /** False once the session has something in it — see the title below. */
  canOpenFile?: boolean | undefined;
  /** Into the calibration wizard. Beside the picker, because the picker is
   *  where you find out you have nothing to pick. */
  onCalibrate?: (() => void) | undefined;
  /** The configuration panel is open.
   *
   * What is behind it is the setup: which microphone, and what to correct it
   * by. You cannot reach this screen without having already answered the
   * first, and the answer holds for as long as you are plugged into the same
   * thing — so on the row you are actually working in, a microphone picker is
   * a control you will use once and read past every time after. */
  configuring?: boolean;
}

/** Record another, without leaving the review. */
export function RecordBar({
  rec,
  deviceId,
  onDeviceChange,
  profiles,
  profileId,
  onProfileChange,
  appliesToTake,
  rereading,
  leadLeft,
  onClear,
  onNewSession,
  onFile,
  canOpenFile = true,
  onCalibrate,
  configuring = false,
}: RecordBarProps): React.ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);

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
        <button className="primary" onClick={() => void rec.finish()} disabled={rec.busy}>
          Stop and review
        </button>
        {/* Between finishing and throwing it away, because that is where it
            sits in the decision: you are keeping the device open and having
            another go, which is neither of the other two. */}
        <button onClick={rec.restart}>Restart</button>
        <button onClick={() => void rec.discard()}>Cancel</button>
        <span className="hint">enter to finish · r to restart · esc to cancel</span>
      </div>
    );
  }

  const active = profiles.find((p) => p.id === profileId) ?? null;
  /** The calibrations this recording could be read under. */
  const choices = profilesFor(profiles, deviceId, profileId);

  return (
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
            <span aria-hidden="true">↑</span>
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
          you clicked. Otherwise it records, which is what it is for. */}
      <button
        className="iconbtn"
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
      {onClear && (
        <button
          onClick={onClear}
          data-testid="clear-take"
          title="Drop this recording and keep the message, the speeds and the settings"
        >
          Clear
        </button>
      )}
      {configuring && (
        <DevicePicker devices={rec.devices} value={deviceId} onChange={onDeviceChange} />
      )}

      {appliesToTake ? (
        /* A picker rather than a label, because the audio is right here and
           reading it again under a different calibration is the same
           computation that ran when it was recorded. Holding the recordings
           fixed and changing only the correction is the cleanest comparison
           available anywhere in the app — the room, the placement and the fist
           cannot vary, because it is the same audio either way.

           No status dot beside it: what that reported is already in the select
           itself, in words, and a warning color on "No calibration" calls an
           ordinary state a problem — it is the state every session starts in,
           and the right one for a path with nothing in it. */
        <span className={`calpick ${active ? "ok" : "none"}`} data-testid="calpick">
          {/* Only where there is a choice to make. One option is not a
              decision, and a select offering "No calibration" and nothing else
              is a control whose every state is the state it is already in. */}
          {choices.length > 0 && (
            <select
              aria-label="Calibration"
              value={profileId ?? ""}
              disabled={rereading}
              onChange={(e) => onProfileChange(e.target.value || undefined)}
            >
              <option value="">No calibration</option>
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname} — {(p.releaseOffsetSec * 1000).toFixed(1)} ms, {p.verdict}
                </option>
              ))}
            </select>
          )}
          {/* The way out of an empty list. Calibrating is reached from the
              landing screen and from the configuration screen, neither of
              which is where you are standing when the picker in front of you
              says there is nothing to apply. */}
          {configuring && onCalibrate && (
            <button
              className="cal"
              data-testid="calibrate"
              onClick={onCalibrate}
              title={
                active
                  ? `Measure this microphone again — in use: ${active.nickname}`
                  : "Measure this microphone, so your timing is yours and not the sound path's"
              }
            >
              {active ? "Recalibrate" : "Calibrate"}
            </button>
          )}
          {/* Only while it is happening. Changing the calibration re-reads the
              recording on screen, which takes long enough to need saying —
              but a line that is on show the whole time to explain a control
              nobody has touched yet is a caption, and this row already has as
              many as it can carry. */}
          <span className="hint" aria-live="polite">
            {rereading ? "re-reading the session…" : ""}
          </span>
        </span>
      ) : (
        <span className="calchip none" data-testid="calchip">
          <span className="dot" aria-hidden="true" />
          read exactly as recorded
        </span>
      )}
    </div>
  );
}
