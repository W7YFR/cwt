/* Facts about this build, rather than about this run.
 *
 * Just the version so far, and it comes straight out of package.json — the one
 * place it lives, moved by `scripts/version.mjs` off the merge commit's branch
 * prefix. Imported rather than injected through vite's `define`, which was the
 * first attempt and behaved differently in different places: the build and the
 * jsdom tier substituted the string correctly, and the real-Chromium tier
 * substituted it already quoted, so the footer read `v"0.1.0"` in exactly the
 * tier that renders the actual page. A plain import has one meaning
 * everywhere, and rollup tree-shakes the rest of package.json away — a test
 * holds that nothing else from the file reaches the bundle.
 */

import { version } from "../../package.json";

/** The app's version, e.g. `0.2.1`. No leading `v` — callers add one if they
 *  want the ham-radio-adjacent habit of writing versions with it. */
export const APP_VERSION: string = version;

/** Whether this is the dev server rather than a build.
 *
 * A function rather than a constant, and read at the call rather than at
 * import: a constant is evaluated once when the module loads, which is before
 * any test can say which of the two it means to be testing. Vite substitutes
 * `import.meta.env.DEV` either way, so the built bundle still folds this to
 * `false` and drops whatever it guards. */
export function isDevBuild(): boolean {
  return import.meta.env.DEV;
}
