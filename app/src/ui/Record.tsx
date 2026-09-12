/* The recording controls, in the two sizes the app needs them.
 *
 * `RecordBar` is the compact one, for the review header: once you have looked
 * at a take the next thing you want is almost always another attempt at the
 * same thing, and sending you back to the landing screen to get it would throw
 * away the settings you just dialed in. The pieces it shares with the landing
 * screen's larger arrangement live here too, so the two cannot drift.
 */

import type { InputDevice } from "@/capture/mic";
import { fmtElapsed } from "./format";
import type { RecorderHandle } from "./useRecorder";

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
}

/** Record another, without leaving the review. */
export function RecordBar({
  rec,
  deviceId,
  onDeviceChange,
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
        ● Record another
      </button>
      <DevicePicker devices={rec.devices} value={deviceId} onChange={onDeviceChange} />
    </div>
  );
}
