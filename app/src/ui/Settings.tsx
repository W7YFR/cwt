/* Configuration: the things that are set once and then left alone.
 *
 * Everything the app does to a recording is decided on the screen you are
 * recording from, and that is right — whether a calibration is applied changes
 * every number the review reports, so it belongs beside the button that makes
 * the recording. What does not belong there is housekeeping: deleting a
 * calibration you will never use again, and getting hold of the audio one was
 * measured from.
 *
 * The recordings are the reason this screen exists now rather than later. A
 * calibration that refuses in a room nobody here has ever stood in leaves
 * nothing behind to look at unless the audio is kept, and audio that is kept
 * and cannot be got at again might as well not be.
 */

import { useCallback, useEffect, useState } from "react";
import {
  deleteProfile,
  isAdjusted,
  loadProfiles,
  type Profile,
} from "@/io/profiles";
import {
  KEEP_CALIBRATIONS,
  forgetCalibration,
  forgetCalibrationsFor,
  getCalibrationAudio,
  listCalibrations,
  type CalibrationSummary,
} from "@/io/storage";

export interface SettingsProps {
  /** Which calibration is in use, so the one being deleted can be flagged. */
  profileId: string | undefined;
  /** The store changed — re-read it. */
  onProfilesChanged(): void;
  onClose(): void;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const ms = (v: number) => `${(v * 1000).toFixed(1)} ms`;
const day = (iso: string) => iso.slice(0, 10);

export function Settings(props: SettingsProps): React.ReactElement {
  const { onProfilesChanged } = props;
  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles());
  const [recordings, setRecordings] = useState<CalibrationSummary[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listCalibrations().then(setRecordings);
  }, []);
  useEffect(refresh, [refresh]);

  const remove = useCallback(
    (id: string) => {
      setProfiles(deleteProfile(id));
      setConfirming(null);
      // The recording it was measured from goes with it. Keeping audio for a
      // calibration nobody can select again is a few megabytes of nothing.
      void forgetCalibrationsFor(id).then(refresh);
      onProfilesChanged();
    },
    [onProfilesChanged, refresh],
  );

  return (
    <div className="settings">
      <header className="setshead">
        <h2>Configuration</h2>
        <button onClick={props.onClose}>Done</button>
      </header>

      <section>
        <h3>Saved calibrations</h3>
        {profiles.length === 0 ? (
          <p className="lede">None yet. Calibrating from the record screen makes one.</p>
        ) : (
          <ul className="callist" data-testid="callist">
            {profiles.map((p) => (
              <li key={p.id} data-testid="calrow" data-id={p.id}>
                <div className="calmeta">
                  <strong>{p.nickname}</strong>
                  <span className="hint">
                    {ms(p.releaseOffsetSec)} · {p.verdict} · {p.wpm} wpm ·{" "}
                    {day(p.recordedAt)}
                    {isAdjusted(p) && " · adjusted by hand"}
                    {p.id === props.profileId && " · in use"}
                  </span>
                  {p.deviceLabel && <span className="hint">{p.deviceLabel}</span>}
                </div>
                {confirming === p.id ? (
                  <span className="confirm">
                    {/* Deleting the one in use is allowed and clears the
                        selection — see deleteProfile. It is worth saying so
                        first, because every later recording then reads raw. */}
                    <span className="hint">
                      {p.id === props.profileId
                        ? "This one is in use. Deleting it leaves recordings uncorrected."
                        : "Delete it?"}
                    </span>
                    <button className="danger" onClick={() => remove(p.id)}>
                      Delete
                    </button>
                    <button onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : (
                  <button
                    data-testid="delete-profile"
                    onClick={() => setConfirming(p.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Calibration recordings</h3>
        <p className="lede">
          The last {KEEP_CALIBRATIONS} attempts, whether or not they produced a
          calibration. The ones that did not are the useful ones to keep: they
          are what shows why.
        </p>
        {recordings.length === 0 ? (
          <p className="lede">Nothing recorded yet.</p>
        ) : (
          <ul className="callist" data-testid="reclist">
            {recordings.map((r) => (
              <li key={r.id} data-testid="recrow" data-id={r.id} data-reason={r.reason ?? ""}>
                <div className="calmeta">
                  <strong>
                    {r.reason ? "No calibration" : "Calibrated"}
                    {r.offsetSec !== null && ` — ${ms(r.offsetSec)}`}
                  </strong>
                  <span className="hint">
                    {day(r.recordedAt)} · {r.wpm} wpm · {r.durationSec.toFixed(0)}s
                    {r.reason && ` · ${r.reason}`}
                    {r.deviceLabel && ` · ${r.deviceLabel}`}
                  </span>
                </div>
                <span className="rowbuttons">
                  <button
                    data-testid="save-recording"
                    onClick={() => {
                      void getCalibrationAudio(r.id).then((blob) => {
                        if (blob) saveBlob(blob, `${r.id}-${r.wpm}wpm.wav`);
                      });
                    }}
                  >
                    ↓ Save
                  </button>
                  <button
                    data-testid="delete-recording"
                    onClick={() => void forgetCalibration(r.id).then(refresh)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
