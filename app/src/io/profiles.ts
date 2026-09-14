/* Saved calibrations, by name.
 *
 * A device id is not the identity of a setup, and the corpus says so plainly:
 * one webcam, one room, one afternoon, three positions — 34 ms, 13 ms and
 * 2.5 ms of room. Storing one profile per device would silently overwrite a
 * good calibration the moment somebody slid the microphone across the desk,
 * and then apply the wrong correction to everything afterwards.
 *
 * So profiles are a list and each one carries a name its owner chose — "shack
 * desk", "kitchen table", "close to the rig". The device id is kept as a
 * *hint*, used to put the likely ones at the top of the list, and never as the
 * key. Moving a microphone invalidates a profile; giving it a name is what
 * lets somebody keep both and pick.
 *
 * Small enough for localStorage, and deliberately kept there rather than in
 * IndexedDB with the takes: a profile has to be readable synchronously at boot
 * because the very next thing that happens is a recording being decoded
 * against it.
 */

import type { Calibration, SetupVerdict } from "@/dsp";
import { loadPrefs, savePrefs } from "./storage";

const KEY = "cwt:profiles";

/** How many to keep. Past this somebody has a naming problem, not a
 *  calibration problem, and an unbounded list in localStorage is a slow leak. */
const MAX_PROFILES = 32;

export interface Profile {
  readonly id: string;
  /** What its owner calls it. Never generated from the device alone — see the
   *  note at the top about why a device is not a setup. */
  readonly nickname: string;
  /** A hint for ordering, not a key. Undefined when the default input was
   *  used, which is the common case and tells us nothing. */
  readonly deviceId?: string | undefined;
  /** What the browser called that device when the profile was made, so a list
   *  entry still means something after the ids have been rotated. */
  readonly deviceLabel?: string | undefined;
  /** Speed the drills were keyed at. */
  readonly wpm: number;
  /** The correction actually applied. Usually the measured one, but it can be
   *  adjusted by hand — see `measuredOffsetSec`. */
  readonly releaseOffsetSec: number;
  /** What the drills measured, kept even when the offset above has been
   *  changed by hand.
   *
   * Two reasons, and neither is bookkeeping. It is what "reset" resets to. And
   * a number somebody dragged is a different kind of fact from a number the
   * drills produced, so a report that leans on this profile has to be able to
   * say which it was. Absent on profiles saved before adjusting was possible,
   * which is the same as "never adjusted". */
  readonly measuredOffsetSec?: number;
  readonly spreadSec: number;
  readonly elements: number;
  /** What the room measured, kept so the picker can show it — "13 ms, good"
   *  and "34 ms, refused" are the difference between a working session and a
   *  misleading one, and a name alone does not distinguish them. */
  readonly verdict: SetupVerdict;
  readonly decaySec: number;
  readonly maxWpm: number;
  /** ISO 8601, seconds precision. */
  readonly recordedAt: string;
}

/** Whether the correction in use is the one that was measured.
 *
 * A profile with no `measuredOffsetSec` was saved before adjusting existed and
 * has therefore never been adjusted. */
export function isAdjusted(p: Profile): boolean {
  return p.measuredOffsetSec !== undefined && p.measuredOffsetSec !== p.releaseOffsetSec;
}

/** The part of a profile the decoder actually uses. */
export function calibrationOf(p: Profile): Calibration {
  return {
    wpm: p.wpm,
    releaseOffsetSec: p.releaseOffsetSec,
    spreadSec: p.spreadSec,
    elements: p.elements,
  };
}

function isProfile(v: unknown): v is Profile {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<Profile>;
  return (
    typeof p.id === "string" &&
    typeof p.nickname === "string" &&
    typeof p.wpm === "number" &&
    typeof p.releaseOffsetSec === "number"
  );
}

export function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything that is not a profile is dropped rather than thrown over:
    // a half-written list should cost the entries it corrupted, not the app.
    return Array.isArray(parsed) ? parsed.filter(isProfile) : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles: readonly Profile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles.slice(0, MAX_PROFILES)));
  } catch {
    /* private mode, quota, or storage disabled — all survivable */
  }
}

/** Add a profile, or replace the one with the same id.
 *
 * Newest first, because the one just made is overwhelmingly the one about to
 * be used. */
export function saveProfile(profile: Profile): Profile[] {
  const next = [profile, ...loadProfiles().filter((p) => p.id !== profile.id)];
  writeProfiles(next);
  return next.slice(0, MAX_PROFILES);
}

export function deleteProfile(id: string): Profile[] {
  const next = loadProfiles().filter((p) => p.id !== id);
  writeProfiles(next);
  if (loadPrefs().profileId === id) selectProfile(undefined);
  return next;
}

/** Profiles for the input now selected first, then the rest, newest first.
 *
 * The device is a hint and only a hint. Somebody with one microphone and three
 * positions has three profiles that all match it, and the list has to show all
 * three; somebody who has just switched inputs wants the matching ones at the
 * top without the others disappearing. */
export function orderProfiles(
  profiles: readonly Profile[],
  deviceId: string | undefined,
): Profile[] {
  const byDate = [...profiles].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  if (!deviceId) return byDate;
  return [
    ...byDate.filter((p) => p.deviceId === deviceId),
    ...byDate.filter((p) => p.deviceId !== deviceId),
  ];
}

/** Only the profiles that belong to this input.
 *
 * `orderProfiles` sorts the likely ones to the top and keeps the rest, which
 * is right where a calibration is being *chosen* — you may be about to switch
 * inputs, and a list that hides everything else looks broken. It is wrong
 * where a calibration is being *applied* to a recording already made: a
 * profile measured on another microphone describes another setup, and
 * correcting by it is the exact mistake named profiles exist to prevent.
 *
 * `undefined` is a real device id here and means the default input, so it
 * matches only other profiles made on the default input.
 *
 * The one in use is always kept, even when it does not match. It may not
 * belong, but it is what is being applied, and a picker that silently omits
 * its own value shows a blank and tells the operator nothing. */
export function profilesFor(
  profiles: readonly Profile[],
  deviceId: string | undefined,
  keep?: string | undefined,
): Profile[] {
  return orderProfiles(profiles, deviceId).filter(
    (p) => p.deviceId === deviceId || p.id === keep,
  );
}

/* ---- which one is in use ------------------------------------------------- */

/** The profile the decoder is applying, or null for none.
 *
 * Null is a real answer and the default one: until somebody calibrates, every
 * recording is read exactly as it was before any of this existed. */
export function activeProfile(): Profile | null {
  const id = loadPrefs().profileId;
  if (!id) return null;
  return loadProfiles().find((p) => p.id === id) ?? null;
}

export function selectProfile(id: string | undefined): void {
  const next = { ...loadPrefs() };
  if (id) next.profileId = id;
  else delete next.profileId;
  savePrefs(next);
}

/** Which profile, if any, applies to audio from this source.
 *
 * A profile describes one microphone in one position in one room. A recording
 * made through that setup should be corrected by it. A file should not: it came
 * from somewhere else — possibly from somebody else, possibly from a loopback
 * with no room in the path at all — and applying this machine's calibration to
 * it would quietly alter numbers that were already measured.
 *
 * Its own function rather than a conditional at the call site because it is a
 * decision about what the tool is allowed to change, and those are worth
 * naming and worth testing. */
export function profileForSource(
  profile: Profile | null,
  fromMic: boolean,
): Profile | null {
  return fromMic ? profile : null;
}

/* ---- naming -------------------------------------------------------------- */

/** A name to suggest when somebody does not supply one.
 *
 * The device label plus a date. Not a substitute for a real name — the point
 * of a name is to tell two positions of the same microphone apart, and this
 * cannot — but better than an empty string in a list. */
export function suggestedName(deviceLabel: string | undefined, when: string): string {
  const day = when.slice(0, 10);
  const label = (deviceLabel ?? "").trim();
  return label ? `${label}, ${day}` : `Calibration ${day}`;
}
