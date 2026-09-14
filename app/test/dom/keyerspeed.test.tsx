/* The speed the keyer is set to, and where it is allowed to reach.
 *
 * Calibration asks for it because the measurement needs it — a held paddle is
 * only a known length if you know the speed. But it is a fact about the
 * equipment rather than about that one wizard, so having said the paddle is at
 * 25, being handed a review that assumes 20 is the app forgetting something it
 * was told.
 *
 * The line it must not cross is a recording. There, the character speed is
 * what the take is graded against, and moving it re-grades somebody's work
 * behind their back.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTake } from "@/ui/useTake";
import { savePrefs, loadPrefs } from "@/io/storage";
import { caseNamed, takeFrom, SLOPPY } from "../fixture";

const KEYER = 25;

beforeEach(() => localStorage.clear());

/** What the calibration wizard leaves behind when it runs. */
function calibratedAt(wpm: number) {
  savePrefs({ ...loadPrefs(), keyerWpm: wpm });
}

describe("the keyer's stated speed", () => {
  it("is what a fresh session opens at", () => {
    calibratedAt(KEYER);
    const { result } = renderHook(() => useTake());
    expect(result.current.settings.charWpm).toBe(KEYER);
  });

  it("moves both speeds, so no Farnsworth gap appears from nowhere", () => {
    /* Naming the character speed alone would leave the overall speed where it
       was, which is a spacing setting nobody asked for. */
    calibratedAt(KEYER);
    const { result } = renderHook(() => useTake());
    expect(result.current.settings.farnsworthWpm).toBe(
      result.current.settings.charWpm,
    );
  });

  it("leaves the default alone when nothing has been calibrated", () => {
    const { result } = renderHook(() => useTake());
    expect(result.current.settings.charWpm).toBeGreaterThan(0);
    expect(result.current.settings.farnsworthWpm).toBe(
      result.current.settings.charWpm,
    );
  });

  it("reaches a session already open, on the way back from calibrating", () => {
    /* The wizard does not remount the review, so a stored speed that only
       applied at startup would not arrive until the next reload. */
    const { result } = renderHook(() => useTake());
    const before = result.current.settings.charWpm;
    calibratedAt(before + 7);

    act(() => result.current.adoptKeyerSpeed());
    expect(result.current.settings.charWpm).toBe(before + 7);
  });

  it("does not re-grade a recording that is already on screen", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const { result } = renderHook(() => useTake());
    act(() => result.current.adopt(take, new ArrayBuffer(0)));

    const graded = result.current.settings.charWpm;
    calibratedAt(graded + 7);
    act(() => result.current.adoptKeyerSpeed());

    // The take's own speed is what it is measured against, and it stands.
    expect(result.current.settings.charWpm).toBe(graded);
  });

  it("moves a session with nothing recorded in it yet", () => {
    /* The other side of the same rule: an empty practice session has no work
       to protect, and the speed there is what you are about to send at. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.reset());
    const before = result.current.settings.charWpm;
    calibratedAt(before + 7);

    act(() => result.current.adoptKeyerSpeed());
    expect(result.current.settings.charWpm).toBe(before + 7);
  });
});
