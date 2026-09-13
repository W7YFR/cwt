/* The recording controls, in the two sizes the app needs them.
 *
 * `RecordBar` is the compact one, for the review header: once you have looked
 * at a take the next thing you want is almost always another attempt at the
 * same thing, and sending you back to the landing screen to get it would throw
 * away the settings you just dialed in. The pieces it shares with the landing
 * screen's larger arrangement live here too, so the two cannot drift.
 */

import type { InputDevice } from "@/capture/mic";
import { profilesFor, type Profile } from "@/io/profiles";
import { fmtElapsed } from "./format";
import type { RecorderHandle } from "./useRecorder";

/** The dot on every button that starts a recording.
 *
 * Its own component so the three buttons that carry one cannot drift apart,
 * and red because that is what a record button is — the bare character
 * inherits the button's text colour and reads as a bullet. Hidden from
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
      className="cog"
      onClick={onClick}
      title="Configuration"
      aria-label="Configuration"
      data-testid="cog"
    >
      ⚙
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
}: RecordBarProps): React.ReactElement {
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
        <button onClick={() => void rec.discard()}>Cancel</button>
        <span className="hint">enter to finish · esc to cancel</span>
      </div>
    );
  }

  const active = profiles.find((p) => p.id === profileId) ?? null;

  return (
    <div className="recordbar">
      <button onClick={() => void rec.start()} disabled={rec.busy}>
        <RecDot /> Record another
      </button>
      <DevicePicker devices={rec.devices} value={deviceId} onChange={onDeviceChange} />

      {appliesToTake ? (
        /* A picker rather than a label, because the audio is right here and
           reading it again under a different calibration is the same
           computation that ran when it was recorded. Holding the recording
           fixed and changing only the correction is the cleanest comparison
           available anywhere in the app — the room, the placement and the fist
           cannot vary, because it is one recording. */
        <span className={`calpick ${active ? "ok" : "none"}`} data-testid="calpick">
          <span className="dot" aria-hidden="true" />
          <select
            aria-label="Calibration"
            value={profileId ?? ""}
            disabled={rereading}
            onChange={(e) => onProfileChange(e.target.value || undefined)}
          >
            <option value="">No calibration</option>
            {profilesFor(profiles, deviceId, profileId).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname} — {(p.releaseOffsetSec * 1000).toFixed(1)} ms, {p.verdict}
              </option>
            ))}
          </select>
          <span className="hint" aria-live="polite">
            {rereading ? "reading it again…" : "applies to this recording"}
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
