/* Saved calibrations, by name.
 *
 * The property worth testing is the one the design turns on: a device is not a
 * setup, so two profiles for the same microphone in different places must both
 * survive and both be pickable. Keying on the device id would have looked
 * correct in every test that only ever made one profile.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  activeProfile,
  calibrationOf,
  deleteProfile,
  loadProfiles,
  orderProfiles,
  profileForSource,
  profilesFor,
  saveProfile,
  selectProfile,
  suggestedName,
  type Profile,
} from "@/io/profiles";

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    nickname: "shack desk",
    deviceId: "webcam",
    deviceLabel: "HD Pro Webcam",
    wpm: 15,
    releaseOffsetSec: 0.013,
    spreadSec: 0.001,
    elements: 60,
    verdict: "good",
    decaySec: 0.03,
    maxWpm: 30,
    recordedAt: "2026-09-12T10:00:00+00:00",
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("keeping calibrations", () => {
  it("starts with none, and that is a real answer", () => {
    expect(loadProfiles()).toEqual([]);
    expect(activeProfile()).toBeNull();
  });

  it("keeps two positions of the same microphone", () => {
    /* The whole reason profiles are a list. One webcam, one room, two
       positions: 34 ms and 2.5 ms. Storing by device would have thrown the
       first away and then corrected every later recording by the wrong
       number. */
    saveProfile(profile({ id: "far", nickname: "across the room", releaseOffsetSec: 0.034 }));
    saveProfile(profile({ id: "near", nickname: "close to the rig", releaseOffsetSec: 0.0025 }));

    const kept = loadProfiles();
    expect(kept).toHaveLength(2);
    expect(kept.map((p) => p.nickname).sort()).toEqual([
      "across the room",
      "close to the rig",
    ]);
  });

  it("replaces a profile recalibrated under the same id", () => {
    saveProfile(profile({ releaseOffsetSec: 0.034 }));
    saveProfile(profile({ releaseOffsetSec: 0.013 }));
    expect(loadProfiles()).toHaveLength(1);
    expect(loadProfiles()[0]!.releaseOffsetSec).toBeCloseTo(0.013);
  });

  it("puts the current input's profiles first without hiding the others", () => {
    const mine = profile({ id: "a", deviceId: "webcam", recordedAt: "2026-01-01T00:00:00+00:00" });
    const other = profile({ id: "b", deviceId: "yeti", recordedAt: "2026-09-01T00:00:00+00:00" });
    const ordered = orderProfiles([other, mine], "webcam");
    expect(ordered.map((p) => p.id)).toEqual(["a", "b"]);
    // Newest first when there is nothing to match against.
    expect(orderProfiles([mine, other], undefined).map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("applies the one that was selected, and nothing when none was", () => {
    saveProfile(profile({ id: "near" }));
    expect(activeProfile()).toBeNull();

    selectProfile("near");
    expect(activeProfile()?.id).toBe("near");
    expect(calibrationOf(activeProfile()!).releaseOffsetSec).toBeCloseTo(0.013);

    selectProfile(undefined);
    expect(activeProfile()).toBeNull();
  });

  it("stops applying a profile that has been deleted", () => {
    // Otherwise the id outlives the profile and every later recording is
    // decoded against nothing while the app believes it is calibrated.
    saveProfile(profile({ id: "near" }));
    selectProfile("near");
    deleteProfile("near");
    expect(loadProfiles()).toEqual([]);
    expect(activeProfile()).toBeNull();
  });

  it("survives a corrupt store rather than taking the app down with it", () => {
    localStorage.setItem("cwt:profiles", "{not json");
    expect(loadProfiles()).toEqual([]);

    localStorage.setItem(
      "cwt:profiles",
      JSON.stringify([profile(), { nickname: "half-written" }, null]),
    );
    expect(loadProfiles()).toHaveLength(1);
  });

  it("applies to microphone takes and never to files", () => {
    /* A profile describes one microphone in one position. A file came from
       somewhere else — possibly from somebody else, possibly from a loopback
       with no room in it at all — and correcting it would alter numbers that
       were already measured. */
    const p = profile();
    expect(profileForSource(p, true)).toBe(p);
    expect(profileForSource(p, false)).toBeNull();
    expect(profileForSource(null, true)).toBeNull();
  });

  it("suggests a name when nobody supplies one", () => {
    expect(suggestedName("HD Pro Webcam", "2026-09-12T10:00:00+00:00")).toBe(
      "HD Pro Webcam, 2026-09-12",
    );
    expect(suggestedName(undefined, "2026-09-12T10:00:00+00:00")).toBe(
      "Calibration 2026-09-12",
    );
  });
});

describe("which calibrations may be applied to a recording", () => {
  /* `orderProfiles` sorts the likely ones up and keeps the rest, which is
     right where a calibration is being chosen — you may be about to switch
     inputs. It is wrong where one is being applied to a recording already
     made: a profile measured on another microphone describes another setup,
     and correcting by it is the exact mistake named profiles exist to
     prevent. */
  const webcam = profile({ id: "w1", deviceId: "webcam" });
  const yeti = profile({ id: "y1", deviceId: "yeti", nickname: "yeti" });
  const dflt = profile({ id: "d1", deviceId: undefined, nickname: "default in" });
  const all = [webcam, yeti, dflt];

  it("offers only the ones measured on that input", () => {
    expect(profilesFor(all, "webcam").map((p) => p.id)).toEqual(["w1"]);
    expect(profilesFor(all, "yeti").map((p) => p.id)).toEqual(["y1"]);
  });

  it("treats the default input as an input of its own", () => {
    // Not a wildcard: a profile made on whatever the default happened to be
    // describes that device, not every device.
    expect(profilesFor(all, undefined).map((p) => p.id)).toEqual(["d1"]);
  });

  it("keeps the one in use even when it does not belong", () => {
    /* It may not belong, but it is what is being applied. A picker that
       silently omits its own value shows a blank and tells the operator
       nothing about why. */
    expect(profilesFor(all, "webcam", "y1").map((p) => p.id).sort()).toEqual(["w1", "y1"]);
  });

  it("offers nothing when nothing was measured on that input", () => {
    expect(profilesFor(all, "someone-elses-mic")).toEqual([]);
  });
});
