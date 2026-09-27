/* Configuration: the things that are set once and then left alone — who you
 * are, and the calibrations.
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconDownload, IconHelp } from "./Icons";
import {
  SLOTS,
  SLOT_LABELS,
  customDrills,
  drillProblems,
  fillDrill,
  normalizeDrill,
  type Slot,
} from "@/drills";
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
  loadCustomDrills,
  loadUser,
  saveCustomDrills,
  saveUser,
  type CalibrationSummary,
  type CustomDrill,
  type UserInfo,
} from "@/io/storage";
import { useUpperField } from "./useUpperField";

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
  const [user, setUser] = useState<UserInfo>(loadUser);
  const changeUser = useCallback((patch: Partial<UserInfo>) => {
    setUser((u) => {
      const next = { ...u, ...patch };
      saveUser(next);
      return next;
    });
  }, []);

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

      <UserSection user={user} set={changeUser} />

      <DrillSection user={user} />

      <section className="calsection">
        <h3>Calibration</h3>
        <section>
          <h4>Saved calibrations</h4>
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
          <h4>Calibration recordings</h4>
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
                      <IconDownload /> Save
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
      </section>
    </div>
  );
}

/** Upper case, like everything else that gets keyed. Saved on every change,
 *  so Done has nothing left to do. */
function UserSection({
  user,
  set,
}: {
  user: UserInfo;
  set(patch: Partial<UserInfo>): void;
}): React.ReactElement {
  return (
    <section>
      <h3>User</h3>
      <div className="userfields" data-testid="user-fields">
        <UserField id="user-name" label="Name" value={user.name} onChange={(name) => set({ name })} />
        <UserField
          id="user-callsign"
          label="Callsign"
          value={user.callsign}
          onChange={(callsign) => set({ callsign })}
        />
        <UserField
          id="user-age"
          label="Age"
          value={user.age}
          digits={3}
          onChange={(age) => set({ age })}
        />
        <UserField
          id="user-licensed"
          label="Year licensed"
          value={user.yearLicensed}
          digits={4}
          onChange={(yearLicensed) => set({ yearLicensed })}
        />
        <fieldset className="usergroup">
          <legend>QTH</legend>
          <UserField
            id="user-qth-city"
            label="City"
            value={user.qthCity}
            onChange={(qthCity) => set({ qthCity })}
          />
          <UserField
            id="user-qth-short"
            label="Region, short"
            value={user.qthRegionShort}
            onChange={(qthRegionShort) => set({ qthRegionShort })}
          />
          <UserField
            id="user-qth-long"
            label="Region, long"
            value={user.qthRegionLong}
            onChange={(qthRegionLong) => set({ qthRegionLong })}
          />
        </fieldset>
        <fieldset className="usergroup">
          <legend>Rig</legend>
          <UserField
            id="user-rig-manufacturer"
            label="Manufacturer"
            value={user.rigManufacturer}
            onChange={(rigManufacturer) => set({ rigManufacturer })}
          />
          <UserField
            id="user-rig-model"
            label="Model"
            value={user.rigModel}
            onChange={(rigModel) => set({ rigModel })}
          />
          <UserField
            id="user-rig-power"
            label="Power (W)"
            value={user.rigPower}
            digits={4}
            onChange={(rigPower) => set({ rigPower })}
          />
        </fieldset>
        <UserField
          id="user-antenna"
          label="Antenna"
          value={user.antenna}
          onChange={(antenna) => set({ antenna })}
        />
      </div>
    </section>
  );
}

const SLOT_NAMES = Object.keys(SLOTS) as Slot[];

const drillId = () =>
  `custom/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Slot names stay lower case as they are typed, the way they are saved. The
 *  length does not change, so the caret stays in place. */
const lowerSlots = (v: string) => v.replace(/\{[^}\s]*\}?/g, (m) => m.toLowerCase());

/** Drills the user writes. The drill picker shows them under
 *  Custom, filled from the user details like the catalog's own. */
function DrillSection({ user }: { user: UserInfo }): React.ReactElement {
  const [saved, setSaved] = useState<CustomDrill[]>(loadCustomDrills);
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const field = useUpperField<HTMLTextAreaElement>((v) => setText(lowerSlots(v)));
  const caretAfterInsert = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = field.ref.current;
    const at = caretAfterInsert.current;
    caretAfterInsert.current = null;
    if (el && at !== null) {
      el.focus();
      el.setSelectionRange(at, at);
    }
  });

  const drill = normalizeDrill(text);
  const problems = drillProblems(drill);
  const canSave = drill !== "" && problems.length === 0;

  const store = (next: CustomDrill[]) => {
    saveCustomDrills(next);
    setSaved(next);
  };

  const save = () => {
    if (!canSave) return;
    store([...saved, { id: drillId(), text: drill }]);
    setText("");
  };

  const insert = (slot: Slot) => {
    const el = field.ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const token = `{${slot}}`;
    setText(text.slice(0, start) + token + text.slice(end));
    caretAfterInsert.current = start + token.length;
  };

  return (
    <section className="drillsettings">
      <h3>Drills</h3>
      <p className="lede">
        Your own drills. They show in the drill picker under Custom.
      </p>

      <div className="fieldrow">
        <label htmlFor="custom-drill">New drill</label>
        <button
          type="button"
          className="iconbtn helpbtn"
          data-testid="drill-help-toggle"
          aria-label="How to write a drill"
          aria-expanded={help}
          aria-controls="drill-help"
          title="How to write a drill"
          onClick={() => setHelp((h) => !h)}
        >
          <IconHelp />
        </button>
      </div>

      <textarea
        id="custom-drill"
        className="drilltext"
        data-testid="custom-drill-text"
        ref={field.ref}
        rows={3}
        spellCheck={false}
        value={text}
        placeholder="CQ CQ DE {callsign} K"
        onChange={field.onChange}
      />
      {problems.length > 0 && (
        <ul className="drillproblems" data-testid="drill-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="drillsave">
        <button data-testid="save-drill" disabled={!canSave} onClick={save}>
          Save drill
        </button>
      </div>

      {help && (
        <div id="drill-help" className="drillhelp" data-testid="drill-help">
          <p>
            Type anything that has Morse: letters, numbers, punctuation, and
            prosigns in angle brackets, such as <code>&lt;BT&gt;</code> or{" "}
            <code>&lt;SK&gt;</code>.
          </p>
          <p>
            A slot in braces takes a value from User when you pick the drill.
            Click a slot to add it at the cursor. A drill with an empty slot
            cannot be picked until you set that value.
          </p>
          <table className="slottable">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {SLOT_NAMES.map((slot) => {
                const value = user[SLOTS[slot]].trim();
                return (
                  <tr key={slot}>
                    <td>
                      <button
                        type="button"
                        className="slotbtn"
                        data-testid={`insert-slot-${slot}`}
                        onClick={() => insert(slot)}
                      >
                        {`{${slot}}`}
                      </button>
                    </td>
                    <td>{SLOT_LABELS[slot]}</td>
                    <td className={value ? "slotvalue" : "slotvalue unset"}>
                      {value || "not set"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            Example: <code>CQ CQ DE {"{callsign}"} K</code> keys as{" "}
            <code>{fillDrill({ id: "", path: ["", ""], text: "CQ CQ DE {callsign} K" }, user).text}</code>.
          </p>
        </div>
      )}

      {saved.length === 0 ? (
        <p className="lede">No custom drills yet.</p>
      ) : (
        <ul className="callist" data-testid="drilllist">
          {customDrills(saved).map((d) => {
            const missing = fillDrill(d, user).missing ?? [];
            return (
              <li key={d.id} data-testid="drillrow" data-id={d.id}>
                <div className="calmeta">
                  <code className="drillrowtext">{d.text}</code>
                  {missing.length > 0 && (
                    <span className="hint">
                      Needs {missing.map((s) => SLOT_LABELS[s]).join(", ")}.
                    </span>
                  )}
                </div>
                <button
                  data-testid="delete-drill"
                  onClick={() => store(saved.filter((x) => x.id !== d.id))}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function UserField(props: {
  id: string;
  label: string;
  value: string;
  /** Digits only, at most this many. */
  digits?: number;
  onChange(v: string): void;
}): React.ReactElement {
  const { digits, onChange } = props;
  const field = useUpperField(digits ? (v) => onChange(v.replace(/\D/g, "")) : onChange);
  return (
    <div className="userfield">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="text"
        ref={field.ref}
        value={props.value}
        onChange={field.onChange}
        inputMode={digits ? "numeric" : undefined}
        maxLength={digits}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
