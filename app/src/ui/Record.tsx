/* The recording controls, in the two sizes the app needs them.
 *
 * `RecordBar` is the compact one, for the review header: once you have looked
 * at a take the next thing you want is almost always another attempt at the
 * same thing, and sending you back to the landing screen to get it would throw
 * away the settings you just dialed in. The pieces it shares with the landing
 * screen's larger arrangement live here too, so the two cannot drift.
 */

import type { InputDevice } from "@/capture/mic";
import type { Profile } from "@/io/profiles";
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

export interface DevicePickerProps {
  devices: InputDevice[];
  value: string | undefined;
  onChange(id: string | undefined): void;
}

/** Only rendered when there is a choice to make: one input is not a decision,
 *  it is a fact, and a select with a single option is noise. */
export function DevicePicker({
  devices,
  value,
  onChange,
}: DevicePickerProps): React.ReactElement | null {
  if (devices.length <= 1) return null;
  return (
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
  /** The calibration the next take would be made under. Shown rather than
   *  assumed: this bar is one click from a recording, and whether a profile is
   *  applied moves every number on the page below it. Changing it is the
   *  landing screen's job — this only has to stop it being a surprise. */
  profile: Profile | null;
}

/** Record another, without leaving the review. */
export function RecordBar({
  rec,
  deviceId,
  onDeviceChange,
  profile,
}: RecordBarProps): React.ReactElement {
  if (rec.recorder) {
    return (
      <div className="recordbar recording">
        <span className="reclight">
          <span className="dot" />
          {fmtElapsed(rec.elapsed)}
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

  return (
    <div className="recordbar">
      <button onClick={() => void rec.start()} disabled={rec.busy}>
        <RecDot /> Record another
      </button>
      <DevicePicker devices={rec.devices} value={deviceId} onChange={onDeviceChange} />
      <span className={`calchip ${profile ? "ok" : "none"}`} title={
        profile
          ? `Recordings are corrected by "${profile.nickname}" — ${(profile.releaseOffsetSec * 1000).toFixed(1)} ms off every element`
          : "Recordings are decoded exactly as captured"
      }>
        <span className="dot" aria-hidden="true" />
        {profile ? profile.nickname : "not calibrated"}
      </span>
    </div>
  );
}
