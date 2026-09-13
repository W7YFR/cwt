/* Reading a recording again under a different calibration.
 *
 * The plumbing, not the arithmetic. That a measured offset makes a recording
 * read closer to the speed it was keyed at is settled in the pure tier against
 * wav files; what is new here is that the review can apply one to audio it is
 * already showing, without the recording becoming a different recording.
 *
 * Worth having because this is the app's best measuring instrument. Comparing
 * two calibrations by recording the same message twice leaves the room, the
 * placement and the operator's fist free to vary; switching the profile under
 * one recording holds all three fixed, and the only variable left is the
 * correction.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { act, renderHook } from "@testing-library/react";
import { useTake } from "@/ui/useTake";
import { MIC_SOURCE, isBlankTake } from "@/io/take";
import type { Profile } from "@/io/profiles";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";

const MESSAGE = `${DATA_DIR}/k3ng/cq-de-w7yfr/k3ng-webcam-cq-de-w7yfr-15wpm.wav`;
const SENT = "CQ DE W7YFR";
const HAVE = existsSync(MESSAGE);

/* A plausible profile. The number is not what is under test — it only has to
   be a real correction, so that applying it is visibly different from not. */
const PROFILE: Profile = {
  id: "p1",
  nickname: "shack desk",
  deviceId: "webcam",
  deviceLabel: "HD Pro Webcam",
  wpm: 15,
  releaseOffsetSec: 0.0079,
  spreadSec: 0.0004,
  elements: 120,
  verdict: "marginal",
  decaySec: 0.082,
  maxWpm: 10,
  recordedAt: "2026-09-01T10:00:00+00:00",
};

function clip() {
  const wav = readWav(MESSAGE);
  let peak = 0;
  for (const v of wav.samples) peak = Math.max(peak, Math.abs(v));
  return { samples: wav.samples, rate: wav.rate, peak };
}

beforeEach(() => localStorage.clear());

describe.skipIf(!HAVE)("re-reading a take under a calibration", () => {
  it("applies one to the recording already on screen", async () => {
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, id: "t1" }));

    const before = result.current.loaded!.take;
    expect(before.profile ?? null).toBeNull();

    await act(async () => {
      await result.current.recalibrate(PROFILE);
    });

    const after = result.current.loaded!.take;
    expect(after.profile?.nickname).toBe("shack desk");
    expect(after.profile?.releaseOffsetSec).toBe(PROFILE.releaseOffsetSec);
    // A correction that moved nothing would not be a correction.
    expect(after.measured.charWpm).not.toBe(before.measured.charWpm);
  });

  it("is still the same recording afterwards", async () => {
    /* Same id, same audio, same text. Otherwise a directory of reports gains
       an entry every time somebody tries a different profile, and the history
       stops being a history of sessions. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, id: "t1" }));
    const before = result.current.loaded!.take;

    await act(async () => {
      await result.current.recalibrate(PROFILE);
    });

    const after = result.current.loaded!.take;
    expect(after.id).toBe(before.id);
    expect(after.recordedAt).toBe(before.recordedAt);
    expect(after.decoded).toBe(before.decoded);
    expect(after.toneHz).toBe(before.toneHz);
  });

  it("keeps the settings, which belong to whoever is looking", async () => {
    /* Zoom, tolerance and speeds are not part of the analysis, and resetting
       them here would punish exactly the comparison this exists for: you
       change the profile to see what moved, not to lose your place. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, id: "t1" }));
    act(() => result.current.setSettings({ tolerance: 0.12, ppu: 40, charWpm: 18 }));
    const kept = result.current.settings;

    await act(async () => {
      await result.current.recalibrate(PROFILE);
    });

    expect(result.current.settings).toEqual(kept);
  });

  it("goes back to reading it raw", async () => {
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, id: "t1" }));
    const raw = result.current.loaded!.take.measured.charWpm;

    await act(async () => {
      await result.current.recalibrate(PROFILE);
    });
    await act(async () => {
      await result.current.recalibrate(null);
    });

    expect(result.current.loaded!.take.profile ?? null).toBeNull();
    expect(result.current.loaded!.take.measured.charWpm).toBe(raw);
  });

  it("resets to a session with the target still in it", async () => {
    /* The loop: set it up, send it, look at it, wipe it, send it again. What
       is wiped is the recording; what survives is what you are practising. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, expected: SENT, id: "t1" }));
    act(() => result.current.setSettings({ charWpm: 18, tolerance: 0.1 }));

    act(() => result.current.reset());

    const take = result.current.loaded!.take;
    expect(isBlankTake(take)).toBe(true);
    expect(take.decoded).toBe("");
    expect(take.durationSec).toBe(0);
    // The settings and the message are the session, not the recording.
    expect(result.current.settings.charWpm).toBe(18);
    expect(result.current.settings.tolerance).toBe(0.1);
    expect(result.current.settings.expected).toBe(SENT);
    // And the target is still a real timeline to practise against.
    expect(result.current.review!.ideal.text.trim()).toBe(SENT);
    expect(result.current.review!.ideal.duration).toBeGreaterThan(0);
  });

  it("reports nothing rather than reporting zeroes", async () => {
    /* Every figure on the review is a reading off a recording. With no
       recording an empty grade comes out "100% consistent", which is the most
       convincing kind of wrong. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: MIC_SOURCE, expected: SENT, id: "t1" }));
    act(() => result.current.reset());

    const r = result.current.review!;
    expect(r.analysis.stats).toEqual([]);
    expect(r.analysis.deviations).toEqual([]);
    // Present, but not a grade anybody earned — the UI dashes it.
    expect(isBlankTake(r.take)).toBe(true);
  });

  it("never corrects a file, wherever the request came from", async () => {
    /* A file was made somewhere else — possibly by somebody else, possibly
       through a loopback with nothing in the path at all — and this machine's
       calibration describes neither. Correcting it would quietly alter numbers
       that were already measured. The rule lives in profileForSource and is
       enforced here as well as at record time, because this is a second door
       into the same decision. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.load(clip(), { source: "someone-else.wav", id: "t1" }));
    const before = result.current.loaded!.take.measured.charWpm;

    await act(async () => {
      await result.current.recalibrate(PROFILE);
    });

    expect(result.current.loaded!.take.profile ?? null).toBeNull();
    expect(result.current.loaded!.take.measured.charWpm).toBe(before);
  });
});
