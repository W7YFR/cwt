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
  /** Called just before the device is opened.
   *
   * Where a screen with a transport stops it. Playback and recording cannot
   * both have the room: through a loopback device a playing target is
   * recorded literally, and through speakers it arrives a moment later and
   * grades as your sending. Here rather than on the buttons because R starts
   * a recording too, and a rule that only one of the two ways in obeys is not
   * a rule. */
  onStart?: (() => void) | undefined;
  /** Whether R starts a recording when none is running.
   *
   * Off unless asked for. The calibration wizard drives the recorder itself,
   * on its own schedule, so a key that starts one behind its back would have
   * nothing to do with what is on screen. The two screens that offer a record
   * button turn it on, and there the key and the button mean the same thing. */
  startKey?: boolean | undefined;
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

/** An R meant as a command: no modifiers, and not typed into a control. */
function bareR(ev: KeyboardEvent): boolean {
  if (ev.key !== "r" && ev.key !== "R") return false;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  const tag = (ev.target as HTMLElement | null)?.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}

export function useRecorder(options: UseRecorderOptions): RecorderHandle {
  const { deviceId, onClip, onError, onStart, startKey = false } = options;
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
    onStart?.();
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
  }, [deviceId, onError, onStart, refreshDevices]);

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

  /* R is the recording key: it starts one, and while one is running it starts
   * that one over. One key for one idea — "go, from here" — so there is
   * nothing to remember about which state you are in.
   *
   * Enter finishes the take and Escape throws it away, while recording and not
   * otherwise. Those two fire from anywhere, including a text field, which is
   * the one place the usual "skip it if a control has focus" guard would get
   * wrong. You type what you are about to send, then key it; your hand is on
   * the paddle, not the mouse, and the intended-message box is very likely
   * still focused. Making you click a button to stop would mean the last
   * second of every recording is you reaching for the mouse.
   *
   * R gets the guard those two do without. It is a letter: bound
   * unconditionally it would start or wreck a take the moment somebody typed
   * an R into the intended-message box — which is a word away in "CQ DE
   * W7YFR". Modifiers are left alone too, or this would swallow the browser's
   * own reload. */
  useEffect(() => {
    if (!recorder && !startKey) return;
    const onKey = (ev: KeyboardEvent) => {
      // Mid-composition Enter is committing an IME candidate, not a command.
      if (ev.isComposing) return;
      if (!recorder) {
        // Busy is a recording being analyzed — the same state that disables
        // the button this key stands in for.
        if (!bareR(ev) || busy) return;
        ev.preventDefault();
        void start();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        void finish();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        void discard();
      } else if (bareR(ev)) {
        ev.preventDefault();
        restart();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, discard, finish, recorder, restart, start, startKey]);

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
