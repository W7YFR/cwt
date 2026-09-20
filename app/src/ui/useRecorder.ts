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
  requestMicAccess,
  startRecording,
  type InputDevice,
  type Recorder,
} from "@/capture/mic";
import { micLog } from "@/micdebug";
import type { AudioClip } from "@/types";
import { noteMicOpened, noteMicRefused, useMicAccess } from "./useMicAccess";

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
  /** True until the first look at the device list has come back.
   *
   *  Every state below is read off that list, and before it arrives the
   *  honest answer to all of them is "not yet" — not the answer they happen
   *  to default to. Without this the first paint of the landing screen is a
   *  live record button, replaced a frame later by the one that asks for
   *  permission: the wrong control, and briefly a working one. */
  probing: boolean;
  /** True when the browser has not let this page near the microphone yet.
   *
   *  The tell is the device list: withheld entirely, or handed back with the
   *  names stripped off. Either way there is nothing to choose between, so a
   *  screen that offers a picker is offering an empty one — and the button
   *  beside it would be raising the permission prompt and starting a take on
   *  whatever the default input happens to be, in a single click.
   *
   *  How many inputs that list appears to hold means nothing until the names
   *  arrive with it. One anonymized entry is what a browser hands back to
   *  withhold six of them. */
  needAccess: boolean;
  /** True when the browser will not hand over the microphone at all.
   *
   *  A different fact from `needAccess`, and the difference is whether there
   *  is anything to click: an unasked microphone is one prompt away, a
   *  blocked one cannot be reached from the page at all and only the
   *  browser's own site settings will change that. Every way in is barred
   *  while this holds, because each of them would open the prompt, be refused
   *  without showing anything, and read as a dead button. */
  blocked: boolean;
  /** Non-null while capturing. */
  recorder: Recorder | null;
  elapsed: number;
  level: number;
  /** True while a finished recording is being analyzed. */
  busy: boolean;
  start(): Promise<void>;
  /** Raise the permission prompt without starting a take, so choosing a
   *  microphone and recording from it stay two separate decisions. */
  grantAccess(): Promise<void>;
  /** Throw away what has been captured and keep recording on the same open
   *  device — no second permission prompt, no gap. */
  restart(): void;
  finish(): Promise<void>;
  discard(): Promise<void>;
}

/** Whether the browser refused, as opposed to failing to find a device.
 *
 * The name is the reliable half — `NotAllowedError` is what every browser
 * raises for a refusal — and the message is checked too because the wrapper
 * this app throws for an unusable environment carries no name at all. */
function isRefusal(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "NotAllowedError") return true;
  return /denied|NotAllowed/i.test(e instanceof Error ? e.message : String(e));
}

/** What to say when a device will not open.
 *
 * One place, because a refusal is the same fact whether it arrived from the
 * permission prompt or from the first take, and two copies of it drift. */
function micError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return isRefusal(e)
    ? "Microphone access was denied. Allow it in the address bar, then try again."
    : `Could not open the microphone: ${msg}`;
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
  /** The device list came back with nothing in it worth picking between. */
  const [unnamed, setUnnamed] = useState(false);
  /* Asked, and told no.
   *
   * Remembered here because only Chromium will say so on its own: Firefox and
   * Safari reject the permission query for the microphone, so a refusal that
   * happened a second ago is invisible to `watchMicAccess` and the page would
   * go on offering to ask. The browser's own answer still wins where there is
   * one — coming back with the site settings changed clears this, because the
   * query reports "granted" and nothing below consults this flag any more. */
  const [refused, setRefused] = useState(false);
  /** Whether the device list has been read even once. */
  const [probed, setProbed] = useState(false);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const found = await listInputs();
      setDevices(found);
      /* Labels are empty until permission has been granted at least once —
         the browser refusing to let a page fingerprint the hardware, not a
         bug. `listInputs` has already put a position in place of each blank,
         so the tell is a list of those rather than a list of nothing.

         The empty list is the same fact arriving differently: Firefox
         withholds the inputs altogether rather than anonymising them. It is
         also what a machine with no microphone looks like, and the two are
         not distinguishable from here — but the button that asks says so
         precisely when it fails, which beats a picker that draws nothing. */
      setUnnamed(found.every((d) => /^Input \d+$/.test(d.label)));
    } catch {
      setDevices([]);
      setUnnamed(true);
    } finally {
      // Asked and answered, however it went. A lookup that threw is still a
      // lookup, and leaving this false would hold the screen forever.
      setProbed(true);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  /* Two witnesses to the same question, because no one browser offers both.
   *
   * Chromium answers the permission query outright, and "prompt" settles it
   * before a single device has been enumerated. Firefox and Safari reject the
   * query for the microphone — `watchMicAccess` reports that as "unknown" —
   * and there the only evidence is the list itself, which comes back stripped
   * of names or empty.
   *
   * A settled permission wins over the list either way: "granted" with no
   * inputs is a machine with nothing plugged in, and "denied" is already
   * explained by the banner at the top of the app. Neither is a prompt worth
   * offering. */
  const access = useMicAccess();
  const blocked = access === "denied" || (access !== "granted" && refused);
  /* A count cannot be read off a list that has been anonymized.
     
     This briefly skipped the asking step when the browser reported exactly one
     input, on the reasoning that one input is not a choice and so there is
     nothing for the step to protect. The reasoning is fine; the premise was
     not. Before permission, Chrome hands back a single placeholder entry
     however many microphones are actually attached — `{id:(empty)
     label:(empty)}`, which is the same thing an iPhone with one microphone
     hands back, byte for byte. So the shortcut read "one input" on a desktop
     with several and took away the only control that would ever have named
     them.
     
     There is no safe version of it either: a list whose names have arrived is
     a list that can be counted, but by then permission has been granted and
     `access` already says so a line above. The count is only trustworthy once
     it no longer matters.
     
     Which leaves the phone with the step it does not need — one microphone, so
     nothing to pick once it is granted. That is a wasted tap and not a bug:
     the step now clears itself the moment the grant lands, which is the thing
     that was actually broken, and it reads the same on every platform. */
  const needAccess = blocked
    ? false
    : access === "granted"
      ? false
      : access === "prompt"
        ? true
        : unnamed;

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
      /* A device opened, which is the browser having said yes — the one
         answer every browser gives, including the ones that will not answer
         the permission query. Worth saying out loud for the screen after this
         one, which builds its own recorder and would otherwise start over
         from "not asked yet". */
      noteMicOpened();
      // Labels arrive once permission is granted, so the picker is worth
      // re-reading the moment a recording starts.
      void refreshDevices();
    } catch (e) {
      micLog("start() failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      if (isRefusal(e)) {
        setRefused(true);
        noteMicRefused();
      }
      onError(micError(e));
    }
  }, [deviceId, onError, onStart, refreshDevices]);

  const grantAccess = useCallback(async () => {
    try {
      await requestMicAccess();
      setRefused(false);
      /* The whole point of the button, recorded as a fact rather than left
         to be inferred from the device list a moment later. That inference is
         what failed on iOS: the permission sheet was allowed and the list
         below came back looking exactly as it did before the prompt, so the
         screen went on offering to ask. See `useMicAccess`. */
      noteMicOpened();
    } catch (e) {
      micLog("grantAccess() failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      if (isRefusal(e)) {
        setRefused(true);
        noteMicRefused();
      }
      onError(micError(e));
    } finally {
      /* Either way. Granted, the names arrive and the picker has something to
         offer; refused, the list is unchanged but the permission behind it is
         not, and re-reading is how this screen finds that out. */
      await refreshDevices();
    }
  }, [onError, refreshDevices]);

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
        /* And the same three states that button has, for the same reason:
           the key and the button are two ways in to one thing, and a rule
           only one of them obeys is not a rule. Blocked, there is nothing
           for either to do; unasked, both ask rather than recording from a
           device that has not been chosen yet. */
        if (blocked || !probed) return;
        ev.preventDefault();
        void (needAccess ? grantAccess() : start());
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
  }, [
    blocked,
    probed,
    busy,
    discard,
    finish,
    grantAccess,
    needAccess,
    recorder,
    restart,
    start,
    startKey,
  ]);

  return {
    devices,
    probing: !probed,
    needAccess,
    blocked,
    grantAccess,
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
