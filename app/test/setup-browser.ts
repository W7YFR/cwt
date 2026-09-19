/* Setup for the real-Chromium tier.
 *
 * Two jobs, and the second one is why this file exists at all.
 *
 * First: React's act() refuses to work unless the environment opts in, and
 * without the flag a mount silently renders nothing — which reads as every
 * assertion failing against an empty page rather than as a setup problem.
 * Three of this tier's files used to set it by hand and four did not, which is
 * exactly the kind of thing that works until the day it doesn't. It belongs to
 * the tier, so it is set for the tier.
 *
 * Second: console errors fail the test that produced them — see
 * console-guard.ts, which both mounting tiers share.
 */

import { beforeEach } from "vitest";
import { failOnConsoleError } from "./console-guard";

declare global {
  /* `var` rather than `let`: a global declaration has to be a var to land on
     globalThis, which is where React reads it from. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

failOnConsoleError();
