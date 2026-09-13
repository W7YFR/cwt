/* The configuration screen: deleting calibrations, and getting the audio back.
 *
 * `deleteProfile` has existed and been tested since profiles did, and nothing
 * called it — a list you can add to and not remove from. What is new here is
 * the screen, and the two rules it has to get right: deleting a profile takes
 * the recording it was measured from with it, and deleting the one in use
 * clears the selection rather than leaving an id pointing at nothing.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "@/ui/Settings";
import { loadProfiles, saveProfile, selectProfile, activeProfile } from "@/io/profiles";
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

function open(over: Partial<React.ComponentProps<typeof Settings>> = {}) {
  const props = {
    profileId: undefined as string | undefined,
    onProfilesChanged: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { ...render(<Settings {...props} />), props };
}

beforeEach(() => localStorage.clear());

describe("the configuration screen", () => {
  it("lists what has been saved, with the measurement beside each", async () => {
    /* The name alone cannot tell two positions of one microphone apart — the
       corpus has one webcam measuring 34 ms, 13 ms and 2.5 ms — so every row
       carries its number. */
    saveProfile(PROFILE());
    saveProfile(PROFILE({ id: "p2", nickname: "across the room", releaseOffsetSec: 0.034 }));
    open();
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
    const { props } = open();

    await user.click(screen.getByTestId("delete-profile"));
    expect(loadProfiles()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(loadProfiles()).toEqual([]);
    expect(props.onProfilesChanged).toHaveBeenCalled();
  });

  it("keeps it when the answer is no", async () => {
    saveProfile(PROFILE());
    const user = userEvent.setup();
    open();
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
    open({ profileId: "p1" });

    await user.click(screen.getByTestId("delete-profile"));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(activeProfile()).toBeNull();
  });

  it("says which one is in use before deleting it", async () => {
    saveProfile(PROFILE());
    const user = userEvent.setup();
    open({ profileId: "p1" });
    await user.click(screen.getByTestId("delete-profile"));
    // The consequence is specific to this row and worth saying once, at the
    // moment it applies.
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
    expect(screen.getByTestId("calrow").textContent).toMatch(/in use/i);
  });
});
