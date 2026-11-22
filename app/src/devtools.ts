/* Helpers for debugging, typed into the browser's console as `__cwt.<name>()`.
 * One object, so the console offers each name as you type `__cwt.`, and
 * `__cwt.help()` lists them. None of them shows in the app's own controls.
 */

/** What each helper does, by name, for `__cwt.help()`. */
const docs = new Map<string, string>();

/** The console's object, made on first use. Help is set each time: a hot
 *  update makes this module, and its list, again. */
function cwt(): Record<string, unknown> {
  const w = window as unknown as { __cwt?: Record<string, unknown> };
  w.__cwt ??= {};
  w.__cwt.help = help;
  return w.__cwt;
}

/** Add `fn` to `__cwt` as `name`, with `doc` for its line in help. */
export function addHelper(name: string, doc: string, fn: (...args: never[]) => unknown): void {
  docs.set(name, doc);
  if (typeof window !== "undefined") cwt()[name] = fn;
}

/** Print every helper, a line each. */
function help(): void {
  const lines = [...docs].map(([name, doc]) => `__cwt.${name}: ${doc}`);
  console.info(["__cwt.help(): this list.", ...lines].join("\n"));
}

/* ---- the suggested reply before each of your lines ----------------------- */

/** The tab's switch, so a reload keeps it. */
const REPLIES_KEY = "cwt:suggested-replies";

/** Fired on `window` when the switch changes. */
export const REPLIES_EVENT = "cwt-suggested-replies";

/** Whether the QSO page's log shows the reply suggested before each of
 *  your lines. */
export function suggestedRepliesOn(): boolean {
  try {
    return sessionStorage.getItem(REPLIES_KEY) === "1";
  } catch {
    return false;
  }
}

addHelper(
  "suggestedReplies",
  "suggestedReplies() shows, above each line you sent on the QSO page, the reply suggested before it, " +
    "for this tab. suggestedReplies(false) hides them.",
  (on = true) => {
    try {
      if (on) sessionStorage.setItem(REPLIES_KEY, "1");
      else sessionStorage.removeItem(REPLIES_KEY);
    } catch {
      /* no session storage: nothing changes */
    }
    window.dispatchEvent(new Event(REPLIES_EVENT));
    return on ? "Suggested replies show in the QSO log." : "Suggested replies hidden.";
  },
);

/* ---- the Live page, while it is being tried out ------------------------- */

/** The switch, kept across reloads and tabs until it is turned off. */
const LIVE_KEY = "cwt:live-page";

/** Fired on `window` when the switch changes. */
export const LIVE_EVENT = "cwt-live-page";

/** Whether the page switch offers the Live page. */
export function livePageOn(): boolean {
  try {
    return localStorage.getItem(LIVE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Call `changed` when the switch changes, for `useSyncExternalStore`. */
export function onLivePage(changed: () => void): () => void {
  window.addEventListener(LIVE_EVENT, changed);
  return () => window.removeEventListener(LIVE_EVENT, changed);
}

addHelper(
  "enableLive",
  "enableLive() adds the Live page to the page switch, kept across reloads. enableLive(false) takes it away.",
  (on = true) => {
    try {
      if (on) localStorage.setItem(LIVE_KEY, "1");
      else localStorage.removeItem(LIVE_KEY);
    } catch {
      /* no local storage: nothing changes */
    }
    window.dispatchEvent(new Event(LIVE_EVENT));
    return on ? "The Live page is in the page switch." : "The Live page is gone from the page switch.";
  },
);
