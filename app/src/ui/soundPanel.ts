/* Whether a panel with the sound settings is open: the Band popover, or
 * Settings on its Sound tab.
 *
 * Making a page's sound again takes a few hundred ms: the QSO page's band,
 * the Copy page's generated QSO. Done at each step of a slider, it froze the
 * slider. So while a sound panel is open, a page keeps playing the sound as
 * it was, Preview plays the settings being changed, and the page makes its
 * sound again once, when the panel closes.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

let openPanels = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while any sound panel is open. */
export function useSoundPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openPanels > 0);
}

/** Counts this panel as open while `open` is true. */
export function useSoundPanel(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    openPanels++;
    changed();
    return () => {
      openPanels--;
      changed();
    };
  }, [open]);
}

/** `live` while `held` is false. While it is true, `live` as it was when it
 *  became true. */
export function useHeld<T>(live: T, held: boolean): T {
  const kept = useRef(live);
  if (!held) kept.current = live;
  return kept.current;
}
