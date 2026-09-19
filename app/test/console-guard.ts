/* Console errors fail the test that produced them.
 *
 * React says a great deal through console.error — an update outside act(), a
 * second createRoot on a container that already has one, a missing key — and
 * every one of those is a statement that the test is not exercising what it
 * claims to. Left as output they scroll past in a green log, which is exactly
 * where they sat: the browser tier printed forty-five of them per run and went
 * on reporting 128 passed. A warning that cannot fail anything is a warning
 * nobody reads.
 *
 * Shared by both mounting tiers, so the rule does not depend on which one a
 * test happens to live in.
 */

import { afterEach, beforeEach, expect } from "vitest";

/** Swallowed rather than failed: a substring match against the message.
 *
 * Empty, deliberately. An entry here is a claim that some error is expected
 * and uninteresting, and that claim should have to be written down next to its
 * reason rather than assumed. */
const EXPECTED: readonly RegExp[] = [];

export function failOnConsoleError(): void {
  let seen: string[] = [];
  let original: typeof console.error;

  beforeEach(() => {
    seen = [];
    original = console.error;
    console.error = (...args: unknown[]) => {
      const message = args
        .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
        .join(" ");
      if (!EXPECTED.some((r) => r.test(message))) seen.push(message);
      // Still printed: a failure that only says "there was an error" is worse
      // than the error.
      original(...args);
    };
  });

  afterEach(() => {
    console.error = original;
    const errors = seen;
    seen = [];
    /* One failure listing all of them rather than the first, because these
       arrive in clusters and fixing them a run at a time is slow. */
    expect(errors, `console.error during the test:\n${errors.join("\n---\n")}`).toEqual([]);
  });
}
