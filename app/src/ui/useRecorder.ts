/* Owning the microphone, so more than one screen can offer it.
 *
 * The landing page and the review header both want to start a recording, and
 * they want it to behave identically — same device list, same permission
 * explanation, same level meter. They differ only in how much room they have to
 * draw it. So the behavior lives here and each screen supplies its own
 * presentation.
 *
 * One instance per mounted screen, which is safe because only one of those
 * screens is ever mounted at a time. Lifting it any higher would mean threading
 * a handle through props that exist for no other reason, and would make the
 * landing page impossible to test on its own.
 */

import { useCallback, useEffect, useState } from "react";
import {
  listInputs,
  startRecording,
  type InputDevice,
  type Recorder,
} from "@/capture/mic";
import type { AudioClip } from "@/types";

export interface UseRecorderOptions {
  deviceId: string | undefined;
  /** A finished recording, at the level it was captured. */
  onClip(clip: AudioClip): void;
  onError(message: string): void;
}

export interface RecorderHandle {
  /** Every input the browser will admit to. */
  devices: InputDevice[];
  /** True when the list is all blanks, which means permission has never been
   *  granted and the names are being withheld. */
  needPermission: boolean;
  /** Non-null while capturing. */
  recorder: Recorder | null;
  elapsed: number;
  level: number;
  /** True while a finished recording is being analyzed. */
  busy: boolean;
  start(): Promise<void>;
  /** Throw away what has been captured and keep recording on the same open
   *  device — no second permission prompt, no gap. */
  restart(): void;
  finish(): Promise<void>;
  discard(): Promise<void>;
}

export function useRecorder(options: UseRecorderOptions): RecorderHandle {
  const { deviceId, onClip, onError } = options;
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [needPermission, setNeedPermission] = useState(false);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const found = await listInputs();
      setDevices(found);
      // Labels are empty until permission has been granted at least once. That
      // is the browser refusing to let a page fingerprint the hardware, not a
      // bug — but a list of blanks is useless, so say why.
      setNeedPermission(
        found.length > 0 && found.every((d) => !d.label || /^Input \d+$/.test(d.label)),
      );
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const start = useCallback(async () => {
    /* Cleared before the device is opened, not after.
     *
     * `elapsed` is only ever written by the level callback, so after a
     * recording ends it keeps the length of that recording until the next one
     * reports. Anything that reads the clock in between sees the old take's
     * duration — and a screen that schedules itself against it, as the
     * calibration wizard does, runs its whole sequence in one render and lands
     * on the last step with the clock reading forty seconds. Resetting after
     * the await leaves that window open for as long as opening a device takes,
     * which is exactly when the stale value is on screen. */
    setElapsed(0);
    setLevel(0);
    try {
      const rec = await startRecording({
        deviceId,
        onLevel: (peak, seconds) => {
          setLevel(peak);
          setElapsed(seconds);
        },
      });
      setRecorder(rec);
      // Labels arrive once permission is granted, so the picker is worth
      // re-reading the moment a recording starts.
      void refreshDevices();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError(
        /denied|NotAllowed/i.test(msg)
          ? "Microphone access was denied. Allow it in the address bar, then try again."
          : `Could not open the microphone: ${msg}`,
      );
    }
  }, [deviceId, onError, refreshDevices]);

  /* The same reset, for the same reason: `restart()` zeroes the recorder's own
     counter, but nothing reports that until the next level callback. */
  const restart = useCallback(() => {
    if (!recorder) return;
    recorder.restart();
    setElapsed(0);
    setLevel(0);
  }, [recorder]);

  const finish = useCallback(async () => {
    if (!recorder) return;
    setBusy(true);
    try {
      const clip = await recorder.stop();
      setRecorder(null);
      if (clip.samples.length === 0) {
        onError("That recording came back empty — check the input device and try again.");
        return;
      }
      onClip(clip);
    } finally {
      setBusy(false);
    }
  }, [onClip, onError, recorder]);

  const discard = useCallback(async () => {
    if (!recorder) return;
    await recorder.cancel();
    setRecorder(null);
    setElapsed(0);
  }, [recorder]);

  /* Enter finishes the take, Escape throws it away, R starts it over — while
   * recording, and not otherwise.
   *
   * Enter and Escape fire from anywhere, including a text field, which is the
   * one place the usual "skip it if a control has focus" guard would get
   * wrong. You type what you are about to send, then key it; your hand is on
   * the paddle, not the mouse, and the intended-message box is very likely
   * still focused. Making you click a button to stop would mean the last
   * second of every recording is you reaching for the mouse.
   *
   * R is different, and gets the guard those two do without. It is a letter:
   * bound unconditionally it would throw away the take the moment somebody
   * typed an R into the intended-message box — which is a word away in "CQ DE
   * W7YFR". Modifiers are left alone too, or this would swallow the browser's
   * own reload. */
  useEffect(() => {
    if (!recorder) return;
    const onKey = (ev: KeyboardEvent) => {
      // Mid-composition Enter is committing an IME candidate, not a command.
      if (ev.isComposing) return;
      if (ev.key === "Enter") {
        ev.preventDefault();
        void finish();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        void discard();
      } else if (ev.key === "r" || ev.key === "R") {
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
        const tag = (ev.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        ev.preventDefault();
        restart();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [discard, finish, recorder, restart]);

  return {
    devices,
    needPermission,
    recorder,
    elapsed,
    level,
    busy,
    start,
    restart,
    finish,
    discard,
  };
}
