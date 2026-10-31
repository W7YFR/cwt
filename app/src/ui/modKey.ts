/* The key that takes a page's keys into a box: Cmd on a Mac, Ctrl
 * elsewhere. */

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Its name, as a key on screen shows it. */
export const MOD = MAC ? "⌘" : "Ctrl";

/** Whether `ev` comes with that key held, and no other. */
export const modOf = (ev: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean =>
  (MAC ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey) && !ev.altKey;

/** The key that plays the selected letter or word with L or W: Option on a
 *  Mac, Alt elsewhere. Its name, as a key on screen shows it. */
export const ALT = MAC ? "⌥" : "Alt";

/** Whether `ev` comes with Option or Alt held, and no other modifier. */
export const altOf = (ev: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
