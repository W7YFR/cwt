/* One station's pitch, set by hand: from ⋯ on the QSO page's station lines,
 * and from the Copy page's ⋯. Station pitch picks a pitch at random in its
 * range; this sets one station to the pitch you choose.
 */

import { useEffect, useRef, useState } from "react";
import { sendScript } from "@/copy/generate";
import type { Fist } from "@/timing/fist";
import type { Speed } from "@/qso/speed";
import { PITCH_MAX_HZ, PITCH_MIN_HZ, PITCH_STEP_HZ } from "@/qso/station";
import { IconPlay, IconStop } from "./Icons";
import { useLoop } from "./usePreview";

export function StationPitchDialog({
  call,
  hz,
  note,
  station,
  gainDb,
  onPreview,
  onSet,
  onCancel,
}: {
  call: string;
  /** The pitch the station sends at now. */
  hz: number;
  /** What the pitch applies to, in a sentence. */
  note: string;
  /** What Preview sends a CQ as: the station's call, speed and fist. */
  station: { call: string; speed: Speed; fist?: Fist | undefined };
  gainDb: number;
  /** Stops what the page plays: the two never play at once. */
  onPreview(): void;
  onSet(hz: number): void;
  onCancel(): void;
}): React.ReactElement {
  const [value, setValue] = useState(hz);
  const [preview, setPreview] = useState(false);
  // As the dialog opened: a call made up for a station with none stays the same.
  const [sender] = useState(station);
  // The station's CQ at the pitch on the slider, again and again.
  const loop = useLoop(
    preview
      ? () =>
          sendScript(
            {
              kind: "text",
              stations: [{ call: sender.call, speed: sender.speed, toneHz: value, ...(sender.fist ? { fist: sender.fist } : {}) }],
              lines: [{ station: 0, text: `CQ CQ DE ${sender.call} ${sender.call} K` }],
            },
            // One line: the quiet at each end of the clip parts one CQ from the next.
            { gapSec: 0 },
          )
      : null,
    String(value),
    gainDb,
  );
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
        <div className="previewrow">
          <button
            type="button"
            data-testid="station-pitch-preview"
            aria-pressed={preview}
            onClick={() => {
              // From the click itself: a browser starts audio only from one.
              if (!preview) {
                onPreview();
                loop.wake();
              }
              setPreview(!preview);
            }}
          >
            <i className="ico">{preview ? <IconStop /> : <IconPlay />}</i>
            Preview
          </button>
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
