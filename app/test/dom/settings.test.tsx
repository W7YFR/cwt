/* The app's tabs in Settings: You, Friends, Drills, and the saved calibrations under
 * Microphone. Deleting calibrations, and getting the audio back.
 *
 * `deleteProfile` has existed and been tested since profiles did, and nothing
 * called it — a list you can add to and not remove from. What is new here is
 * the screen, and the two rules it has to get right: deleting a profile takes
 * the recording it was measured from with it, and deleting the one in use
 * clears the selection rather than leaving an id pointing at nothing.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CalibrationSettings, DrillSettings, FriendSettings, UserSettings } from "@/ui/Settings";
import { loadProfiles, saveProfile, selectProfile, activeProfile } from "@/io/profiles";
import {
  EMPTY_USER,
  FRIEND_WPM,
  loadCustomDrills,
  loadFriends,
  loadPrefs,
  loadUser,
  saveCustomDrills,
  saveFriends,
  savePrefs,
  saveUser,
} from "@/io/storage";
import type { Profile } from "@/io/profiles";

const PROFILE = (over: Partial<Profile> = {}): Profile => ({
  id: "p1",
  nickname: "shack desk",
  deviceId: "webcam",
  deviceLabel: "HD Pro Webcam",
  wpm: 15,
  releaseOffsetSec: 0.013,
  measuredOffsetSec: 0.013,
  spreadSec: 0.0004,
  elements: 120,
  verdict: "good",
  decaySec: 0.03,
  maxWpm: 30,
  recordedAt: "2026-09-01T10:00:00+00:00",
  ...over,
});

/** The You tab. */
function open() {
  return render(<UserSettings />);
}

/** The Drills tab. */
function openDrills() {
  return render(<DrillSettings />);
}

/** The saved calibrations, at the foot of the Microphone tab. */
function openCalibration(over: Partial<React.ComponentProps<typeof CalibrationSettings>> = {}) {
  const props = { profileId: undefined as string | undefined, onProfilesChanged: vi.fn(), ...over };
  return { ...render(<CalibrationSettings {...props} />), props };
}

beforeEach(() => localStorage.clear());

describe("the saved calibrations", () => {
  it("lists what has been saved, with the measurement beside each", async () => {
    /* The name alone cannot tell two positions of one microphone apart — the
       corpus has one webcam measuring 34 ms, 13 ms and 2.5 ms — so every row
       carries its number. */
    saveProfile(PROFILE());
    saveProfile(PROFILE({ id: "p2", nickname: "across the room", releaseOffsetSec: 0.034 }));
    openCalibration();
    const rows = screen.getAllByTestId("calrow");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).toMatch(/\d+\.\d ms/);
    await waitFor(() => expect(screen.queryByTestId("reclist")).toBeNull());
  });

  it("deletes one, after asking", async () => {
    /* Not on the first click. A calibration is forty seconds of somebody's
       attention and there is no undo. */
    saveProfile(PROFILE());
    const user = userEvent.setup();
    const { props } = openCalibration();

    await user.click(screen.getByTestId("delete-profile"));
    expect(loadProfiles()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(loadProfiles()).toEqual([]);
    expect(props.onProfilesChanged).toHaveBeenCalled();
  });

  it("keeps it when the answer is no", async () => {
    saveProfile(PROFILE());
    const user = userEvent.setup();
    openCalibration();
    await user.click(screen.getByTestId("delete-profile"));
    await user.click(screen.getByRole("button", { name: /^keep$/i }));
    expect(loadProfiles()).toHaveLength(1);
  });

  it("clears the selection when the deleted one was in use", async () => {
    /* An id outliving its profile would leave the app believing it is
       calibrated while correcting by nothing — which is worse than not being
       calibrated, because nothing on screen would say so. */
    saveProfile(PROFILE());
    selectProfile("p1");
    const user = userEvent.setup();
    openCalibration({ profileId: "p1" });

    await user.click(screen.getByTestId("delete-profile"));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(activeProfile()).toBeNull();
  });

  it("says which one is in use before deleting it", async () => {
    saveProfile(PROFILE());
    const user = userEvent.setup();
    openCalibration({ profileId: "p1" });
    await user.click(screen.getByTestId("delete-profile"));
    // The consequence is specific to this row and worth saying once, at the
    // moment it applies.
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
    expect(screen.getByTestId("calrow").textContent).toMatch(/in use/i);
  });
});

describe("the user section", () => {
  /** Lets the calibration list finish loading inside act. */
  const settle = () => act(async () => {});

  it("heads each tab with what it holds", async () => {
    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    const you = open();
    await settle();
    expect(titles()).toEqual(["User"]);
    you.unmount();
    const drills = openDrills();
    expect(titles()).toEqual(["Drills"]);
    drills.unmount();
    openCalibration();
    await settle();
    expect(titles()).toEqual(["Saved calibrations", "Calibration recordings"]);
  });

  it("saves each field as it is typed, and reads it back", async () => {
    const user = userEvent.setup();
    const { unmount } = open();
    await settle();
    await user.type(screen.getByLabelText("Name"), "Rob");
    await user.type(screen.getByLabelText("Callsign"), "w7yfr");
    await user.type(screen.getByLabelText("Age"), "4x2");
    await user.type(screen.getByLabelText("Year licensed"), "20245");
    await user.type(screen.getByLabelText("CWops number"), "3x0012");
    await user.type(screen.getByLabelText("City"), "Portland");
    await user.type(screen.getByLabelText("Region, short"), "or");
    await user.type(screen.getByLabelText("Region, long"), "Oregon");
    await user.type(screen.getByLabelText("Antenna"), "efhw");
    await user.type(screen.getByLabelText("Manufacturer"), "yaesu");
    await user.type(screen.getByLabelText("Model"), "ft-710");
    await user.type(screen.getByLabelText("Power (W)"), "100w");
    expect(loadUser()).toEqual({
      name: "ROB",
      callsign: "W7YFR",
      age: "42",
      yearLicensed: "2024",
      cwopsNumber: "30012",
      qthCity: "PORTLAND",
      qthRegionShort: "OR",
      qthRegionLong: "OREGON",
      antenna: "EFHW",
      rigManufacturer: "YAESU",
      rigModel: "FT-710",
      rigPower: "100",
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("ROB");
    unmount();
    open();
    await settle();
    expect((screen.getByLabelText("Callsign") as HTMLInputElement).value).toBe("W7YFR");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("FT-710");
  });

  it("keeps the other preferences when it saves", async () => {
    const user = userEvent.setup();
    savePrefs({ charWpm: 18 });
    open();
    await settle();
    await user.type(screen.getByLabelText("Name"), "R");
    expect(loadPrefs().charWpm).toBe(18);
  });

  it("drops a stored user that is not the right shape", () => {
    localStorage.setItem("cwt:prefs", JSON.stringify({ user: { name: 5 } }));
    expect(loadUser().name).toBe("");
  });

  it("reads back a value saved in lower case as upper case", () => {
    localStorage.setItem(
      "cwt:prefs",
      JSON.stringify({ user: { name: "rob", callsign: "w7yfr" } }),
    );
    expect(loadUser()).toMatchObject({ name: "ROB", callsign: "W7YFR", qthCity: "" });
  });

  it("shows markup in a saved detail as text, never as elements", async () => {
    const markup = '<IMG SRC=X ONERROR="ALERT(1)">';
    localStorage.setItem("cwt:prefs", JSON.stringify({ user: { name: markup } }));
    open();
    await settle();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(markup);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("the drills section", () => {
  const settle = () => act(async () => {});
  const box = () => screen.getByTestId("custom-drill-text") as HTMLTextAreaElement;

  async function write(text: string) {
    const user = userEvent.setup();
    await user.click(box());
    await user.paste(text);
    return user;
  }

  it("saves the box as one drill, with each line break as a break", async () => {
    openDrills();
    await settle();
    const user = await write("cq cq de {CALLSIGN} k\n\n  {callsign}   de k7abc ");
    expect(box().value).toBe("CQ CQ DE {callsign} K\n\n  {callsign}   DE K7ABC ");
    await user.click(screen.getByTestId("save-drill"));
    expect(loadCustomDrills().map((d) => d.text)).toEqual([
      "CQ CQ DE {callsign} K | {callsign} DE K7ABC",
    ]);
    expect(box().value).toBe("");
    expect(screen.getByTestId("drillrow").querySelector("code")!.textContent).toBe(
      "CQ CQ DE {callsign} K\n{callsign} DE K7ABC",
    );
  });

  it("refuses a slot it does not know and a symbol with no Morse", async () => {
    openDrills();
    await settle();
    await write("HI {nmae}\nHI #");
    expect(screen.getByTestId("drill-problems").textContent).toMatch(/\{nmae\} is not a slot/);
    expect(screen.getByTestId("drill-problems").textContent).toMatch(/# has no Morse/);
    expect((screen.getByTestId("save-drill") as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes a saved drill", async () => {
    const user = userEvent.setup();
    saveCustomDrills([
      { id: "custom/a", text: "AAA" },
      { id: "custom/b", text: "BBB" },
    ]);
    openDrills();
    await settle();
    await user.click(screen.getAllByTestId("delete-drill")[0]!);
    expect(loadCustomDrills()).toEqual([{ id: "custom/b", text: "BBB" }]);
    expect(screen.getAllByTestId("drillrow")).toHaveLength(1);
  });

  it("edits a saved drill in place, keeping its id and position", async () => {
    const user = userEvent.setup();
    saveCustomDrills([
      { id: "custom/a", text: "AAA | BBB" },
      { id: "custom/b", text: "CCC" },
    ]);
    openDrills();
    await settle();
    await user.click(screen.getAllByTestId("edit-drill")[0]!);
    expect(box().value).toBe("AAA\nBBB");
    expect(screen.getByLabelText("Edit drill")).toBe(box());
    expect(screen.getByTestId("save-drill").textContent).toBe("Save changes");

    await user.clear(box());
    await user.type(box(), "ddd");
    await user.click(screen.getByTestId("save-drill"));
    expect(loadCustomDrills()).toEqual([
      { id: "custom/a", text: "DDD" },
      { id: "custom/b", text: "CCC" },
    ]);
    expect(box().value).toBe("");
    expect(screen.getByTestId("save-drill").textContent).toBe("Save drill");
  });

  it("cancels an edit without changing the drill", async () => {
    const user = userEvent.setup();
    saveCustomDrills([{ id: "custom/a", text: "AAA" }]);
    openDrills();
    await settle();
    await user.click(screen.getByTestId("edit-drill"));
    await user.type(box(), "B");
    await user.click(screen.getByTestId("cancel-edit"));
    expect(loadCustomDrills()).toEqual([{ id: "custom/a", text: "AAA" }]);
    expect(box().value).toBe("");
    expect(screen.queryByTestId("cancel-edit")).toBeNull();
  });

  it("ends the edit when the drill being edited is deleted", async () => {
    const user = userEvent.setup();
    saveCustomDrills([{ id: "custom/a", text: "AAA" }]);
    openDrills();
    await settle();
    await user.click(screen.getByTestId("edit-drill"));
    await user.click(screen.getByTestId("delete-drill"));
    expect(loadCustomDrills()).toEqual([]);
    expect(box().value).toBe("");
    expect(screen.getByTestId("save-drill").textContent).toBe("Save drill");
  });

  it("says which details a saved drill still needs", async () => {
    saveCustomDrills([{ id: "custom/a", text: "DE {callsign}" }]);
    openDrills();
    await settle();
    expect(screen.getByTestId("drillrow").textContent).toMatch(/Needs Callsign/);
  });

  it("lists the slots with the user's values, and adds one at the cursor", async () => {
    const user = userEvent.setup();
    saveUser({ ...loadUser(), callsign: "W7YFR" });
    openDrills();
    await settle();
    expect(screen.queryByTestId("drill-help")).toBeNull();
    await user.click(screen.getByTestId("drill-help-toggle"));
    const help = screen.getByTestId("drill-help");
    expect(help.textContent).toMatch(/W7YFR/);
    expect(help.textContent).toMatch(/not set/);

    await write("CQ  K");
    box().setSelectionRange(3, 3);
    await user.click(screen.getByTestId("insert-slot-callsign"));
    expect(box().value).toBe("CQ {callsign} K");
    expect(box().selectionStart).toBe(13);
  });

  it("adds a slot picked from the menu at the cursor", async () => {
    const user = userEvent.setup();
    openDrills();
    await settle();
    await write("DE  K");
    box().setSelectionRange(3, 3);
    await user.selectOptions(screen.getByTestId("insert-slot"), "rig_model");
    expect(box().value).toBe("DE {rig_model} K");
    expect(box().selectionStart).toBe(14);
    expect((screen.getByTestId("insert-slot") as HTMLSelectElement).value).toBe("");
  });

  it("drops stored drills that are not the right shape", () => {
    localStorage.setItem("cwt:prefs", JSON.stringify({ customDrills: [{ id: 1, text: "A" }] }));
    expect(loadCustomDrills()).toEqual([]);
  });
});

describe("the friends section", () => {
  const settle = () => act(async () => {});
  const BOB = { ...EMPTY_USER, id: "friend/a", name: "BOB", callsign: "K7ABC", qthCity: "BEND", qthRegionShort: "OR", wpm: 28, farnsworthWpm: 28, keys: ["keyer" as const] };
  const ANN = { ...EMPTY_USER, id: "friend/b", name: "ANN", callsign: "VE7XYZ", wpm: 18, farnsworthWpm: 12, keys: ["keyer" as const] };
  const rows = () => screen.queryAllByTestId("friendrow").map((r) => r.getAttribute("data-id"));
  const save = () => screen.getByTestId("save-friend") as HTMLButtonElement;

  it("adds a friend from the form of You, opened at the top", async () => {
    const user = userEvent.setup();
    saveFriends([BOB]);
    render(<FriendSettings />);
    await settle();
    expect(screen.queryByTestId("friend-form")).toBeNull();
    await user.click(screen.getByTestId("add-friend"));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    const form = screen.getByTestId("friend-form");
    // Above the saved friends, so it is always in the same place.
    expect(form.compareDocumentPosition(screen.getByTestId("friendlist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByTestId("add-friend") as HTMLButtonElement).disabled).toBe(true);
    // It needs a call and a name.
    await user.type(screen.getByLabelText("Callsign"), "n4qq");
    expect(save().disabled).toBe(true);
    await user.type(screen.getByLabelText("Name"), "jim");
    // Their speeds start at the default, and the sliders set them. Overall
    // follows character speed down, never above it.
    const wpm = document.getElementById("friend-wpm") as HTMLInputElement;
    const farns = document.getElementById("friend-farns") as HTMLInputElement;
    expect([Number(wpm.value), Number(farns.value)]).toEqual([FRIEND_WPM, FRIEND_WPM]);
    fireEvent.change(farns, { target: { value: "20" } });
    fireEvent.change(wpm, { target: { value: "18" } });
    expect(Number(farns.value)).toBe(18);
    fireEvent.change(wpm, { target: { value: "32" } });
    fireEvent.change(farns, { target: { value: "24" } });
    // Enter in a field saves, as the button does.
    await user.type(screen.getByLabelText("CWops number"), "12x3{Enter}");
    const friends = loadFriends();
    expect(friends.map((f) => f.callsign)).toEqual(["K7ABC", "N4QQ"]);
    expect(friends[1]).toMatchObject({ name: "JIM", cwopsNumber: "123", wpm: 32, farnsworthWpm: 24 });
    expect(screen.queryByTestId("friend-form")).toBeNull();
    expect(rows()).toEqual(["friend/a", friends[1]!.id]);
  });

  it("shows each saved friend read-only, with no fields", async () => {
    saveFriends([BOB, ANN]);
    render(<FriendSettings />);
    await settle();
    expect(rows()).toEqual(["friend/a", "friend/b"]);
    for (const row of screen.getAllByTestId("friendrow")) {
      expect(row.getAttribute("data-editing")).toBe("false");
      expect(row.querySelector("input")).toBeNull();
    }
    expect(screen.getAllByTestId("friendrow")[0]!.textContent).toContain("K7ABC");
  });

  it("edits a friend in their own row, keeping their id and place", async () => {
    const user = userEvent.setup();
    saveFriends([BOB, ANN]);
    render(<FriendSettings />);
    await settle();
    await user.click(screen.getAllByTestId("edit-friend")[0]!);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    const form = screen.getByTestId("friend-form");
    expect(screen.getByTestId("friendlist").firstElementChild!.contains(form)).toBe(true);
    expect((screen.getByLabelText("Callsign") as HTMLInputElement).value).toBe("K7ABC");
    expect(Number((document.getElementById("friend-wpm") as HTMLInputElement).value)).toBe(28);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "bobby");
    await user.click(save());
    expect(loadFriends().map((f) => [f.id, f.name])).toEqual([
      ["friend/a", "BOBBY"],
      ["friend/b", "ANN"],
    ]);
    expect(rows()).toEqual(["friend/a", "friend/b"]);
  });

  it("cancels an edit without changing the friend", async () => {
    const user = userEvent.setup();
    saveFriends([BOB]);
    render(<FriendSettings />);
    await settle();
    await user.click(screen.getByTestId("edit-friend"));
    await user.type(screen.getByLabelText("Name"), "X");
    await user.click(screen.getByTestId("cancel-friend"));
    expect(loadFriends()).toEqual([BOB]);
    expect(screen.queryByTestId("friend-form")).toBeNull();
  });

  it("deletes a friend, leaving another's open form as it is", async () => {
    const user = userEvent.setup();
    saveFriends([BOB, ANN]);
    render(<FriendSettings />);
    await settle();
    await user.click(screen.getAllByTestId("edit-friend")[1]!);
    await user.click(screen.getByTestId("delete-friend"));
    expect(loadFriends()).toEqual([ANN]);
    expect((screen.getByLabelText("Callsign") as HTMLInputElement).value).toBe("VE7XYZ");
    await user.click(screen.getByTestId("cancel-friend"));
    expect(rows()).toEqual(["friend/b"]);
  });

  it("reads saved friends back in upper case, and drops ones that are not the right shape", () => {
    localStorage.setItem("cwt:prefs", JSON.stringify({ friends: [{ id: "friend/a", name: "bob", callsign: "k7abc" }] }));
    // Saved before friends had a speed or a key: the default speed, on a keyer.
    expect(loadFriends()).toEqual([
      { ...EMPTY_USER, id: "friend/a", name: "BOB", callsign: "K7ABC", wpm: FRIEND_WPM, farnsworthWpm: FRIEND_WPM, keys: ["keyer"] },
    ]);
    // Saved before friends had an overall speed: their own speed.
    localStorage.setItem("cwt:prefs", JSON.stringify({ friends: [{ id: "friend/a", name: "BOB", callsign: "K7ABC", wpm: 30 }] }));
    expect(loadFriends()[0]).toMatchObject({ wpm: 30, farnsworthWpm: 30 });
    localStorage.setItem("cwt:prefs", JSON.stringify({ friends: [{ name: "BOB" }] }));
    expect(loadFriends()).toEqual([]);
    localStorage.setItem("cwt:prefs", JSON.stringify({ friends: [{ id: "friend/a", name: "BOB", callsign: "K7ABC", keys: ["cootie"] }] }));
    expect(loadFriends()).toEqual([]);
    localStorage.setItem("cwt:prefs", JSON.stringify({ friends: [{ id: "friend/a", name: "BOB", callsign: "K7ABC", keys: [] }] }));
    expect(loadFriends()).toEqual([]);
  });

  it("saves the keys a friend sends with, at least one, and shows them in their line", async () => {
    const user = userEvent.setup();
    saveFriends([BOB]);
    render(<FriendSettings />);
    await settle();
    const line = () => screen.getByTestId("friendrow").textContent;
    const box = (key: string) => document.getElementById(`friend-key-${key}`) as HTMLInputElement;
    const before = line();
    await user.click(screen.getByTestId("edit-friend"));
    expect([box("keyer").checked, box("bug").checked]).toEqual([true, false]);
    expect(screen.queryByTestId("friend-problems")).toBeNull();
    // None: Save is barred, and the form says why.
    await user.click(box("keyer"));
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId("friend-problems")).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "{Enter}");
    expect(loadFriends()[0]!.keys).toEqual(["keyer"]);
    await user.click(box("bug"));
    expect(screen.queryByTestId("friend-problems")).toBeNull();
    await user.click(save());
    expect(loadFriends()[0]).toMatchObject({ id: "friend/a", keys: ["bug"] });
    const onBug = line();
    expect(onBug).not.toBe(before);
    // Both: a keyer or a bug, picked each time they call.
    await user.click(screen.getByTestId("edit-friend"));
    expect([box("keyer").checked, box("bug").checked]).toEqual([false, true]);
    await user.click(box("keyer"));
    await user.click(save());
    expect(loadFriends()[0]!.keys).toEqual(["keyer", "bug"]);
    const both = line();
    expect(both).not.toBe(onBug);
    // A straight key, with the other two.
    await user.click(screen.getByTestId("edit-friend"));
    expect(box("straight").checked).toBe(false);
    await user.click(box("straight"));
    await user.click(save());
    expect(loadFriends()[0]!.keys).toEqual(["keyer", "bug", "straight"]);
    expect(line()).not.toBe(both);
  });
});
