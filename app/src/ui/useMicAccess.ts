/* Whether the microphone is available to this page at all.
 *
 * Separate from `useRecorder`, and asked at the top of the app rather than by
 * whichever screen happens to want a microphone, because a blocked one is not
 * a fact about a screen. It is a fact about the browser, and the symptom is
 * silence: the device list comes back empty, so every picker that offers a
 * choice correctly declines to offer one, and the page ends up with no
 * controls and no explanation. That reads as the app being broken.
 *
 * Only the permission, not the devices. Opening one is what `useRecorder`
 * does, and asking here would mean the page requesting a microphone it has no
 * intention of recording from.
 */

import { useEffect, useState } from "react";
import { watchMicAccess, type MicAccess } from "@/capture/mic";
import { micLog } from "@/micdebug";

/* The browser's answer goes stale, and it will not say so.
 *
 * Measured on an iPhone, Safari, over https on the LAN — the transcript
 * `?micdebug` prints, trimmed to the lines that matter:
 *
 *     0.214s  permissions.query resolved -> "prompt"
 *     0.218s  enumerateDevices -> {id:(empty) label:(empty)}
 *    21.846s  startRecording: opening a device
 *    23.234s  startRecording: device open
 *    23.234s  enumerateDevices -> {id:699EE917... label:iPhone Microphone}
 *    29.086s  permissions.query resolved -> "granted"
 *
 * Three things in that, none of them what was guessed here before it was run.
 *
 * Safari *does* answer the query for the microphone — "prompt", not a
 * rejection — so this page is not in the dark the way this file used to
 * assume. It simply answers once. No `change` event ever arrives, and the
 * status held here still said "prompt" long after the last line above proves
 * the browser would say "granted" if asked again. That staleness was the bug:
 * a permission read at load, believed forever, and believed over every other
 * piece of evidence the page had.
 *
 * The names arrive with the capture and stay — the opposite of the guess this
 * file replaced, which had WebKit taking them back when the track stopped.
 *
 * And the grant lasts the page rather than the capture: still "granted" five
 * seconds after the recording ended, but a fresh load is back to "prompt"
 * seconds after a grant. Safari's per-site default is Ask, and that is what
 * "it asks every time you open it" turns out to be.
 *
 * So: ask again when there is reason to think the answer moved, and keep the
 * first-hand evidence as the fallback for browsers that will not answer at all
 * — Firefox rejects this query outright, and there "unknown" is all there is.
 * `getUserMedia` resolving is the browser saying yes, more directly than any
 * permission status: it is the thing the status is *about*.
 *
 * Module-level rather than state in a hook, because each screen builds its own
 * recorder and only one of them is mounted at a time: granted on the landing
 * page, the answer has to still be true on the review screen that replaces it.
 * Not persisted past the page, though — a permission can be taken away from
 * outside, and on the next load the browser is the authority again. Which on
 * Safari it demonstrably is: a fresh load says "prompt".
 */
let opened = false;
/** Bumped whenever the first-hand evidence changes, to re-ask a browser that
 *  would never have volunteered the news. */
let generation = 0;
const watchers = new Set<() => void>();

function set(next: boolean): void {
  /* Only on the transition. A successful take reports "a device opened" every
     time, and re-querying the browser once per recording is noise. */
  if (opened === next) return;
  opened = next;
  generation++;
  micLog(next ? "remembered: a device opened" : "forgot the grant (refused)");
  for (const w of [...watchers]) w();
}

/** A device opened, which is the browser having said yes. */
export function noteMicOpened(): void {
  set(true);
}

/** A device refused. Forgets the grant above rather than merely recording a
 *  refusal beside it: a permission withdrawn mid-session is the browser
 *  changing its mind, and leaving the old "yes" standing would leave the page
 *  claiming access it has just been denied. */
export function noteMicRefused(): void {
  set(false);
}

/** Test seam: the fact outlives any one render tree, so a test that grants
 *  would otherwise hand a grant to every test after it. */
export function resetMicAccessMemory(): void {
  set(false);
}

export function useMicAccess(): MicAccess {
  const [access, setAccess] = useState<MicAccess>("unknown");
  const [seen, setSeen] = useState(() => ({ granted: opened, gen: generation }));
  useEffect(() => {
    const w = (): void => setSeen({ granted: opened, gen: generation });
    watchers.add(w);
    // Between render and effect, in case a sibling screen granted in between.
    w();
    return () => {
      watchers.delete(w);
    };
  }, []);
  /* Re-subscribed when the generation moves, and subscribing is what asks.
     This is the half that makes the answer current rather than remembered:
     Safari will not send the change, but it will answer the question. */
  useEffect(() => watchMicAccess(setAccess), [seen.gen]);
  /* "denied" is the browser barring the page, and it outranks everything here.
     Anything softer than that, held against a device this page has actually
     opened, is an answer that has gone stale. */
  return access !== "denied" && seen.granted ? "granted" : access;
}
