/* One station's pitch, set by hand: from ⋯ on the QSO page's station lines,
 * and from the Copy page's ⋯. Station pitch picks a pitch at random in its
 * range; this sets one station to the pitch you choose.
 */

import { useEffect, useRef, useState } from "react";
import { PITCH_MAX_HZ, PITCH_MIN_HZ, PITCH_STEP_HZ } from "@/qso/station";

export function StationPitchDialog({
  call,
  hz,
  note,
  onSet,
  onCancel,
}: {
  call: string;
  /** The pitch the station sends at now. */
  hz: number;
  /** What the pitch applies to, in a sentence. */
  note: string;
  onSet(hz: number): void;
  onCancel(): void;
}): React.ReactElement {
  const [value, setValue] = useState(hz);
  const slider = useRef<HTMLInputElement>(null);
  // Straight onto the slider: the arrow keys move it a step at a time.
  useEffect(() => slider.current?.focus(), []);
  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="dialog stationpitch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stationpitch-title"
        data-testid="station-pitch"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") onSet(value);
        }}
      >
        <h2 id="stationpitch-title">{call}'s pitch</h2>
        <p className="hint">{note}</p>
        <div className="group">
          <label htmlFor="station-pitch-hz">
            Pitch <output>{value} Hz</output>
          </label>
          <input
            ref={slider}
            type="range"
            id="station-pitch-hz"
            min={PITCH_MIN_HZ}
            max={PITCH_MAX_HZ}
            step={PITCH_STEP_HZ}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
          />
        </div>
        <div className="confirm">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" data-testid="station-pitch-set" onClick={() => onSet(value)}>
            Set
          </button>
        </div>
      </div>
    </div>
  );
}
