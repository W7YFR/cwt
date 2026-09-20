import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { failOnConsoleError } from "./console-guard";
import { resetMicAccessMemory } from "@/ui/useMicAccess";

/* jsdom setup for the DOM tier.
 *
 * jsdom gives us a document and it gives us layout-shaped APIs that always
 * return zero. Neither of those is a problem for what this tier tests
 * (controls, markup, wiring) as long as the gaps are filled deliberately
 * rather than discovered as a confusing failure three tests later.
 *
 * What jsdom does NOT have — canvas 2D context, Web Audio, media capture —
 * is deliberately left missing here. Those belong to the browser tier, and a
 * mock convincing enough to pass would be a mock convincing enough to lie. */

// matchMedia: used for the dark/light preference. jsdom has no implementation.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// ResizeObserver: the canvas host watches its box. jsdom has no layout, so a
// no-op that never fires is the honest stand-in.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// rAF exists in jsdom but runs on a real timer; make it immediate so a test
// doesn't have to wait a frame to see the effect of a state change.
window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame;

// React 19 + Testing Library: unmount between tests so a component's effects
// cannot outlive the test that mounted them.
afterEach(() => cleanup());

/* The one piece of microphone state that is deliberately not per-screen: a
   granted permission has to outlive the landing page that asked for it. It
   would outlive the test that granted it too, and a screen that starts out
   already-allowed is not the screen most of these tests mean to mount. */
afterEach(() => resetMicAccessMemory());

// And the same rule the browser tier is held to: React's console.error is a
// statement that a test is not testing what it says.
failOnConsoleError();
