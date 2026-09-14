/* Keeping calibration recordings, in a browser that actually has IndexedDB.
 *
 * jsdom has none, and every function here swallows its own failures — so in
 * the DOM tier they all "succeed" by doing nothing, which is exactly the shape
 * of a bug this would never catch. Hence a real browser.
 *
 * The behavior that matters is not that a blob round-trips. It is that the
 * attempts which produced *no* calibration are kept too, because those are the
 * ones somebody needs to send to whoever can explain them, and that deleting a
 * profile takes its recording with it rather than leaving megabytes belonging
 * to nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  KEEP_CALIBRATIONS,
  forgetCalibration,
  forgetCalibrationsFor,
  getCalibrationAudio,
  keepCalibration,
  linkCalibration,
  listCalibrations,
} from "@/io/storage";

function entry(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    recordedAt: `2026-09-${id.slice(-2)}T10:00:00+00:00`,
    audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
    durationSec: 41,
    wpm: 15,
    reason: null,
    verdict: "good",
    offsetSec: 0.013,
    profileId: null,
    deviceLabel: "HD Pro Webcam",
    ...over,
  };
}

async function wipe() {
  for (const row of await listCalibrations()) await forgetCalibration(row.id);
}

beforeEach(wipe);

describe("calibration recordings", () => {
  it("keeps one, and hands the audio back", async () => {
    await keepCalibration(entry("cal-01"));
    const rows = await listCalibrations();
    expect(rows.map((r) => r.id)).toEqual(["cal-01"]);
    // The listing is deliberately audio-free: a page of rows should not pull
    // tens of megabytes off disk to render four lines.
    expect("audio" in rows[0]!).toBe(false);
    expect((await getCalibrationAudio("cal-01"))!.size).toBe(4);
  });

  it("keeps the attempts that failed, which are the useful ones", async () => {
    /* A calibration that refuses in a room nobody here has stood in is the
       whole reason this store exists. Keeping only the successes would keep
       exactly the recordings nobody needs. */
    await keepCalibration(entry("cal-02", { reason: "disagree", offsetSec: null }));
    const rows = await listCalibrations();
    expect(rows[0]!.reason).toBe("disagree");
    expect(await getCalibrationAudio("cal-02")).not.toBeNull();
  });

  it("keeps only the last few", async () => {
    for (let i = 1; i <= KEEP_CALIBRATIONS + 2; i++) {
      await keepCalibration(entry(`cal-${String(i).padStart(2, "0")}`));
    }
    const rows = await listCalibrations();
    expect(rows).toHaveLength(KEEP_CALIBRATIONS);
    // Newest first, and it is the oldest that go.
    expect(rows[0]!.id).toBe(`cal-0${KEEP_CALIBRATIONS + 2}`);
    expect(rows.map((r) => r.id)).not.toContain("cal-01");
  });

  it("lets a saved profile point back at the audio it came from", async () => {
    await keepCalibration(entry("cal-03"));
    await linkCalibration("cal-03", "p1");
    expect((await listCalibrations())[0]!.profileId).toBe("p1");
  });

  it("drops the recording when its profile is deleted", async () => {
    // Audio kept for a calibration nobody can select any more is a few
    // megabytes of nothing.
    await keepCalibration(entry("cal-04", { profileId: "p1" }));
    await keepCalibration(entry("cal-05", { profileId: "p2" }));
    await forgetCalibrationsFor("p1");
    expect((await listCalibrations()).map((r) => r.id)).toEqual(["cal-05"]);
  });
});
