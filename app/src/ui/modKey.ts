/* The key that takes a page's keys into a box: Cmd on a Mac, Ctrl
 * elsewhere. */

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Its name, as a key on screen shows it. */
export const MOD = MAC ? "⌘" : "Ctrl";

/** Whether `ev` comes with that key held, and no other. */
export const modOf = (ev: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean =>
  (MAC ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey) && !ev.altKey;
