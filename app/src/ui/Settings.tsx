/* The app's own tabs in Settings: You, Friends, Drills, and the saved
 * calibrations under Microphone. These are set once and then left alone.
 *
 * The calibration recordings are kept so a calibration that failed leaves
 * something to look at. Each one can be saved as a file or deleted here.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { IconDownload, IconHelp } from "./Icons";
import {
  SLOT_LABELS,
  customDrills,
  drillProblems,
  fillDrill,
  normalizeDrill,
  notesToSlots,
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
  EMPTY_USER,
  FRIEND_WPM,
  loadCustomDrills,
  loadFriends,
  loadUser,
  saveCustomDrills,
  saveFriends,
  saveUser,
  type CalibrationSummary,
  type CustomDrill,
  type Friend,
  type UserInfo,
} from "@/io/storage";
import type { KeyKind } from "@/timing/fist";
import { useUpperField } from "./useUpperField";
import { Check, SpeedSliders } from "./Controls";
import { fmtSpeed } from "./format";
import {
  SLOT_NAMES,
  SlotMenu,
  onPasteConverted,
  slotValue,
  useInsertAtCursor,
} from "./SlotMenu";
import { breakLines } from "@/morse";

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

/** A calibration's name, made safe to lead a filename with. */
export function fileSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** What a recording is saved as. Led by the name of the calibration it was
 *  saved as, when it was, so the file and the calibration match up. */
export function recordingFilename(
  r: { id: string; wpm: number },
  nickname: string | undefined,
): string {
  const lead = nickname ? fileSlug(nickname) : "";
  return `${lead ? `${lead}-` : ""}${r.id}-${r.wpm}wpm.wav`;
}
const day = (iso: string) => iso.slice(0, 10);

/** Who you are: the values a note such as "(your call)" fills in. Saved as
 *  each one changes. */
export function UserSettings(): React.ReactElement {
  const [user, setUser] = useState<UserInfo>(loadUser);
  const changeUser = useCallback((patch: Partial<UserInfo>) => {
    setUser((u) => {
      const next = { ...u, ...patch };
      saveUser(next);
      return next;
    });
  }, []);
  return (
    <div className="configpanel">
      <UserSection user={user} set={changeUser} />
    </div>
  );
}

/** Stations you know. Each calls now and then on the Copy and QSO pages. */
export function FriendSettings(): React.ReactElement {
  return (
    <div className="configpanel">
      <FriendSection />
    </div>
  );
}

/** Your own drills. */
export function DrillSettings(): React.ReactElement {
  const [user] = useState<UserInfo>(loadUser);
  return (
    <div className="configpanel">
      <DrillSection user={user} />
    </div>
  );
}

/** The saved calibrations and the recordings they were measured from. */
export function CalibrationSettings({
  profileId,
  onProfilesChanged,
}: {
  /** Which calibration is in use, so the one being deleted can be flagged. */
  profileId: string | undefined;
  /** The store changed — re-read it. */
  onProfilesChanged(): void;
}): React.ReactElement {
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
    <div className="configpanel">
      <section className="panelsec">
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
                    {p.id === profileId && " · in use"}
                  </span>
                  {p.deviceLabel && <span className="hint">{p.deviceLabel}</span>}
                </div>
                {confirming === p.id ? (
                  <span className="confirm">
                    {/* Deleting the one in use is allowed and clears the
                        selection — see deleteProfile. It is worth saying so
                        first, because every later recording then reads raw. */}
                    <span className="hint">
                      {p.id === profileId
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

      <section className="panelsec">
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
            {recordings.map((r) => {
              const named = profiles.find((p) => p.id === r.profileId)?.nickname;
              return (
                <li key={r.id} data-testid="recrow" data-id={r.id} data-reason={r.reason ?? ""}>
                  <div className="calmeta">
                    <strong>
                      {r.reason ? "No calibration" : named ? `Saved as “${named}”` : "Calibrated"}
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
                          if (blob) saveBlob(blob, recordingFilename(r, named));
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
              );
            })}
          </ul>
        )}
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
    <section className="panelsec">
      <h3>User</h3>
      <UserFields prefix="user" user={user} set={set} />
    </section>
  );
}

/** The details of a station: yours under You, and each friend's. Each id
 *  starts with `prefix`, as user-name. */
function UserFields({
  prefix,
  user,
  set,
}: {
  prefix: string;
  user: UserInfo;
  set(patch: Partial<UserInfo>): void;
}): React.ReactElement {
  return (
    <div className="userfields" data-testid={`${prefix}-fields`}>
      <UserField id={`${prefix}-name`} label="Name" value={user.name} onChange={(name) => set({ name })} />
      <UserField
        id={`${prefix}-callsign`}
        label="Callsign"
        value={user.callsign}
        onChange={(callsign) => set({ callsign })}
      />
      <UserField
        id={`${prefix}-age`}
        label="Age"
        value={user.age}
        digits={3}
        onChange={(age) => set({ age })}
      />
      <UserField
        id={`${prefix}-licensed`}
        label="Year licensed"
        value={user.yearLicensed}
        digits={4}
        onChange={(yearLicensed) => set({ yearLicensed })}
      />
      <UserField
        id={`${prefix}-cwops`}
        label="CWops number"
        value={user.cwopsNumber}
        digits={5}
        onChange={(cwopsNumber) => set({ cwopsNumber })}
      />
      <fieldset className="usergroup">
        <legend>QTH</legend>
        <UserField
          id={`${prefix}-qth-city`}
          label="City"
          value={user.qthCity}
          onChange={(qthCity) => set({ qthCity })}
        />
        <UserField
          id={`${prefix}-qth-short`}
          label="Region, short"
          value={user.qthRegionShort}
          onChange={(qthRegionShort) => set({ qthRegionShort })}
        />
        <UserField
          id={`${prefix}-qth-long`}
          label="Region, long"
          value={user.qthRegionLong}
          onChange={(qthRegionLong) => set({ qthRegionLong })}
        />
      </fieldset>
      <fieldset className="usergroup">
        <legend>Rig</legend>
        <UserField
          id={`${prefix}-rig-manufacturer`}
          label="Manufacturer"
          value={user.rigManufacturer}
          onChange={(rigManufacturer) => set({ rigManufacturer })}
        />
        <UserField
          id={`${prefix}-rig-model`}
          label="Model"
          value={user.rigModel}
          onChange={(rigModel) => set({ rigModel })}
        />
        <UserField
          id={`${prefix}-rig-power`}
          label="Power (W)"
          value={user.rigPower}
          digits={4}
          onChange={(rigPower) => set({ rigPower })}
        />
      </fieldset>
      <UserField
        id={`${prefix}-antenna`}
        label="Antenna"
        value={user.antenna}
        onChange={(antenna) => set({ antenna })}
      />
    </div>
  );
}

const friendId = () => `friend/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A friend before anything is typed. */
const NEW_FRIEND: Omit<Friend, "id"> = { ...EMPTY_USER, wpm: FRIEND_WPM, farnsworthWpm: FRIEND_WPM, keys: ["keyer"] };

/** The keys a friend may send with, each with how it sounds. A friend with
 *  more than one picks one each time they call. */
const KEYS: ReadonlyArray<{ key: KeyKind; label: string; help: string }> = [
  { key: "keyer", label: "Keyer", help: "Every dit and dah exact." },
  { key: "bug", label: "Bug", help: "Even dits, and long dahs made by hand that vary." },
];

/** The keys `keys` holds, by name, in the form's order: Keyer or bug. */
function keysText(keys: readonly KeyKind[]): string {
  const labels = KEYS.filter((k) => keys.includes(k.key)).map((k, i) => (i ? k.label.toLowerCase() : k.label));
  return labels.join(" or ");
}

/** A friend's details after their call and name, on one line. */
export function friendSummary(f: Omit<Friend, "id">): string {
  const qth = [f.qthCity, f.qthRegionShort].filter(Boolean).join(" ");
  const rig = [[f.rigManufacturer, f.rigModel].filter(Boolean).join(" "), f.rigPower && `${f.rigPower} W`]
    .filter(Boolean)
    .join(", ");
  return [
    qth,
    fmtSpeed({ charWpm: f.wpm, farnsworthWpm: f.farnsworthWpm }),
    keysText(f.keys),
    f.cwopsNumber && `CWops ${f.cwopsNumber}`,
    rig,
    f.antenna,
    f.yearLicensed && `Licensed ${f.yearLicensed}`,
    f.age && `Age ${f.age}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Your friends: one line each, and the form of You to add or edit one.
 *  Add friend sits at the top, so a new friend's form is always in the same
 *  place. */
function FriendSection(): React.ReactElement {
  const [friends, setFriends] = useState<Friend[]>(loadFriends);
  /** The friend the form holds: an id, "new", or null with no form open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Omit<Friend, "id">>(NEW_FRIEND);
  // A station needs a call and a name to call you.
  // A friend sends with at least one key.
  const problems = draft.keys.length === 0 ? ["Pick at least one key."] : [];
  const canSave = draft.callsign.trim() !== "" && draft.name.trim() !== "" && problems.length === 0;
  // The form opens at Name, ready to type.
  useEffect(() => {
    if (editing !== null) document.getElementById("friend-name")?.focus();
  }, [editing]);

  const store = (next: Friend[]) => {
    saveFriends(next);
    setFriends(next);
  };
  const close = () => {
    setEditing(null);
    setDraft(NEW_FRIEND);
  };
  // An edit keeps the friend's id and their place in the list.
  const save = () => {
    if (!canSave) return;
    store(
      editing === "new"
        ? [...friends, { ...draft, id: friendId() }]
        : friends.map((f) => (f.id === editing ? { ...draft, id: f.id } : f)),
    );
    close();
  };
  const remove = (id: string) => store(friends.filter((f) => f.id !== id));
  const change = (patch: Partial<Omit<Friend, "id">>) => setDraft((d) => ({ ...d, ...patch }));

  const form = (
    <li className="friendrow" data-editing="true">
      {/* A form, so Enter in any field saves. */}
      <form
        className="friendform"
        data-testid="friend-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <UserFields prefix="friend" user={draft} set={change} />
        <fieldset className="usergroup">
          <legend>Typical speed</legend>
          <SpeedSliders
            idPrefix="friend-"
            charWpm={draft.wpm}
            farnsworthWpm={draft.farnsworthWpm}
            onChange={(patch) => {
              // Overall is never faster than character speed, as for yours.
              const wpm = patch.charWpm ?? draft.wpm;
              change({ wpm, farnsworthWpm: Math.min(patch.farnsworthWpm ?? draft.farnsworthWpm, wpm) });
            }}
          />
        </fieldset>
        <fieldset className="usergroup friendkeys" data-testid="friend-keys">
          <legend>Keys</legend>
          {KEYS.map((k) => (
            <Check
              key={k.key}
              id={`friend-key-${k.key}`}
              label={k.label}
              help={k.help}
              checked={draft.keys.includes(k.key)}
              onChange={(on) =>
                change({ keys: KEYS.map((o) => o.key).filter((o) => (o === k.key ? on : draft.keys.includes(o))) })
              }
            />
          ))}
        </fieldset>
        {problems.length > 0 && (
          <ul className="drillproblems" data-testid="friend-problems" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="drillsave">
          <button type="submit" data-testid="save-friend" disabled={!canSave}>
            {editing === "new" ? "Save friend" : "Save changes"}
          </button>
          <button type="button" data-testid="cancel-friend" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );

  return (
    <section className="panelsec">
      <h3>Friends</h3>
      <p className="lede">
        Stations you know. Now and then one of them calls on the Copy and QSO pages, at most once a session.
      </p>
      <div className="friendsadd">
        <button
          data-testid="add-friend"
          disabled={editing !== null}
          onClick={() => {
            setDraft(NEW_FRIEND);
            setEditing("new");
          }}
        >
          Add friend
        </button>
      </div>
      {editing === "new" && <ul className="callist">{form}</ul>}
      {friends.length === 0 ? (
        editing === null && <p className="lede">No friends yet.</p>
      ) : (
        <ul className="callist" data-testid="friendlist">
          {friends.map((f) =>
            f.id === editing ? (
              <Fragment key={f.id}>{form}</Fragment>
            ) : (
              <li key={f.id} className="friendrow" data-testid="friendrow" data-id={f.id} data-editing="false">
                <div className="calmeta">
                  <span>
                    <span className="friendcall">{f.callsign}</span> {f.name}
                  </span>
                  {friendSummary(f) && <span className="hint">{friendSummary(f)}</span>}
                </div>
                <div className="drillrowactions">
                  <button
                    data-testid="edit-friend"
                    disabled={editing !== null}
                    onClick={() => {
                      const { id: _, ...details } = f;
                      setDraft(details);
                      setEditing(f.id);
                    }}
                  >
                    Edit
                  </button>
                  <button data-testid="delete-friend" onClick={() => remove(f.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

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
  /** The saved drill the box holds, or null when it holds a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const field = useUpperField<HTMLTextAreaElement>((v) => setText(lowerSlots(v)));
  const insertText = useInsertAtCursor(field.ref, text, setText);

  const drill = normalizeDrill(text);
  const problems = drillProblems(drill);
  const canSave = drill !== "" && problems.length === 0;

  const store = (next: CustomDrill[]) => {
    saveCustomDrills(next);
    setSaved(next);
  };

  // An edit keeps the drill's id and its place in the list.
  const save = () => {
    if (!canSave) return;
    store(
      editing
        ? saved.map((d) => (d.id === editing ? { ...d, text: drill } : d))
        : [...saved, { id: drillId(), text: drill }],
    );
    setEditing(null);
    setText("");
  };

  const edit = (d: CustomDrill) => {
    setEditing(d.id);
    setText(breakLines(d.text));
    field.ref.current?.focus();
  };

  const cancel = () => {
    setEditing(null);
    setText("");
  };

  const remove = (id: string) => {
    if (id === editing) cancel();
    store(saved.filter((x) => x.id !== id));
  };

  const insert = (slot: Slot) => insertText(`{${slot}}`);
  // A pasted note such as "(your call)" goes in as its slot.
  const paste = onPasteConverted(notesToSlots, (t) => insertText(lowerSlots(t)));

  return (
    <section className="panelsec drillsettings">
      <h3>Drills</h3>
      <p className="lede">
        Your own drills. They show in the drill picker under Custom.
      </p>

      <div className="fieldrow">
        <label htmlFor="custom-drill">{editing ? "Edit drill" : "New drill"}</label>
        <div className="drilltools">
          <SlotMenu onPick={insert} />
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
      </div>

      <textarea
        id="custom-drill"
        className="drilltext"
        data-testid="custom-drill-text"
        ref={field.ref}
        rows={3}
        spellCheck={false}
        value={text}
        placeholder={"CQ CQ DE {callsign} K\n{callsign} DE K7ABC K"}
        onChange={field.onChange}
        onPaste={paste}
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
          {editing ? "Save changes" : "Save drill"}
        </button>
        {editing && (
          <button data-testid="cancel-edit" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>

      {help && (
        <div id="drill-help" className="drillhelp" data-testid="drill-help">
          <p>
            Type anything that has Morse: letters, numbers, punctuation, and
            prosigns in angle brackets, such as <code>&lt;BT&gt;</code> or{" "}
            <code>&lt;SK&gt;</code>.
          </p>
          <p>
            A new line is a long break. Use it to write both sides of a QSO.
            The target waits at each break for the Rest at each break set in the
            settings, and a break is never graded. In the message box a break shows
            as <code>|</code>.
          </p>
          <p>
            A slot in braces takes a value from User when you pick the drill.
            Click a slot to add it at the cursor. A drill with an empty slot
            cannot be picked until you set that value.
          </p>
          <p>
            Paste a QSO with notes such as <code>(your call)</code> or{" "}
            <code>(your QTH)</code>, and each note goes in as its slot.
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
                const value = slotValue(slot, user);
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
              <li
                key={d.id}
                data-testid="drillrow"
                data-id={d.id}
                data-editing={d.id === editing}
              >
                <div className="calmeta">
                  <code className="drillrowtext">{breakLines(d.text)}</code>
                  {missing.length > 0 && (
                    <span className="hint">
                      Needs {missing.map((s) => SLOT_LABELS[s]).join(", ")}.
                    </span>
                  )}
                </div>
                <div className="drillrowactions">
                  <button data-testid="edit-drill" onClick={() => edit(d)}>
                    Edit
                  </button>
                  <button data-testid="delete-drill" onClick={() => remove(d.id)}>
                    Delete
                  </button>
                </div>
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
